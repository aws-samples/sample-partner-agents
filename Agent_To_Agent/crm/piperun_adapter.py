"""PipeRun CRM adapter — plugs the PipeRun MCP client into the CrmAdapter interface.

PipeRun is the first CRM in this app that connects through an MCP server
(see crm/piperun_client.py) rather than direct REST. From the UI's point of
view it behaves exactly like the other CRMs: pick "PipeRun", paste the API
token, and load deals.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from crm.crm_registry import CrmAdapter, CrmSpec, register
from crm.piperun_client import PipeRunMCPClient


@register
class PipeRunAdapter(CrmAdapter):
    spec = CrmSpec(
        id="piperun",
        display_name="PipeRun (via MCP)",
        record_label="Deal",
        load_button_label="Load PipeRun Deals",
        token_label="API Token",
        token_placeholder="Enter your PipeRun API token",
        # PipeRun's MCP derives the account from the token, so no instance URL.
        docs_url="https://github.com/dinhogehm/mcp-piperun",
    )

    def __init__(self, token: str, instance_url: Optional[str] = None):
        super().__init__(token, instance_url)
        self._client = PipeRunMCPClient(bearer_token=token)

    def list_records(self, limit: int = 10) -> List[Dict]:
        deals = self._client.list_deals(limit=limit)
        return [
            {
                "id": d.deal_id,
                "name": d.title,
                "amount": d.value,
                "stage": d.stage,
                "close_date": d.expected_close_date,
            }
            for d in deals
        ]

    def get_record_details(self, record_id: str) -> Dict:
        deal = self._client.get_deal(record_id)
        if not deal:
            raise LookupError(f"Could not fetch PipeRun deal {record_id}")

        props = deal.properties or {}
        return {
            "crm_type": self.spec.id,
            "id": deal.deal_id,
            "name": deal.title,
            "amount": deal.value,
            "stage": deal.stage,
            "close_date": deal.expected_close_date,
            "description": deal.description,
            "account": {
                "name": deal.org_name,
                "industry": props.get("org_industry", ""),
            },
            "contact": {
                "name": deal.contact_name,
                "email": deal.contact_email,
                "first_name": props.get("contact_first_name", ""),
                "last_name": props.get("contact_last_name", ""),
                "phone": props.get("contact_phone", ""),
                "title": props.get("contact_title", ""),
            },
            "address": {
                "street": props.get("org_address", ""),
                "city": props.get("org_city", ""),
                "state": props.get("org_state", ""),
                "postal_code": props.get("org_postal_code", ""),
                "country": props.get("org_country", ""),
            },
        }

    def create_ace_opportunity(
        self, agent, record_id: str, project_title: Optional[str] = None
    ) -> Dict:
        agent.piperun_client = self._client
        result = agent.create_opportunity_from_piperun(record_id, project_title)

        if result.get("success"):
            return {
                "success": True,
                "ace_opportunity_id": result.get("ace_opportunity_id"),
                "record_name": result.get("piperun_deal", {}).get("name", "Unknown"),
                "record_amount": result.get("piperun_deal", {}).get("amount", 0),
                "error": None,
            }
        return {
            "success": False,
            "ace_opportunity_id": None,
            "record_name": "",
            "record_amount": 0,
            "error": result.get("error") or "Unknown error",
        }
