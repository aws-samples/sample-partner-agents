"""Salesforce CRM adapter — plugs SalesforceClient into the CrmAdapter interface."""

from __future__ import annotations

from typing import Dict, List, Optional

from crm.crm_registry import CrmAdapter, CrmSpec, register
from orchestrator_agent import SalesforceClient


@register
class SalesforceAdapter(CrmAdapter):
    spec = CrmSpec(
        id="salesforce",
        display_name="Salesforce",
        record_label="Opportunity",
        load_button_label="Load Salesforce Opportunities",
        token_label="Access Token",
        token_placeholder="Enter your Salesforce access token",
        instance_url_label="Salesforce Instance URL",
        instance_url_placeholder="https://yourcompany.my.salesforce.com",
        docs_url="./docs/SALESFORCE_INTEGRATION.md",
    )

    def __init__(self, token: str, instance_url: Optional[str] = None):
        super().__init__(token, instance_url)
        self._client = SalesforceClient(
            bearer_token=token, instance_url=self.instance_url
        )

    def list_records(self, limit: int = 10) -> List[Dict]:
        opportunities = self._client.list_opportunities(limit=limit)
        if not opportunities:
            # Try a lightweight health check so we can surface auth errors.
            probe = self._client._make_request("GET", "/services/data/v59.0/limits")
            if "error" in probe:
                raise RuntimeError(f"Salesforce API error: {probe.get('error')}")
        return [
            {
                "id": o.opportunity_id,
                "name": o.name,
                "amount": o.amount,
                "stage": o.stage,
                "close_date": o.close_date,
            }
            for o in opportunities
        ]

    def get_record_details(self, record_id: str) -> Dict:
        opp = self._client.get_opportunity(record_id)
        if not opp:
            raise LookupError(f"Could not fetch Salesforce opportunity {record_id}")

        props = opp.properties or {}
        return {
            "crm_type": self.spec.id,
            "id": opp.opportunity_id,
            "name": opp.name,
            "amount": opp.amount,
            "stage": opp.stage,
            "close_date": opp.close_date,
            "description": opp.description,
            "account": {
                "name": opp.account_name,
                "industry": props.get("account_industry", ""),
            },
            "contact": {
                "name": opp.contact_name,
                "email": opp.contact_email,
                "first_name": props.get("contact_first_name", ""),
                "last_name": props.get("contact_last_name", ""),
                "phone": props.get("contact_phone", ""),
                "title": props.get("contact_title", ""),
            },
            "address": {
                "street": props.get("billing_street", ""),
                "city": props.get("billing_city", ""),
                "state": props.get("billing_state", ""),
                "postal_code": props.get("billing_postal_code", ""),
                "country": props.get("billing_country_code", ""),
            },
        }

    def create_ace_opportunity(
        self, agent, record_id: str, project_title: Optional[str] = None
    ) -> Dict:
        # Rebind the agent's SF client to use this adapter's credentials.
        agent.salesforce_client = self._client
        result = agent.create_opportunity_from_salesforce(record_id, project_title)

        if result.get("success"):
            return {
                "success": True,
                "ace_opportunity_id": result.get("ace_opportunity_id"),
                "record_name": result.get("salesforce_opportunity", {}).get(
                    "name", "Unknown"
                ),
                "record_amount": result.get("salesforce_opportunity", {}).get(
                    "amount", 0
                ),
                "error": None,
            }
        return {
            "success": False,
            "ace_opportunity_id": None,
            "record_name": "",
            "record_amount": 0,
            "error": result.get("error") or "Unknown error",
        }
