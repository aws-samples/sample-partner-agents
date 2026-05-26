#!/usr/bin/env python
"""
Agent-to-Agent API Server

Exposes the orchestrator agent as a REST API.
"""

import os
import re
import json
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize agent
agent = OrchestratorAgent()


class GenerateRequest(BaseModel):
    """Request to generate next steps"""
    opportunity_id: str
    prompt: str = "Generate next steps based on the provided context"
    notes: Optional[str] = None  # Paste meeting notes directly here
    slack_channels: Optional[List[str]] = None
    local_folders: Optional[List[str]] = None
    update_opportunity: bool = True
    # The REST API has no terminal to type 'y' at, so default to True.
    # Callers can set this to False if they want a different approval flow
    # (e.g., write the proposed change to a queue for a human to review).
    auto_approve: bool = True

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
    update_opportunity: bool = Form(True),
    auto_approve: bool = Form(True),
    files: List[UploadFile] = File(default=[])
):
    """
    Generate next steps with uploaded files as context.
    
    - **opportunity_id**: Partner Central opportunity ID
    - **prompt**: Custom prompt for AI generation
    - **slack_channels**: Comma-separated list of Slack channels
    - **update_opportunity**: Whether to update the opportunity via MCP
    - **auto_approve**: Auto-approve the MCP write so no terminal prompt
        is needed. Defaults to True for the REST endpoint since callers
        are typically scripts/services. Set to False if you want the
        endpoint to no-op the write step.
    - **files**: Files to upload as context
    """
    try:
        # Save uploaded files to temp directory
        uploaded_paths = []
        temp_dir = tempfile.mkdtemp()
        
        for file in files:
            if file.filename:
                file_path = Path(temp_dir) / file.filename
                content = await file.read()
                file_path.write_bytes(content)
                uploaded_paths.append(str(file_path))
                logger.info(f"Saved uploaded file: {file_path}")
        
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
        
        # Cleanup temp files
        for path in uploaded_paths:
            try:
                os.remove(path)
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
        logger.error(f"Error in generate-with-files endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
    by default (no terminal on the other end of an HTTP call).
    """
    import boto3
    import requests as http_requests
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    try:
        config = agent.mcp_client.config
        mcp_endpoint = config['endpoints']['partnercentral_mcp']

        question = request.question
        if request.opportunity_id:
            question = f"Regarding opportunity {request.opportunity_id}: {question}"

        mcp_payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "text",
                        "text": question
                    }],
                    "catalog": config.get('catalog', 'Sandbox')
                }
            }
        }

        if request.session_id:
            mcp_payload["params"]["arguments"]["sessionId"] = request.session_id

        session = boto3.Session()
        credentials = session.get_credentials()

        aws_request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(mcp_payload),
            headers={'Content-Type': 'application/json'}
        )

        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(aws_request)

        response = http_requests.post(
            aws_request.url,
            data=aws_request.body,
            headers=dict(aws_request.headers),
            timeout=120
        )
        response.raise_for_status()
        result = response.json()

        answer = "No response from the agent."
        new_session_id = request.session_id

        content = result.get('result', {}).get('content', [])
        if content and content[0].get('type') == 'text':
            inner = json.loads(content[0].get('text', '{}'))
            new_session_id = inner.get('sessionId', new_session_id)
            status = inner.get('status', '')

            for item in reversed(inner.get('content', [])):
                item_type = item.get('type', '')
                if item_type == 'ASSISTANT_RESPONSE':
                    item_content = item.get('content', {})
                    if isinstance(item_content, dict) and 'text' in item_content:
                        answer = item_content['text']
                        break
                elif item_type == 'text':
                    answer = item.get('text', answer)
                    break

            if status == 'requires_approval':
                for item in inner.get('content', []):
                    if item.get('type') == 'tool_approval_request':
                        tool_content = item.get('content', {})
                        try:
                            approval_data = json.loads(tool_content.get('text', '{}'))
                            tool_use_id = approval_data.get('tool_use_id')

                            approval_payload = {
                                "jsonrpc": "2.0",
                                "id": 2,
                                "method": "tools/call",
                                "params": {
                                    "name": "sendMessage",
                                    "arguments": {
                                        "content": [{
                                            "type": "tool_approval_response",
                                            "toolUseId": tool_use_id,
                                            "decision": "approve"
                                        }],
                                        "catalog": config.get('catalog', 'Sandbox'),
                                        "sessionId": new_session_id
                                    }
                                }
                            }

                            approval_req = AWSRequest(
                                method='POST',
                                url=mcp_endpoint,
                                data=json.dumps(approval_payload),
                                headers={'Content-Type': 'application/json'}
                            )
                            SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(approval_req)

                            approval_resp = http_requests.post(
                                approval_req.url,
                                data=approval_req.body,
                                headers=dict(approval_req.headers),
                                timeout=120
                            )
                            approval_resp.raise_for_status()
                            approval_result = approval_resp.json()

                            final_content = approval_result.get('result', {}).get('content', [])
                            if final_content and final_content[0].get('type') == 'text':
                                final_inner = json.loads(final_content[0].get('text', '{}'))
                                new_session_id = final_inner.get('sessionId', new_session_id)
                                for fi in reversed(final_inner.get('content', [])):
                                    fi_type = fi.get('type', '')
                                    if fi_type == 'ASSISTANT_RESPONSE':
                                        fi_content = fi.get('content', {})
                                        if isinstance(fi_content, dict) and 'text' in fi_content:
                                            answer = fi_content['text']
                                            break
                                    elif fi_type == 'text':
                                        answer = fi.get('text', answer)
                                        break
                        except Exception as approval_err:
                            logger.warning(f"Error in approval flow: {approval_err}")
                        break

        return AskResponse(
            answer=answer,
            session_id=new_session_id
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
    uvicorn.run(app, host="0.0.0.0", port=8001)
