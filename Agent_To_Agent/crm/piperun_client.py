"""PipeRun CRM client — talks to the PipeRun MCP server over stdio.

This is the FIRST CRM in this app that connects through an MCP server rather
than direct REST (HubSpot/Salesforce/Pipedrive all use `requests`). It spawns
the PipeRun MCP server (https://github.com/dinhogehm/mcp-piperun) as a stdio
subprocess and calls its tools (get_deal, list_deals, list_stages, get_person,
get_company) via the official `mcp` Python SDK, then normalizes the results
into a PipeRunDeal for the shared mapper.

Configuration (env vars, all optional):
    PIPERUN_API_TOKEN   PipeRun API token (also passed explicitly by the UI).
    PIPERUN_MCP_SERVER  Path to the built MCP server entrypoint
                        (…/piperun-mcp-server/build/index.js).
    PIPERUN_MCP_NODE    Path to the node binary (defaults to `which node`).

Each public method opens a short-lived MCP session (one node spawn), runs its
tool calls, and closes it. Sessions run on a dedicated thread with their own
event loop so this is safe to call from Flask's threaded, synchronous request
handlers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import threading
from pathlib import Path
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


def _default_server_path() -> Optional[str]:
    """Locate the built PipeRun MCP server entrypoint."""
    candidates = [
        os.environ.get("PIPERUN_MCP_SERVER"),
        # A sibling checkout next to the repo root: <workspace>/mcp-piperun/...
        # (this file is at <workspace>/<repo>/Agent_To_Agent/crm/, so parents[3]
        # is the workspace root that also contains the mcp-piperun checkout).
        str(
            Path(__file__).resolve().parents[3]
            / "mcp-piperun"
            / "piperun-mcp-server"
            / "build"
            / "index.js"
        ),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def _default_node_path() -> str:
    """Locate the node binary (nvm shell-function aware)."""
    env = os.environ.get("PIPERUN_MCP_NODE")
    if env and os.path.isfile(env):
        return env
    found = shutil.which("node")
    if found:
        return found
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]:
        if os.path.isfile(c):
            return c
    return "node"  # last resort; will surface a clear error if missing


class PipeRunMCPClient:
    """Fetch PipeRun deals through the PipeRun MCP server."""

    def __init__(self, bearer_token: str = None, instance_url: str = None):
        # instance_url is accepted for interface symmetry with other CRM
        # clients but PipeRun's MCP derives the account from the token alone.
        self.bearer_token = bearer_token or os.environ.get("PIPERUN_API_TOKEN")
        self.instance_url = instance_url or ""
        self._node = _default_node_path()
        self._server = _default_server_path()
        # Bound every MCP round-trip so a hung Node process can't block the
        # Flask request thread forever. Override with PIPERUN_MCP_TIMEOUT.
        try:
            self._timeout = int(os.environ.get("PIPERUN_MCP_TIMEOUT", "60") or 60)
        except ValueError:
            self._timeout = 60

        if not self.bearer_token:
            logger.warning("PipeRun API token not configured")

    # --- MCP transport -------------------------------------------------------

    async def _session(self, work: Callable):
        """Open an MCP stdio session and run `work(session)`."""
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        if not self._server:
            raise RuntimeError(
                "PipeRun MCP server not found. Build it "
                "(cd mcp-piperun/piperun-mcp-server && npm install && npm run build) "
                "or set PIPERUN_MCP_SERVER to build/index.js."
            )

        params = StdioServerParameters(
            command=self._node,
            args=[self._server],
            env={**os.environ, "PIPERUN_API_TOKEN": self.bearer_token or ""},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await work(session)

    def _run(self, work: Callable):
        """Run an async MCP session on a dedicated thread (loop-safe).

        The whole session (spawn + initialize + tool calls) is bounded by
        self._timeout via asyncio.wait_for, with a slightly larger thread-join
        backstop so a wedged Node process surfaces as a TimeoutError instead of
        hanging the request thread.
        """
        box: Dict = {}

        def runner():
            try:
                box["value"] = asyncio.run(
                    asyncio.wait_for(self._session(work), timeout=self._timeout)
                )
            except Exception as e:  # re-raised on the calling thread below
                box["error"] = e

        t = threading.Thread(target=runner, daemon=True)
        t.start()
        t.join(self._timeout + 15)
        if t.is_alive():
            raise TimeoutError(
                f"PipeRun MCP call did not complete within {self._timeout}s"
            )
        if "error" in box:
            raise box["error"]
        return box.get("value")

    @staticmethod
    async def _call(session, name: str, args: Dict = None) -> str:
        """Call an MCP tool and return the concatenated text content."""
        res = await session.call_tool(name, args or {})
        parts = []
        for c in (res.content or []):
            text = getattr(c, "text", None)
            if text:
                parts.append(text)
        return "\n".join(parts)

    @staticmethod
    def _json_from(text: str):
        """Parse the first JSON object/array embedded in a tool response.

        PipeRun MCP tools like get_deal return a human-readable summary line
        followed by the full JSON ("... Detalhes completos:\\n{...}"), while
        list_stages/list_pipelines return pure JSON. Both are handled by
        parsing from the first '{' or '[' to the end.
        """
        if not text:
            return None
        # Prefer the first JSON *object* '{'. The formatted summary line that
        # some tools prepend contains a '[<id>]' token, so we must NOT treat a
        # leading '[' as the JSON start (it would parse as a 1-element array
        # and choke on the trailing text). All tools we call return objects.
        idx = text.find("{")
        if idx == -1:
            idx = text.find("[")
        if idx == -1:
            return None
        try:
            # raw_decode parses the first JSON value and ignores any trailing
            # text (some tools append notes after the JSON object).
            obj, _ = json.JSONDecoder().raw_decode(text[idx:])
            return obj
        except (ValueError, TypeError) as e:
            logger.warning(f"Could not parse JSON from PipeRun MCP response: {e}")
            return None

    @staticmethod
    def _parse_amount(raw: str) -> float:
        """Parse a formatted BRL/amount string like 'R$ 50.000' -> 50000.0."""
        if not raw:
            return 0.0
        s = raw.replace("R$", "").strip()
        if not s or "sem valor" in s.lower():
            return 0.0
        # Brazilian format: '.' thousands separator, ',' decimal separator.
        s = s.replace(".", "").replace(",", ".")
        s = re.sub(r"[^\d.]", "", s)
        try:
            return float(s) if s else 0.0
        except ValueError:
            return 0.0

    # --- Public API ----------------------------------------------------------

    def list_deals(self, limit: int = 10) -> List:
        """List recent open deals (parsed from the MCP's formatted summary)."""
        from crm.piperun_mapper import PipeRunDeal

        if not self.bearer_token:
            logger.error("PipeRun API token not configured")
            return []

        async def work(session):
            # No status filter: PipeRun's status enum is account-specific and
            # filtering (e.g. status=1) can exclude deals whose status the API
            # reports as unknown. Fetch the most recent deals and let the user
            # pick.
            return await self._call(
                session, "list_deals", {"show": limit, "page": 1}
            )

        try:
            text = self._run(work)
        except Exception as e:
            logger.error(f"Failed to list PipeRun deals: {e}")
            return []

        deals = []
        # Lines look like:
        # [63027761] Acme Corp - Sync | R$ 50.000 | Aberta | Etapa: N/A | Responsável: X
        line_re = re.compile(r"^\[(\d+)\]\s*(.*?)\s*\|\s*([^|]*?)\s*\|")
        for line in (text or "").splitlines():
            line = line.strip()
            m = line_re.match(line)
            if not m:
                continue
            deal_id, title, amount_part = m.group(1), m.group(2), m.group(3)
            deals.append(
                PipeRunDeal(
                    deal_id=deal_id,
                    title=title or "Untitled Deal",
                    value=self._parse_amount(amount_part),
                    stage="",  # not present in the list summary; see get_deal
                    expected_close_date="",
                    org_name="",
                    contact_name="",
                    contact_email="",
                    description="",
                    properties={},
                )
            )
        # This path scrapes the MCP server's human-readable summary; if the
        # server's output format ever drifts we'd silently return nothing.
        # Surface that instead: '[' present (looks like deal rows) but nothing
        # matched.
        if not deals and "[" in (text or ""):
            logger.warning(
                "PipeRun list_deals returned text but no deals were parsed; "
                "the MCP server's output format may have changed."
            )
        return deals

    def get_deal(self, deal_id: str):
        """Fetch a deal by ID with stage name, person, and company resolved."""
        from crm.piperun_mapper import PipeRunDeal

        if not self.bearer_token:
            logger.error("PipeRun API token not configured")
            return None

        async def work(session):
            deal_text = await self._call(session, "get_deal", {"deal_id": int(deal_id)})
            deal = self._json_from(deal_text)
            if not isinstance(deal, dict) or not deal.get("id"):
                return None

            # Resolve stage_id -> name via list_stages (JSON response).
            stage_name = ""
            stage_id = deal.get("stage_id")
            if stage_id:
                stages_text = await self._call(session, "list_stages", {"show": 200})
                stages = self._json_from(stages_text) or {}
                for st in (stages.get("data") or []):
                    if st.get("id") == stage_id:
                        stage_name = st.get("name", "") or ""
                        break

            # Resolve person (primary contact) when linked.
            person = {}
            if deal.get("person_id"):
                person = self._json_from(
                    await self._call(session, "get_person", {"person_id": int(deal["person_id"])})
                ) or {}

            # Resolve company (account) when linked.
            company = {}
            if deal.get("company_id"):
                company = self._json_from(
                    await self._call(session, "get_company", {"company_id": int(deal["company_id"])})
                ) or {}

            return deal, stage_name, person, company

        try:
            result = self._run(work)
            if not result:
                logger.error(f"PipeRun deal {deal_id} not found or unparseable")
                return None
            deal, stage_name, person, company = result
            # Keep normalization inside the guarded block so a malformed field
            # (e.g. a non-numeric value) returns None like other failures
            # rather than propagating to the caller.
            return self._to_deal(deal, stage_name, person, company)
        except Exception as e:
            logger.error(f"Failed to fetch PipeRun deal {deal_id}: {e}")
            return None

    # --- Normalization -------------------------------------------------------

    def _to_deal(self, deal: Dict, stage_name: str, person: Dict, company: Dict):
        from crm.piperun_mapper import PipeRunDeal

        # Contact fields (PipeRun person shapes vary; pull defensively).
        contact_first = ""
        contact_last = ""
        contact_name = ""
        contact_email = ""
        contact_phone = ""
        contact_title = ""
        if person:
            contact_name = person.get("name", "") or ""
            contact_first = person.get("first_name", "") or ""
            contact_last = person.get("last_name", "") or ""
            contact_title = person.get("job_title", "") or person.get("role", "") or ""
            contact_email = (
                person.get("email")
                or self._first_contact_value(person, ("emails", "contact_emails"))
                or ""
            )
            contact_phone = (
                person.get("phone")
                or person.get("cellphone")
                or self._first_contact_value(person, ("phones", "contact_phones"))
                or ""
            )
        if contact_name and not (contact_first or contact_last):
            parts = contact_name.split(" ", 1)
            contact_first = parts[0]
            contact_last = parts[1] if len(parts) > 1 else ""

        # Company / account fields.
        org_name = ""
        org_props: Dict = {}
        if company:
            org_name = company.get("name", "") or company.get("company_name", "") or ""
            org_props = {
                "org_website": company.get("website", "") or company.get("site", ""),
                "org_industry": company.get("industry", "") or company.get("segment", ""),
                "org_address": company.get("address", "") or company.get("street", ""),
                "org_city": company.get("city", "") or "",
                "org_state": company.get("state", "") or company.get("region", ""),
                "org_postal_code": company.get("zip_code", "")
                or company.get("cep", "")
                or company.get("postal_code", ""),
                "org_country": company.get("country", "") or "",
            }

        # Close date: PipeRun uses probably_closed_at (nullable).
        close_date = deal.get("probably_closed_at") or ""
        if isinstance(close_date, str):
            close_date = close_date[:10]

        return PipeRunDeal(
            deal_id=str(deal.get("id", "")),
            title=deal.get("title", "Untitled Deal") or "Untitled Deal",
            value=float(deal.get("value") or 0),
            stage=stage_name,
            expected_close_date=close_date,
            org_name=org_name,
            contact_name=contact_name,
            contact_email=contact_email,
            description=deal.get("description") or deal.get("observation") or "",
            properties={
                **org_props,
                "currency": deal.get("currency", "") or "",
                "contact_first_name": contact_first,
                "contact_last_name": contact_last,
                "contact_phone": contact_phone,
                "contact_title": contact_title,
                "pipeline_id": deal.get("pipeline_id"),
                "stage_id": deal.get("stage_id"),
            },
        )

    @staticmethod
    def _first_contact_value(person: Dict, keys) -> str:
        """Pull the first email/phone value from a PipeRun contact array."""
        for key in keys:
            arr = person.get(key)
            if isinstance(arr, list) and arr:
                first = arr[0]
                if isinstance(first, dict):
                    return first.get("value") or first.get("email") or first.get("phone") or ""
                if isinstance(first, str):
                    return first
        return ""
