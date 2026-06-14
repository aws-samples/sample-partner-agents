"""HubSpot CRM REST client (fetches deals as HubSpotDeal objects)."""

import os
import logging
from typing import Dict, List, Optional
from crm.hubspot_mapper import HubSpotDeal

logger = logging.getLogger(__name__)


class HubSpotClient:
    """Client for HubSpot CRM API to fetch deals"""
    
    BASE_URL = "https://api.hubapi.com"
    
    def __init__(self, bearer_token: str = None):
        self.bearer_token = bearer_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not self.bearer_token:
            logger.warning("HubSpot bearer token not configured")
    
    def _make_request(self, method: str, endpoint: str, data: Dict = None, params: Dict = None) -> Dict:
        """Make authenticated request to HubSpot API"""
        import requests
        
        if not self.bearer_token:
            return {"error": "HubSpot bearer token not configured"}
        
        url = f"{self.BASE_URL}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json"
        }
        
        try:
            if method == "GET":
                response = requests.get(url, headers=headers, params=params, timeout=30)
            elif method == "POST":
                response = requests.post(url, headers=headers, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            logger.error(f"HubSpot API error: {e}")
            return {"error": str(e), "status_code": e.response.status_code if e.response else None}
        except Exception as e:
            logger.error(f"HubSpot request error: {e}")
            return {"error": str(e)}
    
    def get_contact(self, contact_id: str) -> Dict:
        """Get contact details from HubSpot"""
        endpoint = f"/crm/v3/objects/contacts/{contact_id}"
        return self._make_request("GET", endpoint)
    
    def _get_stage_label(self, stage_id: str) -> str:
        """Resolve a HubSpot deal stage ID to its human-readable label.
        
        HubSpot returns stage as a numeric ID (e.g., '1575643857'). This method
        fetches all pipelines and their stages to find the matching label.
        Results are cached after the first call.
        """
        if not hasattr(self, '_stage_cache'):
            self._stage_cache = {}
            try:
                result = self._make_request("GET", "/crm/v3/pipelines/deals")
                if "error" not in result:
                    for pipeline in result.get("results", []):
                        pipeline_label = pipeline.get("label", "")
                        for stage in pipeline.get("stages", []):
                            sid = stage.get("id", "")
                            slabel = stage.get("label", sid)
                            self._stage_cache[sid] = f"{slabel} ({pipeline_label})"
            except Exception as e:
                logger.warning(f"Could not fetch HubSpot pipelines for stage resolution: {e}")
        
        return self._stage_cache.get(stage_id, stage_id)
    
    def get_deal(self, deal_id: str) -> Optional[HubSpotDeal]:
        """Fetch a deal by ID with associated contacts (matching hubspot-partner-central-integration logic)"""
        # Get deal with associations
        endpoint = f"/crm/v3/objects/deals/{deal_id}"
        params = {
            'archived': 'false',
            'associations': 'contacts',
            'properties': 'dealname,amount,dealstage,closedate,description,website,industry,hs_next_step,partner_central_opportunity_id,partner_central_sync_status,ace_stage,ace_validation_status'
        }
        
        result = self._make_request("GET", endpoint, params=params)
        
        if "error" in result:
            logger.error(f"Failed to fetch deal {deal_id}: {result['error']}")
            return None
        
        properties = result.get("properties", {})
        associations = result.get("associations", {})
        
        # Fetch all associated contact details (same as hubspot-partner-central-integration)
        contact_associations = associations.get("contacts", {}).get("results", [])
        all_contacts = []
        
        for contact_assoc in contact_associations:
            contact_id = contact_assoc.get("id")
            try:
                contact_data = self.get_contact(contact_id)
                if "error" not in contact_data:
                    all_contacts.append(contact_data)
            except Exception as e:
                logger.warning(f"Failed to fetch contact {contact_id}: {e}")
        
        # Extract primary contact info
        contact_name = "Unknown Contact"
        contact_email = ""
        contact_phone = ""
        contact_title = ""
        contact_first_name = "Unknown"
        contact_last_name = "Contact"
        
        if all_contacts:
            primary_contact = all_contacts[0]
            contact_props = primary_contact.get("properties", {})
            contact_first_name = contact_props.get("firstname", "Unknown")
            contact_last_name = contact_props.get("lastname", "Contact")
            contact_name = f"{contact_first_name} {contact_last_name}".strip()
            contact_email = contact_props.get("email", "")
            contact_phone = contact_props.get("phone", "")
            contact_title = contact_props.get("jobtitle", "")
        
        return HubSpotDeal(
            deal_id=deal_id,
            deal_name=properties.get("dealname", "Untitled Deal"),
            amount=float(properties.get("amount", 0) or 0),
            stage=self._get_stage_label(properties.get("dealstage", "unknown")),
            close_date=properties.get("closedate", ""),
            company_name="",  # Will be set from contact's company or deal name
            contact_name=contact_name,
            contact_email=contact_email,
            description=properties.get("description", ""),
            properties={
                **properties,
                "all_contacts": all_contacts,
                "contact_first_name": contact_first_name,
                "contact_last_name": contact_last_name,
                "contact_phone": contact_phone,
                "contact_title": contact_title
            }
        )
    
    def list_deals(self, limit: int = 10) -> List[HubSpotDeal]:
        """List recent deals"""
        endpoint = f"/crm/v3/objects/deals?limit={limit}&properties=dealname,amount,dealstage,closedate,hs_next_step,partner_central_opportunity_id,partner_central_sync_status,ace_stage,ace_validation_status"
        result = self._make_request("GET", endpoint)
        
        if "error" in result:
            logger.error(f"Failed to list deals: {result['error']}")
            return []
        
        deals = []
        for deal_data in result.get("results", []):
            props = deal_data.get("properties", {})
            deals.append(HubSpotDeal(
                deal_id=deal_data.get("id", ""),
                deal_name=props.get("dealname", "Untitled"),
                amount=float(props.get("amount", 0) or 0),
                stage=self._get_stage_label(props.get("dealstage", "unknown")),
                close_date=props.get("closedate", ""),
                company_name="",  # Not fetched in list
                contact_name="",
                contact_email="",
                description="",
                properties=props
            ))
        
        return deals
