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
            elif method == "PUT":
                response = requests.put(url, headers=headers, json=data, timeout=30)
            elif method == "PATCH":
                response = requests.patch(url, headers=headers, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            
            response.raise_for_status()
            # Some endpoints (associations) return 204 No Content.
            if response.status_code == 204 or not response.content:
                return {"success": True}
            return response.json()
        except requests.exceptions.HTTPError as e:
            body = ""
            try:
                body = e.response.text[:300] if e.response is not None else ""
            except Exception:
                pass
            logger.error(f"HubSpot API error: {e} {body}")
            return {"error": str(e), "details": body,
                    "status_code": e.response.status_code if e.response is not None else None}
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
    
    def validate_token(self) -> Dict:
        """Cheap check that the token is valid and has deal read access.
        Returns {"valid": bool, "status_code": int|None, "error": str|None}."""
        resp = self._make_request("GET", "/crm/v3/objects/deals?limit=1")
        if "error" not in resp:
            return {"valid": True, "status_code": 200, "error": None}
        return {"valid": False, "status_code": resp.get("status_code"),
                "error": resp.get("error")}

    def list_deals(self, limit: int = 10) -> List[HubSpotDeal]:
        """List recent deals, newest first (sorted by createdate DESC).

        Uses the Search API so the most recently created deals appear at the
        top — important for the demo, where the user creates a deal and wants
        to immediately see it in the list.
        """
        properties = [
            "dealname", "amount", "dealstage", "closedate", "createdate",
            "hs_next_step", "partner_central_opportunity_id",
            "partner_central_sync_status", "ace_stage", "ace_validation_status",
        ]
        body = {
            "limit": min(limit, 100),
            "sorts": [{"propertyName": "createdate", "direction": "DESCENDING"}],
            "properties": properties,
        }
        result = self._make_request("POST", "/crm/v3/objects/deals/search", body)

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

    # ------------------------------------------------------------------
    # Write operations (used by the "Process Call" demo flow).
    # Require a token with crm.objects.deals.write + crm.objects.contacts.write.
    # ------------------------------------------------------------------
    def _default_pipeline_stage(self):
        """Return (pipeline_id, stage_id) for the first deal pipeline/stage.

        HubSpot can auto-assign these, but some portals reject a deal that
        omits them. Returning explicit defaults keeps deal creation portable
        across portals. Returns (None, None) if pipelines can't be fetched.
        """
        try:
            result = self._make_request("GET", "/crm/v3/pipelines/deals")
            pipelines = result.get("results", []) if "error" not in result else []
            if pipelines:
                pipeline = pipelines[0]
                stages = pipeline.get("stages", [])
                # Sort by displayOrder so we pick the earliest stage.
                stages = sorted(stages, key=lambda s: s.get("displayOrder", 0))
                stage_id = stages[0].get("id") if stages else None
                return pipeline.get("id"), stage_id
        except Exception as e:
            logger.warning(f"Could not resolve default pipeline/stage: {e}")
        return None, None

    def create_contact(self, properties: Dict) -> Dict:
        """Create a contact. `properties` uses HubSpot contact keys
        (firstname, lastname, email, phone, jobtitle). Returns the API response
        (contains 'id' on success, or 'error'). If the contact already exists
        (409), the existing contact ID is parsed and returned so the caller can
        still associate it to the deal."""
        import re
        clean = {k: v for k, v in (properties or {}).items() if v not in (None, "")}
        resp = self._make_request("POST", "/crm/v3/objects/contacts", {"properties": clean})
        if resp.get("status_code") == 409:
            match = re.search(r"Existing ID:\s*(\d+)", resp.get("details", "") or "")
            if match:
                logger.info(f"Contact already exists; reusing ID {match.group(1)}")
                return {"id": match.group(1), "reused": True}
        return resp

    def associate_contact_to_deal(self, deal_id: str, contact_id: str) -> Dict:
        """Associate a contact to a deal using the default association type."""
        endpoint = f"/crm/v4/objects/deals/{deal_id}/associations/default/contacts/{contact_id}"
        return self._make_request("PUT", endpoint)

    def create_deal(self, properties: Dict) -> Dict:
        """Create a deal. `properties` uses HubSpot deal keys
        (dealname, amount, closedate, description, ...). Pipeline/stage are
        filled with portal defaults if not provided. Returns the API response
        (contains 'id' on success, or 'error')."""
        props = {k: v for k, v in (properties or {}).items() if v not in (None, "")}
        if "pipeline" not in props or "dealstage" not in props:
            pipeline_id, stage_id = self._default_pipeline_stage()
            if pipeline_id and "pipeline" not in props:
                props["pipeline"] = pipeline_id
            if stage_id and "dealstage" not in props:
                props["dealstage"] = stage_id
        return self._make_request("POST", "/crm/v3/objects/deals", {"properties": props})

    def _account_info(self) -> Dict:
        """Fetch and cache HubSpot account details (portalId, uiDomain) used to
        build correct, region-aware record URLs."""
        if not hasattr(self, "_acct_cache"):
            info = self._make_request("GET", "/account-info/v3/details")
            self._acct_cache = info if isinstance(info, dict) and "error" not in info else {}
        return self._acct_cache

    def deal_url(self, deal_id: str) -> str:
        """Build a clickable HubSpot deal record URL for the connected portal.

        Correct format: https://{uiDomain}/contacts/{portalId}/record/0-3/{dealId}/
        (0-3 is HubSpot's object-type id for deals). Falls back to a generic URL
        if account info can't be fetched."""
        info = self._account_info()
        ui_domain = info.get("uiDomain")
        portal_id = info.get("portalId")
        if ui_domain and portal_id:
            return f"https://{ui_domain}/contacts/{portal_id}/record/0-3/{deal_id}/"
        return f"https://app.hubspot.com/contacts/deals/{deal_id}"

    def create_deal_with_contact(self, deal_properties: Dict, contact_properties: Dict = None) -> Dict:
        """Create a deal and (optionally) a contact, then associate them.

        Returns: {success, deal_id, contact_id, error, deal_url}.
        """
        deal_resp = self.create_deal(deal_properties)
        if "error" in deal_resp or not deal_resp.get("id"):
            return {"success": False, "deal_id": None, "contact_id": None,
                    "error": deal_resp.get("error") or deal_resp.get("details") or "Deal creation failed"}
        deal_id = deal_resp["id"]

        contact_id = None
        if contact_properties:
            contact_resp = self.create_contact(contact_properties)
            if "error" not in contact_resp and contact_resp.get("id"):
                contact_id = contact_resp["id"]
                self.associate_contact_to_deal(deal_id, contact_id)
            else:
                # Non-fatal: the deal exists; log and continue without a contact.
                logger.warning(f"Contact creation/association failed: "
                               f"{contact_resp.get('error') or contact_resp.get('details')}")

        return {
            "success": True,
            "deal_id": deal_id,
            "contact_id": contact_id,
            "error": None,
            "deal_url": self.deal_url(deal_id),
        }
