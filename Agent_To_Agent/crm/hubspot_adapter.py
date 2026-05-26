"""HubSpot CRM adapter — plugs HubSpotClient into the CrmAdapter interface."""

from __future__ import annotations

from typing import Dict, List, Optional

from crm.crm_registry import CrmAdapter, CrmSpec, register
from orchestrator_agent import HubSpotClient


@register
class HubSpotAdapter(CrmAdapter):
    spec = CrmSpec(
        id="hubspot",
        display_name="HubSpot",
        record_label="Deal",
        load_button_label="Load HubSpot Deals",
        token_label="Bearer Token",
        token_placeholder="Enter your HubSpot bearer token",
        # HubSpot has a fixed global endpoint (api.hubapi.com) — no instance URL.
        instance_url_label=None,
        instance_url_placeholder=None,
    )

    def __init__(self, token: str, instance_url: Optional[str] = None):
        super().__init__(token, instance_url)
        self._client = HubSpotClient(bearer_token=token)

    def list_records(self, limit: int = 10) -> List[Dict]:
        deals = self._client.list_deals(limit=limit)
        return [
            {
                "id": d.deal_id,
                "name": d.deal_name,
                "amount": d.amount,
                "stage": d.stage,
                "close_date": d.close_date,
                "next_step": (d.properties or {}).get("hs_next_step", ""),
            }
            for d in deals
        ]

    def get_record_details(self, record_id: str) -> Dict:
        deal = self._client.get_deal(record_id)
        if not deal:
            raise LookupError(f"Could not fetch HubSpot deal {record_id}")

        props = deal.properties or {}
        return {
            "crm_type": self.spec.id,
            "id": deal.deal_id,
            "name": deal.deal_name,
            "amount": deal.amount,
            "stage": deal.stage,
            "close_date": deal.close_date,
            "description": deal.description,
            "contact": {
                "name": deal.contact_name,
                "email": deal.contact_email,
                "first_name": props.get("contact_first_name", ""),
                "last_name": props.get("contact_last_name", ""),
                "phone": props.get("contact_phone", ""),
                "title": props.get("contact_title", ""),
            },
            "partner_central": {
                "opportunity_id": props.get("partner_central_opportunity_id", ""),
                "sync_status": props.get("partner_central_sync_status", ""),
                "ace_stage": props.get("ace_stage", ""),
                "ace_validation_status": props.get("ace_validation_status", ""),
                "next_step": props.get("hs_next_step", ""),
            },
            "raw_properties": {
                k: v for k, v in props.items() if k != "all_contacts"
            },
        }

    def create_ace_opportunity(
        self, agent, record_id: str, project_title: Optional[str] = None
    ) -> Dict:
        # Reuse OrchestratorAgent's existing end-to-end method, which already
        # handles fetch + map + create + error handling.
        agent.hubspot_client = self._client  # ensure same token is used
        result = agent.create_opportunity_from_hubspot(record_id, project_title)

        if result.get("success"):
            return {
                "success": True,
                "ace_opportunity_id": result.get("ace_opportunity_id"),
                "record_name": result.get("hubspot_deal", {}).get("name", "Unknown"),
                "record_amount": result.get("hubspot_deal", {}).get("amount", 0),
                "error": None,
            }
        return {
            "success": False,
            "ace_opportunity_id": None,
            "record_name": "",
            "record_amount": 0,
            "error": result.get("error") or "Unknown error",
        }
