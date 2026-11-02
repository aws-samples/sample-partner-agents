#!/usr/bin/env python
"""
Agent-to-Agent API Server

Exposes the orchestrator agent as a REST API.

SECURITY / DEMO SCOPE
---------------------
This is a sample intended for local demos. It has no authentication on any
route. Before porting any of this into a production workload, harden at least:
  * Authentication / authorization on every endpoint (there is none today).
  * Network exposure: binds to 127.0.0.1 by default (see __main__). Do not
    expose on 0.0.0.0 without authentication in front of it.
  * CORS: restricted to local origins by default (see ALLOWED_ORIGINS below).
  * Uploaded filenames: sanitized to a basename to prevent path traversal
    (see _store_upload). Prefer a server-generated name in production.
  * Write defaults: update_opportunity and auto_approve both default to False,
    so out of the box the API generates next steps but does NOT write to
    Partner Central. A caller must opt in with update_opportunity=true to
    write, plus auto_approve=true to apply the write without an interactive
    approval (the REST API has no terminal to prompt at). See the README
    "Security and hardening" section for the recommended human-in-the-loop
    approach.
"""

import os
import re
import json
import shutil
import logging
import tempfile
from typing import List, Optional
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

from orchestrator_agent import OrchestratorAgent, AgentResult

_OPPORTUNITY_ID_RE = re.compile(r'^O\d{5,}$')

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Agent-to-Agent API",
    description="Orchestrator agent that generates next steps from multiple sources and updates Partner Central",
    version="1.0.0"
)

# CORS: default to the local demo origins only. A wildcard ("*") combined with
# an unauthenticated API lets any website drive these endpoints from a visitor's
# browser. Override with ALLOWED_ORIGINS (comma-separated) if you front this with
# a known origin, and add authentication before any non-local use.
_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:8001,http://127.0.0.1:8001,"
        "http://localhost:8002,http://127.0.0.1:8002",
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize agent
agent = OrchestratorAgent()


def _store_upload(temp_root: Path, filename: str, content: bytes) -> Path:
    """
    Persist an uploaded file inside temp_root, defusing path traversal.

    The client-supplied multipart filename is reduced to its basename so that
    absolute paths and '../' segments cannot escape temp_root (CWE-22). The
    resolved destination is then re-checked to stay within temp_root as defense
    in depth. Invalid names (empty, '.', '..') are rejected with HTTP 400.

    DEMO NOTE: this keeps the caller's sanitized filename for readability. For a
    production workload, prefer a name the server generates so the stored path
    never depends on client input at all, e.g.:

        import uuid
        allowed = {".txt", ".md", ".pdf", ".json", ".csv"}
        suffix = Path(filename).suffix.lower()
        if suffix not in allowed:
            raise HTTPException(status_code=400, detail="Unsupported file type")
        safe_name = f"{uuid.uuid4().hex}{suffix}"
    """
    safe_name = Path(filename).name  # strip any directory components
    if not safe_name or safe_name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid filename")
    dest = (temp_root / safe_name).resolve()
    if temp_root not in dest.parents:  # must remain inside temp_root
        raise HTTPException(status_code=400, detail="Invalid filename")
    dest.write_bytes(content)
    return dest


class GenerateRequest(BaseModel):
    """Request to generate next steps"""
    opportunity_id: str
    prompt: str = "Generate next steps based on the provided context"
    notes: Optional[str] = None  # Paste meeting notes directly here
    slack_channels: Optional[List[str]] = None
    local_folders: Optional[List[str]] = None
    update_opportunity: bool = False
    # Both default to False so the demo never writes to Partner Central unless
    # the caller explicitly opts in. The REST API has no terminal to type 'y'
    # at, so when update_opportunity=true the write only applies if
    # auto_approve=true as well; with auto_approve=false the MCP approval is
    # auto-rejected and NextSteps is left unchanged. For a real human-in-the-
    # loop step, use the deferred-approval flow (see README).
    auto_approve: bool = False

    @field_validator('opportunity_id')
    @classmethod
    def validate_opportunity_id(cls, v: str) -> str:
        if not _OPPORTUNITY_ID_RE.match(v):
            raise ValueError(
                f"Invalid opportunity_id format: '{v}'. "
                "Expected format: O followed by digits (e.g., O15081741)."
            )
        return v


class GenerateResponse(BaseModel):
    """Response from generate endpoint"""
    success: bool
    next_steps: str
    source_count: int
    mcp_response: Optional[dict] = None
    error: Optional[str] = None


@app.get("/")
async def root():
    """Health check"""
    return {
        "service": "Agent-to-Agent API",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy"}


@app.post("/api/generate", response_model=GenerateResponse)
async def generate_next_steps(request: GenerateRequest):
    """
    Generate next steps from context sources and optionally update opportunity.
    
    - **opportunity_id**: Partner Central opportunity ID (e.g., O15081741)
    - **prompt**: Custom prompt for AI generation
    - **notes**: Paste meeting notes / context directly (alternative to file upload)
    - **slack_channels**: List of Slack channels to read
    - **local_folders**: List of local folders to scan
    - **update_opportunity**: Whether to update the opportunity via MCP
        (default False; set true to opt in to the write)
    - **auto_approve**: Apply the write without an interactive approval
        (default False; requires update_opportunity=true). With auto_approve
        false a requested write is auto-rejected, leaving NextSteps unchanged.
    """
    try:
        # If notes are provided inline, write them to a temp file so the
        # orchestrator can consume them as an uploaded file context source.
        uploaded_files = []
        temp_file = None
        if request.notes:
            temp_file = tempfile.NamedTemporaryFile(
                mode='w', suffix='.txt', delete=False, prefix='notes_'
            )
            temp_file.write(request.notes)
            temp_file.close()
            uploaded_files.append(temp_file.name)

        result = agent.run(
            opportunity_id=request.opportunity_id,
            prompt=request.prompt,
            slack_channels=request.slack_channels,
            local_folders=request.local_folders,
            uploaded_files=uploaded_files or None,
            update_opportunity=request.update_opportunity,
            auto_approve=request.auto_approve,
        )

        # Clean up temp file
        if temp_file:
            try:
                os.remove(temp_file.name)
            except OSError:
                pass
        
        return GenerateResponse(
            success=result.success,
            next_steps=result.next_steps,
            source_count=len(result.context_sources),
            mcp_response=result.mcp_response,
            error=result.error
        )
        
    except Exception as e:
        logger.error(f"Error in generate endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/generate-with-files", response_model=GenerateResponse)
async def generate_with_files(
    opportunity_id: str = Form(...),
    prompt: str = Form("Generate next steps based on the provided context"),
    slack_channels: Optional[str] = Form(None),
    update_opportunity: bool = Form(False),
    auto_approve: bool = Form(False),
    files: List[UploadFile] = File(default=[])
):
    """
    Generate next steps with uploaded files as context.
    
    - **opportunity_id**: Partner Central opportunity ID
    - **prompt**: Custom prompt for AI generation
    - **slack_channels**: Comma-separated list of Slack channels
    - **update_opportunity**: Whether to update the opportunity via MCP.
        Defaults to False, so the endpoint generates next steps without
        writing. Set to true to opt in to the write.
    - **auto_approve**: Apply the MCP write without an interactive approval.
        Defaults to False. The REST API has no terminal to prompt at, so with
        auto_approve=false a requested write is auto-rejected and NextSteps is
        left unchanged; set auto_approve=true (with update_opportunity=true) to
        have the demo write automatically.
    - **files**: Files to upload as context

    Uploaded filenames are sanitized (see _store_upload) so a client cannot
    use path traversal to write outside the per-request temp directory.
    """
    temp_dir = tempfile.mkdtemp()
    temp_root = Path(temp_dir).resolve()
    try:
        # Save uploaded files under sanitized names inside temp_root.
        uploaded_paths = []
        for file in files:
            if not file.filename:
                continue
            dest = _store_upload(temp_root, file.filename, await file.read())
            uploaded_paths.append(str(dest))
            logger.info(f"Saved uploaded file: {dest}")

        # Parse slack channels
        channels = None
        if slack_channels:
            channels = [c.strip() for c in slack_channels.split(',')]

        # Run agent
        result = agent.run(
            opportunity_id=opportunity_id,
            prompt=prompt,
            slack_channels=channels,
            uploaded_files=uploaded_paths,
            update_opportunity=update_opportunity,
            auto_approve=auto_approve,
        )

        return GenerateResponse(
            success=result.success,
            next_steps=result.next_steps,
            source_count=len(result.context_sources),
            mcp_response=result.mcp_response,
            error=result.error
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in generate-with-files endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Remove the whole temp directory, never caller-derived paths.
        shutil.rmtree(temp_dir, ignore_errors=True)


class AskRequest(BaseModel):
    """Request to ask the Partner Central Agent a question"""
    question: str
    opportunity_id: Optional[str] = None
    session_id: Optional[str] = None

    @field_validator('opportunity_id')
    @classmethod
    def validate_opportunity_id(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _OPPORTUNITY_ID_RE.match(v):
            raise ValueError(
                f"Invalid opportunity_id format: '{v}'. "
                "Expected format: O followed by digits (e.g., O15081741)."
            )
        return v


class AskResponse(BaseModel):
    """Response from the Partner Central Agent"""
    answer: str
    session_id: Optional[str] = None
    error: Optional[str] = None


@app.post("/api/ask", response_model=AskResponse)
async def ask_agent(request: AskRequest):
    """
    Ask the Partner Central Agent a question via MCP.

    - **question**: Natural-language question for the agent
    - **opportunity_id**: Optional opportunity ID for context
    - **session_id**: Optional session ID to continue a conversation

    Read operations are auto-approved. Write operations are auto-approved
    by default (no terminal on the other end of an HTTP call). The JSON-RPC
    framing, SigV4 signing, and approval handshake all live in
    PartnerCentralMCPClient.send_message().
    """
    try:
        question = request.question
        if request.opportunity_id:
            question = f"Regarding opportunity {request.opportunity_id}: {question}"

        outcome = agent.mcp_client.send_message(
            question,
            session_id=request.session_id,
            decision="approve",
        )

        return AskResponse(
            answer=outcome.get("answer", "No response from the agent."),
            session_id=outcome.get("session_id", request.session_id),
        )

    except Exception as e:
        logger.error(f"Error in ask endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/opportunity/{opportunity_id}")
async def get_opportunity(opportunity_id: str):
    """Fetch opportunity data from Partner Central"""
    if not _OPPORTUNITY_ID_RE.match(opportunity_id):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid opportunity_id format: '{opportunity_id}'. Expected: O followed by digits (e.g., O15081741)."
        )
    try:
        data = agent.mcp_client.get_opportunity(opportunity_id)
        if not data:
            raise HTTPException(status_code=404, detail=f"Opportunity {opportunity_id} not found")

        return {
            "opportunity_id": opportunity_id,
            "customer": data.get('Customer', {}).get('Account', {}).get('CompanyName'),
            "stage": data.get('LifeCycle', {}).get('Stage'),
            "next_steps": data.get('LifeCycle', {}).get('NextSteps'),
            "data": data
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching opportunity: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    # Bind to loopback by default to match the README (http://localhost:8001)
    # and keep this unauthenticated demo off the network. Override with
    # HOST=0.0.0.0 only behind authentication or on an isolated network.
    host = os.getenv("HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=8001)
