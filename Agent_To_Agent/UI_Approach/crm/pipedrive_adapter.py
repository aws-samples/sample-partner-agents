"""Pipedrive CRM adapter — plugs PipedriveClient into the CrmAdapter interface."""

from __future__ import annotations

from typing import Dict, List, Optional

from crm.crm_registry import CrmAdapter, CrmSpec, register
from orchestrator_agent import PipedriveClient


@register
class PipedriveAdapter(CrmAdapter):
    spec = CrmSpec(
        id="pipedrive",
        display_name="Pipedrive",
        record_label="Deal",
        load_button_label="Load Pipedrive Deals",
        token_label="API Token",
        token_placeholder="Enter your Pipedrive API token",
        instance_url_label="Pipedrive Company URL",
        instance_url_placeholder="https://yourcompany.pipedrive.com",
        docs_url="./docs/PIPEDRIVE_INTEGRATION.md",
    )

    def __init__(self, token: str, instance_url: Optional[str] = None):
        super().__init__(token, instance_url)
        self._client = PipedriveClient(
            bearer_token=token, instance_url=self.instance_url
        )

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
            raise LookupError(f"Could not fetch Pipedrive deal {record_id}")

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
        agent.pipedrive_client = self._client
        result = agent.create_opportunity_from_pipedrive(record_id, project_title)

        if result.get("success"):
            return {
                "success": True,
                "ace_opportunity_id": result.get("ace_opportunity_id"),
                "record_name": result.get("pipedrive_deal", {}).get("name", "Unknown"),
                "record_amount": result.get("pipedrive_deal", {}).get("amount", 0),
                "error": None,
            }
        return {
            "success": False,
            "ace_opportunity_id": None,
            "record_name": "",
            "record_amount": 0,
            "error": result.get("error") or "Unknown error",
        }
