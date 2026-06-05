#!/usr/bin/env python
"""
Orchestrator Agent - Agent-to-Agent Communication

This agent:
1. Reads context from multiple sources (Slack, local files, uploads, HubSpot)
2. Uses Claude AI to generate "next steps" content
3. Calls Partner Central MCP to update opportunities
4. Creates ACE opportunities from HubSpot deals via Partner Central Selling API
"""

import os
import re
import sys
import json
import logging
import argparse
from typing import Dict, List, Optional
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, timedelta

# Import HubSpotDeal from mapper for type hints
from crm.hubspot_mapper import HubSpotDeal
from crm.salesforce_mapper import SalesforceOpportunity


# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


@dataclass
class ContextSource:
    """Represents a source of context data"""
    source_type: str  # 'slack', 'file', 'upload'
    source_name: str
    content: str
    metadata: Dict = field(default_factory=dict)


@dataclass
class AgentResult:
    """Result from the orchestrator agent"""
    success: bool
    next_steps: str
    context_sources: List[ContextSource]
    mcp_response: Optional[Dict] = None
    error: Optional[str] = None


class SlackReader:
    """Read messages from Slack channels"""
    
    def __init__(self, token: str = None):
        self.token = token or os.environ.get('SLACK_BOT_TOKEN')
        self._client = None
    
    @property
    def client(self):
        if self._client is None and self.token:
            try:
                from slack_sdk import WebClient
                self._client = WebClient(token=self.token)
            except ImportError:
                logger.warning("slack_sdk not installed. Run: pip install slack_sdk")
        return self._client
    
    def read_channel(self, channel: str, limit: int = 50) -> ContextSource:
        """Read recent messages from a Slack channel"""
        if not self.client:
            logger.warning(f"Slack client not available, skipping channel: {channel}")
            return ContextSource(
                source_type='slack',
                source_name=channel,
                content=f"[Slack integration not configured for channel: {channel}]",
                metadata={'error': 'No Slack token'}
            )
        
        try:
            # Get channel ID if name provided
            channel_id = channel
            if not channel.startswith('C'):
                channels = self.client.conversations_list()
                for ch in channels['channels']:
                    if ch['name'] == channel:
                        channel_id = ch['id']
                        break
            
            # Fetch messages
            result = self.client.conversations_history(
                channel=channel_id,
                limit=limit
            )
            
            messages = []
            for msg in result.get('messages', []):
                text = msg.get('text', '')
                user = msg.get('user', 'unknown')
                ts = msg.get('ts', '')
                messages.append(f"[{user}]: {text}")
            
            content = "\n".join(messages)
            
            return ContextSource(
                source_type='slack',
                source_name=channel,
                content=content,
                metadata={'message_count': len(messages), 'channel_id': channel_id}
            )
            
        except Exception as e:
            logger.error(f"Error reading Slack channel {channel}: {e}")
            return ContextSource(
                source_type='slack',
                source_name=channel,
                content=f"[Error reading channel: {e}]",
                metadata={'error': str(e)}
            )


class FileReader:
    """Read files from local directories"""
    
    SUPPORTED_EXTENSIONS = {'.txt', '.md', '.json', '.csv', '.log', '.py', '.yaml', '.yml'}
    
    def read_folder(self, folder_path: str, recursive: bool = True) -> List[ContextSource]:
        """Read all supported files from a folder"""
        sources = []
        folder = Path(folder_path)
        
        if not folder.exists():
            logger.warning(f"Folder does not exist: {folder_path}")
            return sources
        
        pattern = '**/*' if recursive else '*'
        
        for file_path in folder.glob(pattern):
            if file_path.is_file() and file_path.suffix.lower() in self.SUPPORTED_EXTENSIONS:
                try:
                    content = file_path.read_text(encoding='utf-8', errors='ignore')
                    sources.append(ContextSource(
                        source_type='file',
                        source_name=str(file_path),
                        content=content[:10000],  # Limit content size
                        metadata={
                            'file_size': file_path.stat().st_size,
                            'extension': file_path.suffix
                        }
                    ))
                    logger.info(f"Read file: {file_path}")
                except Exception as e:
                    logger.error(f"Error reading file {file_path}: {e}")
        
        return sources
    
    def read_file(self, file_path: str) -> ContextSource:
        """Read a single file"""
        path = Path(file_path)
        
        if not path.exists():
            return ContextSource(
                source_type='upload',
                source_name=file_path,
                content=f"[File not found: {file_path}]",
                metadata={'error': 'File not found'}
            )
        
        try:
            content = path.read_text(encoding='utf-8', errors='ignore')
            return ContextSource(
                source_type='upload',
                source_name=file_path,
                content=content[:10000],
                metadata={'file_size': path.stat().st_size}
            )
        except Exception as e:
            return ContextSource(
                source_type='upload',
                source_name=file_path,
                content=f"[Error reading file: {e}]",
                metadata={'error': str(e)}
            )


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


class SalesforceClient:
    """Client for Salesforce CRM API to fetch opportunities"""
    
    BASE_URL = "https://{instance}.salesforce.com"
    
    def __init__(self, bearer_token: str = None, instance_url: str = None):
        """
        Initialize Salesforce client.
        
        Args:
            bearer_token: Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)
            instance_url: Salesforce instance URL (e.g., https://yourcompany.my.salesforce.com)
                         Can also be set via SALESFORCE_INSTANCE_URL env var
        """
        self.bearer_token = bearer_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        self.instance_url = instance_url or os.environ.get('SALESFORCE_INSTANCE_URL', '')
        
        # Remove trailing slash if present
        if self.instance_url.endswith('/'):
            self.instance_url = self.instance_url[:-1]
        
        if not self.bearer_token:
            logger.warning("Salesforce access token not configured")
    
    def _make_request(self, method: str, endpoint: str, data: Dict = None, params: Dict = None) -> Dict:
        """Make authenticated request to Salesforce API"""
        import requests
        
        if not self.bearer_token:
            return {"error": "Salesforce access token not configured"}
        
        if not self.instance_url:
            return {"error": "Salesforce instance URL not configured"}
        
        url = f"{self.instance_url}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json"
        }
        
        try:
            if method == "GET":
                response = requests.get(url, headers=headers, params=params, timeout=30)
            elif method == "POST":
                response = requests.post(url, headers=headers, json=data, timeout=30)
            elif method == "PATCH":
                response = requests.patch(url, headers=headers, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            
            response.raise_for_status()
            return response.json() if response.text else {}
        except requests.exceptions.HTTPError as e:
            logger.error(f"Salesforce API error: {e}")
            error_body = ""
            try:
                error_body = e.response.json() if e.response else ""
            except (ValueError, AttributeError):
                error_body = e.response.text if e.response else ""
            return {"error": str(e), "status_code": e.response.status_code if e.response else None, "details": error_body}
        except Exception as e:
            logger.error(f"Salesforce request error: {e}")
            return {"error": str(e)}
    
    def get_contact(self, contact_id: str) -> Dict:
        """Get contact details from Salesforce"""
        endpoint = f"/services/data/v59.0/sobjects/Contact/{contact_id}"
        return self._make_request("GET", endpoint)
    
    def get_account(self, account_id: str) -> Dict:
        """Get account details from Salesforce"""
        endpoint = f"/services/data/v59.0/sobjects/Account/{account_id}"
        return self._make_request("GET", endpoint)
    
    def get_opportunity(self, opportunity_id: str) -> Optional[SalesforceOpportunity]:
        """Fetch an opportunity by ID with associated account and contact"""
        # Get opportunity with related fields
        endpoint = f"/services/data/v59.0/sobjects/Opportunity/{opportunity_id}"
        result = self._make_request("GET", endpoint)
        
        if "error" in result:
            logger.error(f"Failed to fetch opportunity {opportunity_id}: {result['error']}")
            return None
        
        # Extract basic opportunity fields
        opp_name = result.get("Name", "Untitled Opportunity")
        amount = float(result.get("Amount", 0) or 0)
        stage = result.get("StageName", "unknown")
        close_date = result.get("CloseDate", "")
        description = result.get("Description", "")
        account_id = result.get("AccountId", "")
        
        # Fetch account details
        account_name = ""
        account_industry = ""
        billing_address = {}
        
        if account_id:
            account_data = self.get_account(account_id)
            if "error" not in account_data:
                account_name = account_data.get("Name", "")
                account_industry = account_data.get("Industry", "")
                billing_address = {
                    "billing_street": account_data.get("BillingStreet", ""),
                    "billing_city": account_data.get("BillingCity", ""),
                    "billing_state": account_data.get("BillingState", ""),
                    "billing_postal_code": account_data.get("BillingPostalCode", ""),
                    "billing_country_code": account_data.get("BillingCountry", "US")
                }
        
        # Fetch primary contact (using ContactRoles or first contact on account)
        contact_name = "Unknown Contact"
        contact_email = ""
        contact_phone = ""
        contact_title = ""
        contact_first_name = "Unknown"
        contact_last_name = "Contact"
        
        # Try to get OpportunityContactRoles
        import re as _re
        if not _re.match(r'^[a-zA-Z0-9]{15,18}$', opportunity_id):
            logger.warning(f"Invalid Salesforce opportunity ID format: {opportunity_id}")
            contact_roles = {"error": "Invalid opportunity ID format"}
        else:
            contact_roles_endpoint = f"/services/data/v59.0/query?q=SELECT+ContactId,IsPrimary,Role+FROM+OpportunityContactRole+WHERE+OpportunityId='{opportunity_id}'+ORDER+BY+IsPrimary+DESC+LIMIT+1"
            contact_roles = self._make_request("GET", contact_roles_endpoint)
        
        if "error" not in contact_roles and contact_roles.get("records"):
            contact_id = contact_roles["records"][0].get("ContactId")
            if contact_id:
                contact_data = self.get_contact(contact_id)
                if "error" not in contact_data:
                    contact_first_name = contact_data.get("FirstName", "Unknown")
                    contact_last_name = contact_data.get("LastName", "Contact")
                    contact_name = f"{contact_first_name} {contact_last_name}".strip()
                    contact_email = contact_data.get("Email", "")
                    contact_phone = contact_data.get("Phone", "")
                    contact_title = contact_data.get("Title", "")
        
        return SalesforceOpportunity(
            opportunity_id=opportunity_id,
            name=opp_name,
            amount=amount,
            stage=stage,
            close_date=close_date,
            account_name=account_name,
            contact_name=contact_name,
            contact_email=contact_email,
            description=description,
            properties={
                **result,
                "contact_first_name": contact_first_name,
                "contact_last_name": contact_last_name,
                "contact_phone": contact_phone,
                "contact_title": contact_title,
                "account_industry": account_industry,
                **billing_address
            }
        )
    
    def list_opportunities(self, limit: int = 10) -> List[SalesforceOpportunity]:
        """List recent opportunities"""
        query = f"SELECT Id,Name,Amount,StageName,CloseDate,AccountId FROM Opportunity ORDER BY CreatedDate DESC LIMIT {limit}"
        endpoint = f"/services/data/v59.0/query?q={query.replace(' ', '+')}"
        result = self._make_request("GET", endpoint)
        
        if "error" in result:
            logger.error(f"Failed to list opportunities: {result['error']}")
            return []
        
        opportunities = []
        for opp_data in result.get("records", []):
            opportunities.append(SalesforceOpportunity(
                opportunity_id=opp_data.get("Id", ""),
                name=opp_data.get("Name", "Untitled"),
                amount=float(opp_data.get("Amount", 0) or 0),
                stage=opp_data.get("StageName", "unknown"),
                close_date=opp_data.get("CloseDate", ""),
                account_name="",  # Not fetched in list
                contact_name="",
                contact_email="",
                description="",
                properties=opp_data
            ))
        
        return opportunities


class PipedriveClient:
    """Client for Pipedrive CRM API to fetch deals."""

    def __init__(self, bearer_token: str = None, instance_url: str = None):
        """
        Initialize Pipedrive client.

        Args:
            bearer_token: Pipedrive API token (or set PIPEDRIVE_API_TOKEN env).
            instance_url: Pipedrive company URL (e.g. https://yourco.pipedrive.com).
                          Also accepts PIPEDRIVE_INSTANCE_URL env var.
        """
        self.bearer_token = bearer_token or os.environ.get('PIPEDRIVE_API_TOKEN')
        self.instance_url = instance_url or os.environ.get('PIPEDRIVE_INSTANCE_URL', '')

        if self.instance_url.endswith('/'):
            self.instance_url = self.instance_url[:-1]

        if not self.bearer_token:
            logger.warning("Pipedrive API token not configured")

        # Cache of stage_id -> stage name. Populated lazily on first access.
        # Pipedrive's /deals and /deals/{id} endpoints return stage_id but not
        # stage_name, so we resolve names from /stages once per client instance.
        self._stage_name_by_id: Optional[Dict[int, str]] = None

    def _resolve_stage_name(self, stage_id) -> str:
        """Return the stage name for a given stage_id, fetching /stages on first call."""
        if not stage_id:
            return ""

        # Lazy-load the stage cache
        if self._stage_name_by_id is None:
            stages_resp = self._make_request("GET", "/stages")
            cache: Dict[int, str] = {}
            if isinstance(stages_resp, dict) and stages_resp.get("data"):
                for stage in stages_resp["data"]:
                    sid = stage.get("id")
                    sname = stage.get("name", "")
                    if sid is not None:
                        cache[int(sid)] = sname
            self._stage_name_by_id = cache

        try:
            return self._stage_name_by_id.get(int(stage_id), "")
        except (TypeError, ValueError):
            return ""

    def _make_request(self, method: str, endpoint: str, data: Dict = None, params: Dict = None) -> Dict:
        """Make an authenticated request to Pipedrive API v1.

        Pipedrive's API accepts auth via the `api_token` query parameter on every
        request. The docs also list an OAuth-only `Authorization: Bearer` scheme,
        but it does NOT accept personal API tokens via the Bearer header — such
        calls come back as 401 unauthorized. So always append `api_token` here.
        """
        import requests

        if not self.bearer_token:
            return {"error": "Pipedrive API token not configured"}
        if not self.instance_url:
            return {"error": "Pipedrive instance URL not configured"}

        url = f"{self.instance_url}/api/v1{endpoint}"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        # Merge api_token into params so requests handles URL-encoding.
        merged_params = dict(params) if params else {}
        merged_params["api_token"] = self.bearer_token

        try:
            if method == "GET":
                response = requests.get(url, headers=headers, params=merged_params, timeout=30)
            elif method == "POST":
                response = requests.post(url, headers=headers, params=merged_params, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            response.raise_for_status()
            return response.json() if response.text else {}
        except requests.exceptions.HTTPError as e:
            logger.error(f"Pipedrive API error: {e}")
            error_body = ""
            try:
                error_body = e.response.json() if e.response else ""
            except Exception:
                error_body = e.response.text if e.response else ""
            return {
                "error": str(e),
                "status_code": e.response.status_code if e.response else None,
                "details": error_body,
            }
        except Exception as e:
            logger.error(f"Pipedrive request error: {e}")
            return {"error": str(e)}

    def get_person(self, person_id) -> Dict:
        """Fetch a person (contact) by ID."""
        result = self._make_request("GET", f"/persons/{person_id}")
        return result.get("data") if isinstance(result, dict) and "data" in result else {}

    def get_organization(self, org_id) -> Dict:
        """Fetch an organization (account) by ID."""
        result = self._make_request("GET", f"/organizations/{org_id}")
        return result.get("data") if isinstance(result, dict) and "data" in result else {}

    def get_deal(self, deal_id: str):
        """Fetch a deal by ID with resolved person + organization."""
        from crm.pipedrive_mapper import PipedriveDeal

        result = self._make_request("GET", f"/deals/{deal_id}")
        if "error" in result or not result.get("data"):
            logger.error(f"Failed to fetch Pipedrive deal {deal_id}: {result.get('error')}")
            return None

        deal = result["data"]

        # Resolve organization
        org_name = ""
        org_props: Dict = {}
        org_id = None
        if isinstance(deal.get("org_id"), dict):
            org_name = deal["org_id"].get("name", "")
            org_id = deal["org_id"].get("value")
        elif deal.get("org_id"):
            org_id = deal["org_id"]
        if org_id:
            org = self.get_organization(org_id) or {}
            if org:
                org_name = org_name or org.get("name", "")
                # Pipedrive organization fields. Note: Pipedrive orgs don't
                # have a standard website field, so we omit WebsiteUrl here and
                # let the mapper fall back to its DEFAULT_WEBSITE. If your org
                # uses a custom field for website, plumb it through via a custom
                # field key here (and keep in mind Pipedrive custom-field keys
                # are 40-char hex hashes, not human names).
                org_props = {
                    "org_address": org.get("address", ""),
                    "org_city": org.get("address_locality", ""),
                    "org_state": org.get("address_admin_area_level_1", ""),
                    "org_postal_code": org.get("address_postal_code", ""),
                    "org_country": org.get("address_country", ""),
                    "org_industry": org.get("industry", ""),  # often a custom field
                }

        # Resolve person (primary contact)
        contact_first_name = ""
        contact_last_name = ""
        contact_name = ""
        contact_email = ""
        contact_phone = ""
        contact_title = ""
        person_id = None
        if isinstance(deal.get("person_id"), dict):
            contact_name = deal["person_id"].get("name", "")
            person_id = deal["person_id"].get("value")
        elif deal.get("person_id"):
            person_id = deal["person_id"]
        if person_id:
            person = self.get_person(person_id) or {}
            if person:
                contact_first_name = person.get("first_name", "") or ""
                contact_last_name = person.get("last_name", "") or ""
                contact_name = contact_name or (
                    f"{contact_first_name} {contact_last_name}".strip() or person.get("name", "")
                )
                contact_title = person.get("job_title", "") or ""
                # Pipedrive returns email/phone as arrays of {label, value, primary}
                for entry in person.get("email", []) or []:
                    if entry.get("primary") and entry.get("value"):
                        contact_email = entry["value"]
                        break
                if not contact_email and (person.get("email") or []):
                    first_entry = (person["email"] or [{}])[0]
                    contact_email = first_entry.get("value", "") if isinstance(first_entry, dict) else ""
                for entry in person.get("phone", []) or []:
                    if entry.get("primary") and entry.get("value"):
                        contact_phone = entry["value"]
                        break
                if not contact_phone and (person.get("phone") or []):
                    first_entry = (person["phone"] or [{}])[0]
                    contact_phone = first_entry.get("value", "") if isinstance(first_entry, dict) else ""

        # Stage — Pipedrive's /deals and /deals/{id} endpoints return stage_id
        # but not stage_name. Resolve the name via the /stages cache when missing.
        stage_name = deal.get("stage_name", "") or deal.get("stage", "") or ""
        if not stage_name:
            stage_name = self._resolve_stage_name(deal.get("stage_id"))

        return PipedriveDeal(
            deal_id=str(deal.get("id", deal_id)),
            title=deal.get("title", "Untitled Deal"),
            value=float(deal.get("value", 0) or 0),
            stage=stage_name,
            expected_close_date=deal.get("expected_close_date", "") or "",
            org_name=org_name,
            contact_name=contact_name,
            contact_email=contact_email,
            description=deal.get("notes", "") or "",
            properties={
                **org_props,
                "currency": deal.get("currency", ""),
                "contact_first_name": contact_first_name,
                "contact_last_name": contact_last_name,
                "contact_phone": contact_phone,
                "contact_title": contact_title,
                "pipeline_id": deal.get("pipeline_id"),
                "stage_id": deal.get("stage_id"),
            },
        )

    def list_deals(self, limit: int = 10) -> List:
        """List recent open deals."""
        from crm.pipedrive_mapper import PipedriveDeal

        result = self._make_request(
            "GET",
            "/deals",
            params={"status": "open", "limit": limit, "start": 0, "sort": "update_time DESC"},
        )
        if "error" in result:
            logger.error(f"Failed to list Pipedrive deals: {result['error']}")
            return []

        deals = []
        for item in result.get("data") or []:
            org_name = ""
            if isinstance(item.get("org_id"), dict):
                org_name = item["org_id"].get("name", "")

            deals.append(
                PipedriveDeal(
                    deal_id=str(item.get("id", "")),
                    title=item.get("title", "Untitled"),
                    value=float(item.get("value", 0) or 0),
                    stage=(
                        item.get("stage_name", "")
                        or item.get("stage", "")
                        or self._resolve_stage_name(item.get("stage_id"))
                    ),
                    expected_close_date=item.get("expected_close_date", "") or "",
                    org_name=org_name,
                    contact_name=(item.get("person_name") or "") if isinstance(item.get("person_name"), str) else "",
                    contact_email="",
                    description="",
                    properties={"currency": item.get("currency", "")},
                )
            )
        return deals


class NextStepsGenerator:
    """Generate next steps using Claude AI"""

    # Anthropic API model used when use_bedrock=False. The Bedrock model is
    # discovered at runtime via list_inference_profiles + list_foundation_models;
    # set BEDROCK_MODEL_ID to skip discovery and pin a specific model.
    DEFAULT_ANTHROPIC_MODEL_ID = 'claude-3-5-sonnet-20241022'

    # Hardcoded fallback list, used only if discovery returns empty (e.g. the
    # IAM policy doesn't include bedrock:ListInferenceProfiles /
    # bedrock:ListFoundationModels). Ordered the way _rank_models would order them.
    FALLBACK_BEDROCK_CANDIDATES = (
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-3-5-haiku-20241022-v1:0',
        'us.anthropic.claude-3-haiku-20240307-v1:0',
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        'us.anthropic.claude-sonnet-4-20250514-v1:0',
        'anthropic.claude-3-haiku-20240307-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
    )

    def __init__(self, use_bedrock: bool = True):
        self.use_bedrock = use_bedrock
        self._bedrock_client = None
        self._bedrock_control_client = None
        self._anthropic_client = None
        # Resolved on first use. None means "not yet probed".
        self._resolved_bedrock_model_id = None
        # Pinned override: BEDROCK_MODEL_ID skips discovery if set.
        self._pinned_bedrock_model_id = os.environ.get('BEDROCK_MODEL_ID')
        self.anthropic_model_id = (
            os.environ.get('ANTHROPIC_MODEL_ID')
            or os.environ.get('BEDROCK_MODEL_ID')
            or self.DEFAULT_ANTHROPIC_MODEL_ID
        )
        self.bedrock_region = (
            os.environ.get('AWS_REGION')
            or os.environ.get('AWS_DEFAULT_REGION')
            or 'us-east-1'
        )
        # Stores the last warning/error if fallback was used
        self.last_warning = None

    @property
    def bedrock_model_id(self):
        """Resolved Bedrock model ID. None until probed (or if probing fails)."""
        return self._resolved_bedrock_model_id or self._pinned_bedrock_model_id

    def _resolve_bedrock_model(self) -> Optional[str]:
        """Pick a Bedrock model that works for this account/region.

        If BEDROCK_MODEL_ID is set, use it as-is (no probing). Otherwise:
          1. List inference profiles + foundation models for Anthropic via
             the bedrock control-plane API.
          2. Score them (Haiku first, then Sonnet/Opus; newer date wins).
          3. Probe each in score order with a tiny converse() call.
          4. Stop at the first success and cache the winner.

        Subsequent calls return the cached value with no extra API traffic.
        """
        if self._resolved_bedrock_model_id:
            return self._resolved_bedrock_model_id
        if self._pinned_bedrock_model_id:
            self._resolved_bedrock_model_id = self._pinned_bedrock_model_id
            return self._resolved_bedrock_model_id

        client = self.bedrock_client
        if client is None:
            return None

        candidates = self._discover_anthropic_models()
        used_fallback = False
        if not candidates:
            logger.info(
                f"Bedrock discovery returned no models in {self.bedrock_region} "
                "(missing bedrock:List* permissions?). Using built-in fallback list."
            )
            candidates = list(self.FALLBACK_BEDROCK_CANDIDATES)
            used_fallback = True

        for candidate in candidates:
            try:
                client.converse(
                    modelId=candidate,
                    messages=[{"role": "user", "content": [{"text": "ping"}]}],
                    inferenceConfig={"maxTokens": 5},
                )
                logger.info(
                    f"Bedrock model resolved: {candidate} "
                    f"(region={self.bedrock_region}, source={'fallback' if used_fallback else 'discovered'})"
                )
                self._resolved_bedrock_model_id = candidate
                return candidate
            except Exception as e:
                err = str(e)
                if any(t in err for t in (
                    'AccessDeniedException', 'ValidationException',
                    'ResourceNotFoundException', 'inference profile',
                    'not found', 'does not exist', 'on-demand throughput',
                )):
                    logger.debug(f"Bedrock candidate {candidate} not usable: {err[:150]}")
                    continue
                # Anything else (network, throttling) — abort discovery so we
                # don't burn through the candidate list on a transient error.
                logger.warning(f"Bedrock probe aborted on {candidate}: {err[:200]}")
                return None

        logger.error(
            f"No usable Bedrock model in {self.bedrock_region} "
            f"(tried {len(candidates)} candidate(s))."
        )
        return None

    def _discover_anthropic_models(self) -> List[str]:
        """Return a scored, deduplicated list of Anthropic model/profile IDs.

        Inference profiles (e.g. 'us.anthropic.claude-…') are listed first
        because the newer Claude models are only invocable through them.
        Bare model IDs are appended as a fallback for older models.
        """
        control = self.bedrock_control_client
        if control is None:
            return []

        ids: List[str] = []

        # 1. Inference profiles (cross-region routing). Cheaper to try first.
        try:
            paginator = control.get_paginator('list_inference_profiles')
            for page in paginator.paginate():
                for prof in page.get('inferenceProfileSummaries', []):
                    pid = prof.get('inferenceProfileId') or prof.get('inferenceProfileArn', '')
                    if 'anthropic' in pid.lower() and prof.get('status', 'ACTIVE') == 'ACTIVE':
                        ids.append(pid)
        except Exception as e:
            logger.debug(f"list_inference_profiles failed: {str(e)[:150]}")

        # 2. Foundation models (bare on-demand IDs).
        try:
            resp = control.list_foundation_models(byProvider='anthropic')
            for m in resp.get('modelSummaries', []):
                if 'TEXT' not in m.get('outputModalities', []):
                    continue
                if m.get('modelLifecycle', {}).get('status') != 'ACTIVE':
                    continue
                if 'ON_DEMAND' not in m.get('inferenceTypesSupported', ['ON_DEMAND']):
                    # Skip models that *require* a profile — they'll fail
                    # converse() with on-demand throughput unsupported.
                    continue
                ids.append(m['modelId'])
        except Exception as e:
            logger.debug(f"list_foundation_models failed: {str(e)[:150]}")

        return self._rank_models(ids)

    @staticmethod
    def _rank_models(ids: List[str]) -> List[str]:
        """Order Claude IDs by family (haiku→sonnet→opus) then by version date."""
        family_rank = {'haiku': 0, 'sonnet': 1, 'opus': 2}
        date_re = re.compile(r'(\d{8})')

        def key(model_id: str):
            mid = model_id.lower()
            family = next((f for f in family_rank if f in mid), 'zzz_other')
            date_match = date_re.search(mid)
            # Newer dates first → negate the parsed int.
            date_key = -int(date_match.group(1)) if date_match else 0
            # Inference profiles (us./eu./apac.) preferred over bare IDs.
            profile_priority = 0 if mid.split('.')[0] in ('us', 'eu', 'apac') else 1
            return (family_rank.get(family, 99), profile_priority, date_key)

        # Dedup while preserving sort order.
        seen = set()
        ordered = []
        for mid in sorted(ids, key=key):
            if mid not in seen:
                seen.add(mid)
                ordered.append(mid)
        return ordered

    @property
    def bedrock_client(self):
        if self._bedrock_client is None and self.use_bedrock:
            try:
                import boto3
                self._bedrock_client = boto3.client('bedrock-runtime', region_name=self.bedrock_region)
            except Exception as e:
                logger.warning(f"Bedrock client not available: {e}")
        return self._bedrock_client

    @property
    def bedrock_control_client(self):
        """Control-plane client used to list inference profiles + foundation models."""
        if self._bedrock_control_client is None and self.use_bedrock:
            try:
                import boto3
                self._bedrock_control_client = boto3.client('bedrock', region_name=self.bedrock_region)
            except Exception as e:
                logger.debug(f"Bedrock control-plane client not available: {e}")
        return self._bedrock_control_client
    
    @property
    def anthropic_client(self):
        if self._anthropic_client is None and not self.use_bedrock:
            try:
                import anthropic
                self._anthropic_client = anthropic.Anthropic()
            except Exception as e:
                logger.warning(f"Anthropic client not available: {e}")
        return self._anthropic_client
    
    def generate(self, context_sources: List[ContextSource], prompt: str, opportunity_data: Dict = None) -> str:
        """Generate next steps based on gathered context"""
        self.last_warning = None  # Clear any previous warning
        
        # Build context string
        context_parts = []
        for source in context_sources:
            context_parts.append(f"### Source: {source.source_name} ({source.source_type})\n{source.content}\n")
        
        context_text = "\n".join(context_parts)
        
        # Add opportunity data if available
        opp_context = ""
        if opportunity_data:
            opp_context = f"""
### Current Opportunity Data
- Customer: {opportunity_data.get('Customer', {}).get('Account', {}).get('CompanyName', 'Unknown')}
- Stage: {opportunity_data.get('LifeCycle', {}).get('Stage', 'Unknown')}
- Current Next Steps: {opportunity_data.get('LifeCycle', {}).get('NextSteps', 'None')}
"""
        
        full_prompt = f"""You are an AI assistant helping a partner sales team manage AWS Partner Central opportunities.

Based on the following context from various sources, generate clear, actionable next steps for this opportunity.

{opp_context}

## Context from Sources:
{context_text}

## User Request:
{prompt}

## Instructions:
1. Analyze all the context provided
2. Identify the TOP 2-3 most critical action items
3. CRITICAL: Total response must be UNDER 255 characters (Partner Central field limit)
4. Be extremely concise - use abbreviations if needed
5. Format as a simple numbered list without headers

## Next Steps:"""

        try:
            if self.use_bedrock and self.bedrock_client:
                model_id = self._resolve_bedrock_model()
                if not model_id:
                    return self._generate_fallback(
                        context_sources, opportunity_data,
                        reason="No usable Bedrock Claude model found in region "
                               f"{self.bedrock_region}. Enable Anthropic model access in "
                               "the Bedrock console, or set BEDROCK_MODEL_ID."
                    )
                # Use converse API instead of invoke_model for better model compatibility
                response = self.bedrock_client.converse(
                    modelId=model_id,
                    messages=[{
                        "role": "user",
                        "content": [{"text": full_prompt}]
                    }],
                    inferenceConfig={
                        "maxTokens": 1000,
                        "temperature": 0.7
                    }
                )
                return response['output']['message']['content'][0]['text'].strip()
                
            elif self.anthropic_client:
                response = self.anthropic_client.messages.create(
                    model=self.anthropic_model_id,
                    max_tokens=1000,
                    messages=[{"role": "user", "content": full_prompt}]
                )
                return response.content[0].text.strip()
            
            else:
                logger.error("No AI client available")
                return self._generate_fallback(context_sources, opportunity_data,
                                               reason="No AI client configured (Bedrock or Anthropic)")
                
        except Exception as e:
            logger.error(f"Error generating next steps: {e}")
            return self._generate_fallback(context_sources, opportunity_data,
                                           reason=str(e))

    def _generate_fallback(self, context_sources: List[ContextSource], opportunity_data: Dict = None, reason: str = "") -> str:
        """Generate a reasonable placeholder when Bedrock/Anthropic is unavailable.

        This allows participants to continue the workshop (MCP update, approval
        flow, chat) even if their Bedrock permissions aren't set up correctly.
        The fallback extracts keywords from the context and builds a generic
        but plausible next-steps string.
        """
        warning_msg = (
            f"⚠️ AI model (Bedrock) failed — using keyword-based fallback. "
            f"Error: {reason}\n\n"
            f"To fix: check your IAM policy includes "
            f"'arn:aws:bedrock:*::foundation-model/*' and "
            f"'arn:aws:bedrock:*:*:inference-profile/*' in the Resource field. "
            f"Share this error with your cloud admin."
        )
        self.last_warning = warning_msg
        logger.warning(f"Using fallback next-steps generator (reason: {reason})")

        # Try to extract something useful from the context
        keywords = []
        for source in (context_sources or []):
            text = source.content.lower()
            if "migration" in text or "migrate" in text:
                keywords.append("migration planning")
            if "cost" in text or "spend" in text or "savings" in text:
                keywords.append("cost optimization review")
            if "architecture" in text or "well-architected" in text:
                keywords.append("architectural review")
            if "funding" in text or "map" in text:
                keywords.append("MAP funding application")
            if "security" in text or "compliance" in text or "hipaa" in text:
                keywords.append("security/compliance review")
            if "poc" in text or "demo" in text or "proof" in text:
                keywords.append("schedule POC/demo")
            if "meeting" in text or "call" in text:
                keywords.append("follow-up meeting")

        # Deduplicate and limit
        seen = set()
        unique_keywords = []
        for kw in keywords:
            if kw not in seen:
                seen.add(kw)
                unique_keywords.append(kw)
            if len(unique_keywords) >= 3:
                break

        # Build fallback steps
        if unique_keywords:
            steps = [f"{i+1}. {kw.capitalize()}" for i, kw in enumerate(unique_keywords)]
        else:
            # Generic fallback if no keywords found
            steps = [
                "1. Schedule follow-up meeting with customer",
                "2. Prepare technical proposal and pricing",
                "3. Submit opportunity for AWS review"
            ]

        result = "\n".join(steps)

        # Truncate to 255 chars (Partner Central limit)
        if len(result) > 255:
            result = result[:252] + "..."

        logger.info(f"Fallback next steps generated: {result}")
        return result


class PartnerCentralMCPClient:
    """Client for Partner Central MCP to update opportunities"""
    
    def __init__(self, config_path: str = None):
        self.config = self._load_config(config_path)
        self._pc_client = None
    
    def _load_config(self, config_path: str = None) -> Dict:
        """Load configuration"""
        if config_path and Path(config_path).exists():
            with open(config_path) as f:
                return json.load(f)
        
        # Try same directory config first
        local_config = Path(__file__).parent / 'config.json'
        if local_config.exists():
            with open(local_config) as f:
                return json.load(f)
        
        # Try parent directory config
        parent_config = Path(__file__).parent.parent / 'config.json'
        if parent_config.exists():
            with open(parent_config) as f:
                return json.load(f)
        
        return {
            "catalog": "AWS",
            "region": "us-east-1",
            "endpoints": {
                "partnercentral_selling": "https://partnercentral-selling.us-east-1.api.aws",
                "partnercentral_mcp": "https://partnercentral-agents.us-east-1.api.aws/mcp"
            }
        }
    
    @property
    def pc_client(self):
        """Get Partner Central selling client"""
        if self._pc_client is None:
            import boto3
            self._pc_client = boto3.client(
                'partnercentral-selling',
                region_name=self.config.get('region', 'us-east-1'),
                endpoint_url=self.config['endpoints']['partnercentral_selling']
            )
        return self._pc_client
    
    def get_opportunity(self, opportunity_id: str) -> Dict:
        """Fetch opportunity data"""
        try:
            response = self.pc_client.get_opportunity(
                Catalog=self.config.get('catalog', 'AWS'),
                Identifier=opportunity_id
            )
            return response
        except Exception as e:
            logger.error(f"Error fetching opportunity {opportunity_id}: {e}")
            return {}
    
    def list_solutions(self, max_results: int = 50) -> List[Dict]:
        """List the partner's registered solutions via Partner Central Selling API.
        
        This is a complement to the Partner Central Agent flow: when the agent
        asks "what solution are you offering?", the orchestrator can call this
        method to fetch real solution IDs that the partner has registered, then
        present them as picker options instead of asking the user to type free text.
        
        Demonstrates the "API + Agent" pattern — API for deterministic data lookups,
        Agent for natural-language guidance.
        """
        try:
            response = self.pc_client.list_solutions(
                Catalog=self.config.get('catalog', 'AWS'),
                MaxResults=min(max_results, 100)
            )
            solutions = []
            for s in response.get('SolutionSummaries', []):
                solutions.append({
                    'id': s.get('Id', ''),
                    'name': s.get('Name', 'Untitled'),
                    'category': s.get('Category', ''),
                    'status': s.get('Status', ''),
                    'arn': s.get('Arn', ''),
                })
            logger.info(f"ListSolutions returned {len(solutions)} solutions from {self.config.get('catalog')} catalog")
            return solutions
        except Exception as e:
            logger.error(f"Error listing solutions: {e}")
            return []

    def list_opportunities(self, max_results: int = 50, since_days: int = None) -> List[Dict]:
        """List opportunities for the current partner via Partner Central Selling API.

        Args:
            max_results: Max opportunities to return per page (default 50, max 100).
            since_days: If set, only include opportunities last modified in this
                many days. Helpful for the AO opportunity finder.
        """
        try:
            params = {
                'Catalog': self.config.get('catalog', 'AWS'),
                'MaxResults': min(max_results, 100),
            }
            if since_days:
                from datetime import datetime, timedelta, timezone
                since = datetime.now(timezone.utc) - timedelta(days=since_days)
                params['LastModifiedDate'] = {
                    'AfterLastModifiedDate': since.isoformat(),
                }
            opportunities = []
            next_token = None
            while True:
                if next_token:
                    params['NextToken'] = next_token
                response = self.pc_client.list_opportunities(**params)
                opportunities.extend(response.get('OpportunitySummaries', []))
                next_token = response.get('NextToken')
                if not next_token:
                    break
                if len(opportunities) >= 500:
                    logger.warning('Stopping ListOpportunities pagination at 500 results')
                    break
            logger.info(f'ListOpportunities returned {len(opportunities)} opportunity summaries')
            return opportunities
        except Exception as e:
            logger.error(f'Error listing opportunities: {e}')
            return []

    def get_aws_opportunity_summary(self, opportunity_id: str) -> Dict:
        """Fetch the AWS-side summary of an opportunity (returns Origin, InvolvementType, etc.)."""
        try:
            response = self.pc_client.get_aws_opportunity_summary(
                Catalog=self.config.get('catalog', 'AWS'),
                RelatedOpportunityIdentifier=opportunity_id,
            )
            return response
        except Exception as e:
            logger.warning(f'Error fetching AwsOpportunitySummary for {opportunity_id}: {e}')
            return {}

    def find_ao_opportunities(self, since_days: int = 180, limit: int = 100) -> List[Dict]:
        """Find AWS-originated (Origin = 'AWS Referral') opportunities.

        The Partner Central Agent's pipeline tools cannot reliably filter by
        Origin = 'AWS Referral'. This orchestrator method chains multiple PC
        Selling APIs to do it ourselves: ListOpportunities -> GetAwsOpportunitySummary
        for each -> filter on Origin -> GetOpportunity for region details.

        Args:
            since_days: Look back this many days (default 180).
            limit: Max opportunities to scan (default 100, hard cap to keep
                latency reasonable in the chat UI).

        Returns:
            List of dicts with keys: id, customer_name, stage, target_close_date,
            origin, involvement_type, region, country_code, last_modified_date.
        """
        from concurrent.futures import ThreadPoolExecutor
        summaries = self.list_opportunities(max_results=100, since_days=since_days)
        if not summaries:
            return []
        if len(summaries) > limit:
            logger.info(f'Truncating scan from {len(summaries)} to {limit} opportunities')
            summaries = summaries[:limit]

        def _check_one(opp_summary):
            opp_id = opp_summary.get('Id')
            if not opp_id:
                return None
            aws_summary = self.get_aws_opportunity_summary(opp_id)
            if (aws_summary.get('Origin') or '').strip().lower() != 'aws referral':
                return None
            full = self.get_opportunity(opp_id) or {}
            project = full.get('Project', {}) or {}
            customer = full.get('Customer', {}) or {}
            account = customer.get('Account', {}) or {}
            return {
                'id': opp_id,
                'customer_name': account.get('CompanyName', 'Unknown'),
                'country_code': account.get('Address', {}).get('CountryCode', ''),
                'stage': (full.get('LifeCycle', {}) or {}).get('Stage', ''),
                'target_close_date': (full.get('LifeCycle', {}) or {}).get('TargetCloseDate', ''),
                'origin': aws_summary.get('Origin'),
                'involvement_type': aws_summary.get('InvolvementType'),
                'region': (
                    aws_summary.get('Region')
                    or project.get('Region')
                    or account.get('Address', {}).get('CountryCode', '')
                    or ''
                ),
                'last_modified_date': opp_summary.get('LastModifiedDate', ''),
            }

        with ThreadPoolExecutor(max_workers=8) as ex:
            results = [r for r in ex.map(_check_one, summaries) if r]

        def _sort_key(item):
            v = item.get('last_modified_date') or ''
            if hasattr(v, 'isoformat'):
                return v.isoformat()
            return str(v)
        results.sort(key=_sort_key, reverse=True)
        logger.info(f'find_ao_opportunities: {len(results)} AO opportunity(ies) found')
        return results

    def list_engagement_invitations(self, since_days: int = 30, max_results: int = 50,
                                    participant_type: str = 'RECEIVER') -> List[Dict]:
        """List engagement invitations received from AWS, optionally filtered by date.

        Args:
            since_days: Only include invitations dated within the last N days.
                Set to None to disable the date filter.
            max_results: Max items per page (1-50, hard cap).
            participant_type: 'RECEIVER' for invitations sent TO this account,
                'SENDER' for invitations sent BY this account.

        Returns:
            List of EngagementInvitationSummary dicts (Id, EngagementTitle,
            Status, InvitationDate, SenderAwsAccountId, etc.).
        """
        try:
            params = {
                'Catalog': self.config.get('catalog', 'AWS'),
                'MaxResults': min(max_results, 50),
                'ParticipantType': participant_type,
            }
            invitations = []
            next_token = None
            while True:
                if next_token:
                    params['NextToken'] = next_token
                response = self.pc_client.list_engagement_invitations(**params)
                invitations.extend(response.get('EngagementInvitationSummaries', []))
                next_token = response.get('NextToken')
                if not next_token:
                    break
                if len(invitations) >= 200:
                    logger.warning('Stopping ListEngagementInvitations pagination at 200 results')
                    break

            if since_days:
                from datetime import datetime, timedelta, timezone
                cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)

                def _on_or_after_cutoff(inv):
                    inv_date = inv.get('InvitationDate')
                    if not inv_date:
                        return False
                    if hasattr(inv_date, 'tzinfo'):
                        return inv_date >= cutoff
                    try:
                        from datetime import datetime as _dt
                        parsed = _dt.fromisoformat(str(inv_date).replace('Z', '+00:00'))
                        return parsed >= cutoff
                    except Exception:
                        return True

                invitations = [i for i in invitations if _on_or_after_cutoff(i)]

            logger.info(f'list_engagement_invitations: {len(invitations)} invitation(s) returned')
            return invitations
        except Exception as e:
            logger.error(f'Error listing engagement invitations: {e}')
            return []

    def get_engagement_invitation(self, invitation_id: str) -> Dict:
        """Fetch the full payload of an engagement invitation including customer details."""
        try:
            response = self.pc_client.get_engagement_invitation(
                Catalog=self.config.get('catalog', 'AWS'),
                Identifier=invitation_id,
            )
            return response
        except Exception as e:
            logger.warning(f'Error fetching engagement invitation {invitation_id}: {e}')
            return {}

    def find_engagement_invitations_by_country(self, country_code=None,
                                               since_days: int = 30,
                                               limit: int = 50) -> List[Dict]:
        """Find engagement invitations from AWS, optionally filtered by customer country.

        The Partner Central Agent has no tool for engagement invitations. The
        custom orchestrator chains ListEngagementInvitations with date filter
        + GetEngagementInvitation per item to read the customer country code,
        then filters locally to deliver country-scoped pipeline results.

        Args:
            country_code: Either a single ISO country code (e.g., 'US'), a list
                of codes (e.g., ['DE', 'FR', 'IT']) for regional groupings, or
                None to return all.
            since_days: Only invitations from the last N days (default 30).
            limit: Max invitations to scan (default 50).
        """
        from concurrent.futures import ThreadPoolExecutor
        summaries = self.list_engagement_invitations(
            since_days=since_days, max_results=50, participant_type='RECEIVER'
        )
        if not summaries:
            return []
        if len(summaries) > limit:
            logger.info(f'Truncating engagement invitation scan from {len(summaries)} to {limit}')
            summaries = summaries[:limit]

        if isinstance(country_code, str):
            target_countries = {country_code.strip().upper()} if country_code.strip() else None
        elif isinstance(country_code, (list, tuple, set)):
            target_countries = {c.strip().upper() for c in country_code if c and c.strip()} or None
        else:
            target_countries = None

        def _enrich_one(summary):
            inv_id = summary.get('Id')
            if not inv_id:
                return None
            detail = self.get_engagement_invitation(inv_id)
            payload = (detail.get('Payload') or {}).get('OpportunityInvitation') or {}
            customer = payload.get('Customer') or {}
            project = payload.get('Project') or {}
            inv_country = (customer.get('CountryCode') or '').strip().upper()
            if target_countries and inv_country not in target_countries:
                return None
            return {
                'id': inv_id,
                'engagement_title': summary.get('EngagementTitle', ''),
                'status': summary.get('Status', ''),
                'invitation_date': summary.get('InvitationDate'),
                'expiration_date': summary.get('ExpirationDate'),
                'sender_aws_account_id': summary.get('SenderAwsAccountId', ''),
                'sender_company_name': summary.get('SenderCompanyName', ''),
                'customer_company': customer.get('CompanyName', ''),
                'customer_country': inv_country,
                'customer_industry': customer.get('Industry', ''),
                'project_title': project.get('Title', ''),
                'project_business_problem': (project.get('BusinessProblem') or '')[:120],
            }

        with ThreadPoolExecutor(max_workers=8) as ex:
            results = [r for r in ex.map(_enrich_one, summaries) if r]

        def _sort_key(item):
            v = item.get('invitation_date') or ''
            if hasattr(v, 'isoformat'):
                return v.isoformat()
            return str(v)
        results.sort(key=_sort_key, reverse=True)
        logger.info(f'find_engagement_invitations_by_country: {len(results)} invitation(s) match')
        return results

    def create_opportunity(self, deal: 'HubSpotDeal', project_title: str = None) -> Dict:
        """Create a new ACE opportunity from HubSpot deal data using the HubSpot mapper"""
        try:
            from crm.hubspot_mapper import HubSpotToPartnerCentralMapper
            
            # Use the mapper to convert HubSpot deal to Partner Central format
            mapper = HubSpotToPartnerCentralMapper(catalog=self.config.get('catalog', 'Sandbox'))
            request_payload = mapper.map_deal_to_opportunity(deal, project_title)
            
            logger.info(f"Creating opportunity from HubSpot deal {deal.deal_id}...")
            logger.info(f"  PartnerOpportunityIdentifier: {request_payload.get('PartnerOpportunityIdentifier')}")
            logger.info(f"  TargetCloseDate: {request_payload.get('LifeCycle', {}).get('TargetCloseDate')}")
            logger.info(f"📤 CREATE OPPORTUNITY REQUEST: {json.dumps(request_payload, separators=(',', ':'))}")
            
            response = self.pc_client.create_opportunity(**request_payload)
            
            logger.info(f"📥 CREATE OPPORTUNITY RESPONSE: {json.dumps(response, separators=(',', ':'), default=str)}")
            logger.info(f"Opportunity created successfully: {response.get('Id', 'Unknown')}")
            
            return {
                "success": True,
                "opportunity_id": response.get("Id"),
                "response": response
            }
            
        except Exception as e:
            logger.error(f"❌ CREATE OPPORTUNITY ERROR: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def create_opportunity_from_salesforce(self, opp: 'SalesforceOpportunity', project_title: str = None) -> Dict:
        """Create a new ACE opportunity from Salesforce opportunity data using the Salesforce mapper"""
        try:
            from crm.salesforce_mapper import SalesforceToPartnerCentralMapper
            
            # Use the mapper to convert Salesforce opportunity to Partner Central format
            mapper = SalesforceToPartnerCentralMapper(catalog=self.config.get('catalog', 'Sandbox'))
            request_payload = mapper.map_opportunity_to_ace(opp, project_title)
            
            logger.info(f"Creating opportunity from Salesforce opportunity {opp.opportunity_id}...")
            logger.info(f"  PartnerOpportunityIdentifier: {request_payload.get('PartnerOpportunityIdentifier')}")
            logger.info(f"  TargetCloseDate: {request_payload.get('LifeCycle', {}).get('TargetCloseDate')}")
            logger.info(f"📤 CREATE OPPORTUNITY REQUEST: {json.dumps(request_payload, separators=(',', ':'))}")
            
            response = self.pc_client.create_opportunity(**request_payload)
            
            logger.info(f"📥 CREATE OPPORTUNITY RESPONSE: {json.dumps(response, separators=(',', ':'), default=str)}")
            logger.info(f"Opportunity created successfully: {response.get('Id', 'Unknown')}")
            
            return {
                "success": True,
                "opportunity_id": response.get("Id"),
                "response": response
            }
            
        except Exception as e:
            logger.error(f"❌ CREATE OPPORTUNITY ERROR: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def create_opportunity_from_pipedrive(self, deal: 'PipedriveDeal', project_title: str = None) -> Dict:
        """Create a new ACE opportunity from Pipedrive deal data using the Pipedrive mapper"""
        try:
            from crm.pipedrive_mapper import PipedriveToPartnerCentralMapper

            mapper = PipedriveToPartnerCentralMapper(catalog=self.config.get('catalog', 'Sandbox'))
            request_payload = mapper.map_deal_to_opportunity(deal, project_title)

            logger.info(f"Creating opportunity from Pipedrive deal {deal.deal_id}...")
            logger.info(f"  PartnerOpportunityIdentifier: {request_payload.get('PartnerOpportunityIdentifier')}")
            logger.info(f"  TargetCloseDate: {request_payload.get('LifeCycle', {}).get('TargetCloseDate')}")
            logger.info(f"📤 CREATE OPPORTUNITY REQUEST: {json.dumps(request_payload, separators=(',', ':'))}")

            response = self.pc_client.create_opportunity(**request_payload)

            logger.info(f"📥 CREATE OPPORTUNITY RESPONSE: {json.dumps(response, separators=(',', ':'), default=str)}")
            logger.info(f"Opportunity created successfully: {response.get('Id', 'Unknown')}")

            return {
                "success": True,
                "opportunity_id": response.get("Id"),
                "response": response,
            }

        except Exception as e:
            logger.error(f"❌ CREATE OPPORTUNITY ERROR: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    def update_next_steps(
        self,
        opportunity_id: str,
        next_steps: str,
        interactive: bool = True,
        auto_approve: bool = False,
    ) -> Dict:
        """Update opportunity's NextSteps field via MCP.

        Args:
            opportunity_id: ACE opportunity id (e.g., O15081741)
            next_steps: text to write into LifeCycle.NextSteps
            interactive: when True, prompts at the terminal for y/n approval
            auto_approve: when True, automatically approves the update
                without prompting. Use for non-interactive callers (REST
                API, scheduled jobs). Has no effect if `interactive` is True.
        """
        if len(next_steps) > 255:
            next_steps = next_steps[:252] + '...'
            logger.warning("Next steps truncated to 255 characters (Partner Central limit)")

        import boto3
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        
        # Prepare MCP request to update next steps
        mcp_endpoint = self.config['endpoints']['partnercentral_mcp']
        
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sendMessage",
                "arguments": {
                    "content": [{
                        "type": "text",
                        "text": f"""Update opportunity {opportunity_id} with the following next steps:

{next_steps}

Please update the LifeCycle.NextSteps field with this content."""
                    }],
                    "catalog": self.config.get('catalog', 'AWS')
                }
            }
        }

        # Sign request
        session = boto3.Session()
        credentials = session.get_credentials()
        
        request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(payload),
            headers={'Content-Type': 'application/json'}
        )
        
        # Determine service name based on endpoint (gamma vs production)
        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        
        SigV4Auth(credentials, service_name, self.config.get('region', 'us-east-1')).add_auth(request)
        
        try:
            response = requests.post(
                request.url,
                data=request.body,
                headers=dict(request.headers),
                timeout=120
            )
            response.raise_for_status()
            result = response.json()
            
            # Check if approval is required
            if interactive:
                result = self._handle_approval_flow(result, credentials, service_name)
            elif auto_approve:
                result = self._handle_approval_flow(
                    result, credentials, service_name, auto_decision='approve'
                )
            
            return result
        except Exception as e:
            logger.error(f"Error updating opportunity via MCP: {e}")
            return {"error": str(e)}
    
    def _handle_approval_flow(
        self,
        mcp_response: Dict,
        credentials,
        service_name: str,
        auto_decision: Optional[str] = None,
    ) -> Dict:
        """Handle approval flow.
        
        When `auto_decision` is None, this is the original interactive
        flow — prompt at the terminal for y/n. When `auto_decision` is
        'approve' or 'reject', skip the prompt and respond with that
        decision. Used by non-interactive callers (REST API, scheduled
        jobs) so there's no human waiting for a TTY.
        """
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        
        try:
            content = mcp_response.get('result', {}).get('content', [])
            if not content or content[0].get('type') != 'text':
                return mcp_response
            
            inner = json.loads(content[0].get('text', '{}'))
            status = inner.get('status', '')
            session_id = inner.get('sessionId', '')
            
            if status != 'requires_approval':
                return mcp_response
            
            # Find tool approval request
            tool_use_id = None
            tool_name = None
            tool_input = None
            
            for item in inner.get('content', []):
                if item.get('type') == 'tool_approval_request':
                    tool_content = item.get('content', {})
                    # Parse the text field which contains JSON
                    try:
                        approval_data = json.loads(tool_content.get('text', '{}'))
                        tool_use_id = approval_data.get('tool_use_id')
                        tool_name = approval_data.get('tool_name')
                        tool_input = approval_data.get('input')
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        tool_use_id = tool_content.get('toolUseId')
                        tool_name = tool_content.get('name')
                        tool_input = tool_content.get('input')
                    break
            
            if not tool_use_id:
                logger.warning("No tool approval request found in response")
                return mcp_response
            
            # Display approval prompt (skipped when auto_decision is set)
            if auto_decision is None:
                print("\n" + "="*60)
                print("🔐 APPROVAL REQUIRED")
                print("="*60)
                print(f"Tool: {tool_name}")
                print(f"Session: {session_id}")
                if tool_input:
                    try:
                        input_data = json.loads(tool_input) if isinstance(tool_input, str) else tool_input
                        print(f"Action: Update NextSteps field")
                        if 'NextSteps' in str(input_data):
                            print(f"Content preview: {str(input_data)[:200]}...")
                    except (json.JSONDecodeError, TypeError):
                        print(f"Input: {str(tool_input)[:200]}...")
                print("="*60)
                
                # Get user input
                while True:
                    choice = input("\nApprove this update? [y/n]: ").strip().lower()
                    if choice in ['y', 'yes']:
                        decision = 'approve'
                        break
                    elif choice in ['n', 'no']:
                        decision = 'reject'
                        break
                    print("Please enter 'y' or 'n'")
            else:
                # Non-interactive caller — apply the requested decision.
                decision = auto_decision
                logger.info(
                    f"Auto-{decision} for tool {tool_name} (tool_use_id={tool_use_id})"
                )
            
            # Send approval response
            mcp_endpoint = self.config['endpoints']['partnercentral_mcp']
            
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
                            "decision": decision
                        }],
                        "catalog": self.config.get('catalog', 'AWS'),
                        "sessionId": session_id
                    }
                }
            }

            request = AWSRequest(
                method='POST',
                url=mcp_endpoint,
                data=json.dumps(approval_payload),
                headers={'Content-Type': 'application/json'}
            )
            
            SigV4Auth(credentials, service_name, self.config.get('region', 'us-east-1')).add_auth(request)
            
            logger.info(f"Sending {decision} decision...")
            response = requests.post(
                request.url,
                data=request.body,
                headers=dict(request.headers),
                timeout=120
            )
            response.raise_for_status()
            
            final_result = response.json()
            
            # Parse final status
            try:
                final_content = final_result.get('result', {}).get('content', [])
                if final_content and final_content[0].get('type') == 'text':
                    final_inner = json.loads(final_content[0].get('text', '{}'))
                    final_status = final_inner.get('status', '')
                    
                    # Check for errors in tool results
                    update_error = None
                    for item in final_inner.get('content', []):
                        if item.get('type') == 'serverToolResult':
                            output = item.get('content', {}).get('output', '')
                            try:
                                output_data = json.loads(output)
                                update_resp = output_data.get('UpdateOpportunity', {}).get('response', {})
                                if 'error' in update_resp:
                                    error_info = update_resp['error']
                                    update_error = error_info.get('message', str(error_info))
                            except (json.JSONDecodeError, TypeError, AttributeError):
                                if 'error' in output.lower():
                                    update_error = output
                    
                    if update_error:
                        print("\n" + "="*60)
                        print("❌ UPDATE FAILED")
                        print("="*60)
                        print(f"Error: {update_error}")
                        print("="*60)
                    elif final_status == 'complete' and not update_error:
                        print("\n✅ Update approved and completed!")
                    elif decision == 'reject':
                        print("\n❌ Update rejected by user.")
            except Exception as parse_err:
                logger.warning(f"Could not parse final status: {parse_err}")
            
            return final_result
            
        except Exception as e:
            logger.error(f"Error in approval flow: {e}")
            return mcp_response


class MarketplaceCatalogClient:
    """
    AWS Marketplace Catalog API client for read-only operations.
    
    Provides access to DescribeEntity and ListEntities from the AWS Marketplace
    Catalog API, enabling queries about products, offers (including private offers),
    and other Marketplace entities.
    
    Required IAM permissions:
        - aws-marketplace:DescribeEntity
        - aws-marketplace:ListEntities
    
    Or use the managed policy: AWSMarketplaceSellerProductsReadOnly
    """
    
    def __init__(self, region: str = 'us-east-1'):
        self.region = region
        self._client = None
    
    @property
    def client(self):
        """Get Marketplace Catalog boto3 client (lazy initialization)"""
        if self._client is None:
            import boto3
            self._client = boto3.client(
                'marketplace-catalog',
                region_name=self.region
            )
        return self._client
    
    def list_entities(self, entity_type: str, max_results: int = 10, 
                      filters: List[Dict] = None, sort: Dict = None) -> Dict:
        """
        List entities of a given type in AWS Marketplace.
        
        Args:
            entity_type: Type of entity (e.g., 'Offer', 'AmiProduct', 'SaaSProduct',
                        'ContainerProduct', 'DataProduct', 'Experience')
            max_results: Maximum number of results to return (1-50)
            filters: Optional list of filter objects for narrowing results
            sort: Optional sort configuration
            
        Returns:
            Dict with 'EntitySummaryList' containing matched entities
        """
        try:
            params = {
                'Catalog': 'AWSMarketplace',
                'EntityType': entity_type,
                'MaxResults': min(max_results, 50)
            }
            
            if filters:
                params['EntityTypeFilters'] = filters
            if sort:
                params['EntityTypeSort'] = sort
            
            response = self.client.list_entities(**params)
            
            entity_count = len(response.get('EntitySummaryList', []))
            logger.info(f"Listed {entity_count} {entity_type} entities from Marketplace Catalog")
            
            return {
                'success': True,
                'entity_type': entity_type,
                'entities': response.get('EntitySummaryList', []),
                'next_token': response.get('NextToken')
            }
            
        except Exception as e:
            logger.error(f"Error listing {entity_type} entities: {e}")
            return {
                'success': False,
                'error': str(e),
                'entity_type': entity_type,
                'entities': []
            }
    
    def describe_entity(self, entity_id: str) -> Dict:
        """
        Describe a specific entity in AWS Marketplace.
        
        Args:
            entity_id: The unique identifier of the entity (e.g., offer ID, product ID)
            
        Returns:
            Dict with full entity details including type, ARN, and details document
        """
        try:
            response = self.client.describe_entity(
                Catalog='AWSMarketplace',
                EntityId=entity_id
            )
            
            logger.info(f"Described entity {entity_id} (type: {response.get('EntityType')})")
            
            # Parse the details JSON if present
            details = response.get('DetailsDocument') or response.get('Details')
            if isinstance(details, str):
                try:
                    details = json.loads(details)
                except json.JSONDecodeError:
                    pass
            
            return {
                'success': True,
                'entity_id': entity_id,
                'entity_type': response.get('EntityType'),
                'entity_arn': response.get('EntityArn'),
                'last_modified_date': response.get('LastModifiedDate'),
                'details': details
            }
            
        except Exception as e:
            logger.error(f"Error describing entity {entity_id}: {e}")
            return {
                'success': False,
                'error': str(e),
                'entity_id': entity_id
            }
    
    def list_offers(self, max_results: int = 10, **filters) -> Dict:
        """
        List offers (including private offers) with optional filters.
        
        Supports all OfferFilters from the AWS Marketplace Catalog API:
        https://docs.aws.amazon.com/marketplace/latest/APIReference/API_OfferFilters.html
        
        Args:
            max_results: Maximum number of results (1-50)
            **filters: Optional keyword filters. Supported filter names:
                - targeting: str or list — e.g., "BuyerAccounts" or "None" (public)
                - state: str or list — e.g., "Released", "Draft"
                - product_id: str or list — filter by product ID
                - buyer_accounts: str or list — filter by buyer account ID(s)
                - name: str or list — filter by offer name (wildcard supported)
                - entity_id: str or list — filter by entity ID
                - release_date: dict — {"AfterValue": "2024-01-01", "BeforeValue": "2024-12-31"}
                - last_modified_date: dict — {"AfterValue": "...", "BeforeValue": "..."}
                - availability_end_date: dict — {"AfterValue": "...", "BeforeValue": "..."}
                - resale_authorization_id: str or list — filter by resale auth ID
                
        Returns:
            Dict with 'entities' list and metadata
            
        Examples:
            # List private offers only
            client.list_offers(targeting="BuyerAccounts")
            
            # List offers for a specific product
            client.list_offers(product_id="prod-abcdef123456")
            
            # List released offers targeting specific buyer
            client.list_offers(state="Released", buyer_accounts="123456789012")
            
            # List offers by name (wildcard)
            client.list_offers(name="Enterprise*")
        """
        offer_filters = self._build_offer_filters(**filters) if filters else None
        return self.list_entities('Offer', max_results=max_results, filters=offer_filters)
    
    def _build_offer_filters(self, **kwargs) -> Dict:
        """
        Build the OfferFilters structure for the ListEntities API.
        
        Converts user-friendly keyword arguments into the nested API format:
        {"OfferFilters": {"Targeting": {"ValueList": ["BuyerAccounts"]}, ...}}
        """
        offer_filters = {}
        
        # Simple ValueList filters (string or list → {"ValueList": [...]})
        value_list_mappings = {
            'targeting': 'Targeting',
            'state': 'State',
            'product_id': 'ProductId',
            'buyer_accounts': 'BuyerAccounts',
            'entity_id': 'EntityId',
            'resale_authorization_id': 'ResaleAuthorizationId',
        }
        
        for kwarg_name, api_name in value_list_mappings.items():
            value = kwargs.get(kwarg_name)
            if value is not None:
                if isinstance(value, str):
                    value = [value]
                offer_filters[api_name] = {"ValueList": value}
        
        # Wildcard filter (Name supports wildcards)
        name_value = kwargs.get('name')
        if name_value is not None:
            if isinstance(name_value, str):
                name_value = [name_value]
            # Name uses WildCardValue for pattern matching
            if any('*' in v or '?' in v for v in name_value):
                offer_filters['Name'] = {"WildCardValue": name_value[0]}
            else:
                offer_filters['Name'] = {"ValueList": name_value}
        
        # Date range filters (dict with AfterValue/BeforeValue)
        date_mappings = {
            'release_date': 'ReleaseDate',
            'last_modified_date': 'LastModifiedDate',
            'availability_end_date': 'AvailabilityEndDate',
        }
        
        for kwarg_name, api_name in date_mappings.items():
            value = kwargs.get(kwarg_name)
            if value is not None and isinstance(value, dict):
                date_filter = {}
                if 'AfterValue' in value:
                    date_filter['AfterValue'] = value['AfterValue']
                if 'BeforeValue' in value:
                    date_filter['BeforeValue'] = value['BeforeValue']
                if date_filter:
                    offer_filters[api_name] = {"DateRange": date_filter}
        
        return {"OfferFilters": offer_filters} if offer_filters else None
    
    def list_products(self, product_type: str = 'SaaSProduct', max_results: int = 10) -> Dict:
        """
        List products of a given type.
        
        Args:
            product_type: One of 'AmiProduct', 'SaaSProduct', 'ContainerProduct', 'DataProduct'
            max_results: Maximum results to return
        """
        return self.list_entities(product_type, max_results=max_results)
    
    def describe_offer(self, offer_id: str) -> Dict:
        """Describe a specific offer (public or private) by its ID."""
        return self.describe_entity(offer_id)
    
    def describe_product(self, product_id: str) -> Dict:
        """Describe a specific product by its ID."""
        return self.describe_entity(product_id)


class OrchestratorAgent:
    """Main orchestrator that coordinates all components"""
    
    def __init__(self, config_path: str = None, hubspot_token: str = None,
                 salesforce_token: str = None, salesforce_instance_url: str = None,
                 pipedrive_token: str = None, pipedrive_instance_url: str = None):
        self.slack_reader = SlackReader()
        self.file_reader = FileReader()
        self.next_steps_generator = NextStepsGenerator()
        self.mcp_client = PartnerCentralMCPClient(config_path)
        self.hubspot_client = HubSpotClient(hubspot_token)
        self.salesforce_client = SalesforceClient(salesforce_token, salesforce_instance_url)
        self.pipedrive_client = PipedriveClient(pipedrive_token, pipedrive_instance_url)
        self.marketplace_client = MarketplaceCatalogClient(
            region=self.mcp_client.config.get('region', 'us-east-1')
        )
    
    def gather_context(
        self,
        slack_channels: List[str] = None,
        local_folders: List[str] = None,
        uploaded_files: List[str] = None
    ) -> List[ContextSource]:
        """Gather context from all specified sources"""
        sources = []
        
        # Read from Slack channels
        if slack_channels:
            for channel in slack_channels:
                logger.info(f"Reading Slack channel: {channel}")
                source = self.slack_reader.read_channel(channel)
                sources.append(source)
        
        # Read from local folders
        if local_folders:
            for folder in local_folders:
                logger.info(f"Reading local folder: {folder}")
                folder_sources = self.file_reader.read_folder(folder)
                sources.extend(folder_sources)
        
        # Read uploaded files
        if uploaded_files:
            for file_path in uploaded_files:
                logger.info(f"Reading uploaded file: {file_path}")
                source = self.file_reader.read_file(file_path)
                sources.append(source)
        
        logger.info(f"Gathered {len(sources)} context sources")
        return sources
    
    def run(
        self,
        opportunity_id: str,
        prompt: str,
        slack_channels: List[str] = None,
        local_folders: List[str] = None,
        uploaded_files: List[str] = None,
        update_opportunity: bool = True,
        auto_approve: bool = False,
    ) -> AgentResult:
        """
        Run the full agent workflow:
        1. Gather context from sources
        2. Fetch current opportunity data
        3. Generate next steps using AI
        4. Update opportunity via MCP
        
        When `auto_approve` is True, the MCP update skips the interactive
        y/n approval prompt and applies the change directly. Use this for
        non-interactive callers (REST API, CI jobs, scheduled scripts)
        where there's no human at a terminal to type 'y'.
        """
        try:
            logger.info(f"Starting orchestrator for opportunity: {opportunity_id}")
            
            # Step 1: Gather context (optional - opportunity data alone may be sufficient)
            context_sources = self.gather_context(
                slack_channels=slack_channels,
                local_folders=local_folders,
                uploaded_files=uploaded_files
            )
            
            if not context_sources:
                logger.info("No external context provided - using opportunity data only")
            
            # Step 2: Fetch opportunity data
            logger.info(f"Fetching opportunity data: {opportunity_id}")
            opportunity_data = self.mcp_client.get_opportunity(opportunity_id)
            
            # Step 3: Generate next steps
            logger.info("Generating next steps with AI...")
            next_steps = self.next_steps_generator.generate(
                context_sources=context_sources,
                prompt=prompt,
                opportunity_data=opportunity_data
            )
            
            logger.info(f"Generated next steps:\n{next_steps}")
            
            # Step 4: Update opportunity via MCP
            mcp_response = None
            if update_opportunity:
                logger.info(f"Updating opportunity {opportunity_id} via MCP...")
                mcp_response = self.mcp_client.update_next_steps(
                    opportunity_id,
                    next_steps,
                    interactive=not auto_approve,
                    auto_approve=auto_approve,
                )
                
                if "error" in mcp_response:
                    logger.warning(f"MCP update warning: {mcp_response['error']}")
                else:
                    logger.info("Opportunity updated successfully")
            
            return AgentResult(
                success=True,
                next_steps=next_steps,
                context_sources=context_sources,
                mcp_response=mcp_response
            )
            
        except Exception as e:
            logger.error(f"Orchestrator error: {e}")
            return AgentResult(
                success=False,
                next_steps="",
                context_sources=[],
                error=str(e)
            )
    
    def create_opportunity_from_hubspot(self, deal_id: str, project_title: str = None) -> Dict:
        """
        Create an ACE opportunity from a HubSpot deal:
        1. Fetch deal data from HubSpot API
        2. Map deal fields to Partner Central opportunity fields
        3. Create opportunity via Partner Central Selling API
        """
        try:
            logger.info(f"Fetching HubSpot deal: {deal_id}")
            
            # Step 1: Get deal from HubSpot
            deal = self.hubspot_client.get_deal(deal_id)
            
            if not deal:
                return {
                    "success": False,
                    "error": f"Could not fetch HubSpot deal: {deal_id}"
                }
            
            logger.info(f"Found deal: {deal.deal_name} ({deal.company_name})")
            logger.info(f"  Amount: ${deal.amount:,.2f}")
            logger.info(f"  Stage: {deal.stage}")
            logger.info(f"  Contact: {deal.contact_name} ({deal.contact_email})")
            
            # Step 2: Create opportunity in Partner Central
            result = self.mcp_client.create_opportunity(deal, project_title)
            
            if result.get("success"):
                logger.info(f"✅ ACE Opportunity created: {result.get('opportunity_id')}")
            else:
                logger.error(f"❌ Failed to create opportunity: {result.get('error')}")
            
            return {
                "success": result.get("success", False),
                "hubspot_deal": {
                    "id": deal.deal_id,
                    "name": deal.deal_name,
                    "company": deal.company_name,
                    "amount": deal.amount
                },
                "ace_opportunity_id": result.get("opportunity_id"),
                "error": result.get("error")
            }
            
        except Exception as e:
            logger.error(f"Error creating opportunity from HubSpot: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def list_hubspot_deals(self, limit: int = 10) -> List[HubSpotDeal]:
        """List recent HubSpot deals"""
        return self.hubspot_client.list_deals(limit)
    
    def create_opportunity_from_salesforce(self, opportunity_id: str, project_title: str = None) -> Dict:
        """
        Create an ACE opportunity from a Salesforce opportunity:
        1. Fetch opportunity data from Salesforce API
        2. Map opportunity fields to Partner Central opportunity fields
        3. Create opportunity via Partner Central Selling API
        """
        try:
            logger.info(f"Fetching Salesforce opportunity: {opportunity_id}")
            
            # Step 1: Get opportunity from Salesforce
            opp = self.salesforce_client.get_opportunity(opportunity_id)
            
            if not opp:
                return {
                    "success": False,
                    "error": f"Could not fetch Salesforce opportunity: {opportunity_id}"
                }
            
            logger.info(f"Found opportunity: {opp.name} ({opp.account_name})")
            logger.info(f"  Amount: ${opp.amount:,.2f}")
            logger.info(f"  Stage: {opp.stage}")
            logger.info(f"  Contact: {opp.contact_name} ({opp.contact_email})")
            
            # Step 2: Create opportunity in Partner Central
            result = self.mcp_client.create_opportunity_from_salesforce(opp, project_title)
            
            if result.get("success"):
                logger.info(f"✅ ACE Opportunity created: {result.get('opportunity_id')}")
            else:
                logger.error(f"❌ Failed to create opportunity: {result.get('error')}")
            
            return {
                "success": result.get("success", False),
                "salesforce_opportunity": {
                    "id": opp.opportunity_id,
                    "name": opp.name,
                    "account": opp.account_name,
                    "amount": opp.amount
                },
                "ace_opportunity_id": result.get("opportunity_id"),
                "error": result.get("error")
            }
            
        except Exception as e:
            logger.error(f"Error creating opportunity from Salesforce: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def list_salesforce_opportunities(self, limit: int = 10) -> List[SalesforceOpportunity]:
        """List recent Salesforce opportunities"""
        return self.salesforce_client.list_opportunities(limit)
    
    def create_opportunity_from_pipedrive(self, deal_id: str, project_title: str = None) -> Dict:
        """
        Create an ACE opportunity from a Pipedrive deal.

        Args:
            deal_id: Pipedrive deal numeric ID.
            project_title: Optional custom title for the ACE opportunity.

        Returns:
            Dict with success status, ACE opportunity ID, and any errors.
        """
        try:
            logger.info(f"Fetching Pipedrive deal: {deal_id}")

            deal = self.pipedrive_client.get_deal(deal_id)
            if not deal:
                return {
                    "success": False,
                    "error": f"Could not fetch Pipedrive deal: {deal_id}",
                }

            logger.info(f"Found deal: {deal.title} ({deal.org_name})")
            logger.info(f"  Value: ${deal.value:,.2f}")
            logger.info(f"  Stage: {deal.stage}")
            logger.info(f"  Contact: {deal.contact_name} ({deal.contact_email})")

            result = self.mcp_client.create_opportunity_from_pipedrive(deal, project_title)

            if result.get("success"):
                logger.info(f"✅ ACE Opportunity created: {result.get('opportunity_id')}")
            else:
                logger.error(f"❌ Failed to create opportunity: {result.get('error')}")

            return {
                "success": result.get("success", False),
                "pipedrive_deal": {
                    "id": deal.deal_id,
                    "name": deal.title,
                    "organization": deal.org_name,
                    "amount": deal.value,
                },
                "ace_opportunity_id": result.get("opportunity_id"),
                "error": result.get("error"),
            }

        except Exception as e:
            logger.error(f"Error creating opportunity from Pipedrive: {e}")
            return {
                "success": False,
                "error": str(e),
            }

    def list_pipedrive_deals(self, limit: int = 10):
        """List recent Pipedrive deals."""
        return self.pipedrive_client.list_deals(limit)

    def sync_to_hubspot(self, opportunity_id: str, hubspot_deal_id: str) -> Dict:
        """
        Sync Partner Central opportunity status back to HubSpot deal.
        
        This enables bi-directional sync:
        - When PC opportunity status changes (e.g., Approved, Rejected)
        - Update the corresponding HubSpot deal stage
        
        Args:
            opportunity_id: Partner Central opportunity ID
            hubspot_deal_id: HubSpot deal ID to update
            
        Returns:
            Dict with sync result including success status and updated properties
        """
        try:
            from crm.hubspot_mapper import HubSpotSyncClient
            
            logger.info(f"Syncing PC opportunity {opportunity_id} to HubSpot deal {hubspot_deal_id}")
            
            # Initialize sync client with HubSpot token
            if not self.hubspot_client.bearer_token:
                return {
                    "success": False,
                    "error": "HubSpot bearer token not configured"
                }
            
            sync_client = HubSpotSyncClient(self.hubspot_client.bearer_token)
            
            # Perform sync using PC client to fetch opportunity
            result = sync_client.check_and_sync(
                deal_id=hubspot_deal_id,
                opportunity_id=opportunity_id,
                pc_client=self.mcp_client
            )
            
            if result.get("success"):
                logger.info(f"✅ Successfully synced to HubSpot deal {hubspot_deal_id}")
                sync_status = result.get("sync_status", {})
                logger.info(f"  PC Status: {sync_status.get('review_status')} / {sync_status.get('stage')}")
                logger.info(f"  HubSpot Stage: {sync_status.get('recommended_hubspot_stage')}")
            else:
                logger.error(f"❌ Sync failed: {result.get('error')}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error syncing to HubSpot: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    def check_and_sync_opportunity(self, opportunity_id: str, hubspot_deal_id: str = None) -> Dict:
        """
        Check opportunity status and optionally sync to HubSpot.
        
        Useful for checking if an opportunity is approved/rejected and
        automatically updating the HubSpot deal stage.
        
        Args:
            opportunity_id: Partner Central opportunity ID
            hubspot_deal_id: Optional HubSpot deal ID (if not provided, only checks status)
            
        Returns:
            Dict with opportunity status and optional sync result
        """
        try:
            # Get opportunity status
            opportunity = self.mcp_client.get_opportunity(opportunity_id)
            
            if not opportunity:
                return {
                    "success": False,
                    "error": f"Could not fetch opportunity {opportunity_id}"
                }
            
            lifecycle = opportunity.get('LifeCycle', {})
            result = {
                "success": True,
                "opportunity_id": opportunity_id,
                "review_status": lifecycle.get('ReviewStatus'),
                "stage": lifecycle.get('Stage'),
                "next_steps": lifecycle.get('NextSteps', '')[:100] + '...' if lifecycle.get('NextSteps') else None
            }
            
            # If HubSpot deal ID provided, sync the status
            if hubspot_deal_id:
                sync_result = self.sync_to_hubspot(opportunity_id, hubspot_deal_id)
                result["hubspot_sync"] = sync_result
            
            return result
            
        except Exception as e:
            logger.error(f"Error checking opportunity: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    # --- CRM Sync (ACE → CRM) methods ---
    
    def sync_to_salesforce(self, opportunity_id: str, sf_opportunity_id: str) -> Dict:
        """
        Sync Partner Central opportunity status back to Salesforce opportunity.
        
        Args:
            opportunity_id: Partner Central opportunity ID
            sf_opportunity_id: Salesforce opportunity ID to update
            
        Returns:
            Dict with sync result including success status and updated fields
        """
        try:
            from crm.salesforce_mapper import SalesforceSyncClient
            
            logger.info(f"Syncing PC opportunity {opportunity_id} to Salesforce opportunity {sf_opportunity_id}")
            
            if not self.salesforce_client.bearer_token:
                return {
                    "success": False,
                    "error": "Salesforce access token not configured"
                }
            
            sync_client = SalesforceSyncClient(
                bearer_token=self.salesforce_client.bearer_token,
                instance_url=self.salesforce_client.instance_url
            )
            
            result = sync_client.check_and_sync(
                sf_opportunity_id=sf_opportunity_id,
                pc_opportunity_id=opportunity_id,
                pc_client=self.mcp_client
            )
            
            if result.get("success"):
                logger.info(f"✅ Successfully synced to Salesforce opportunity {sf_opportunity_id}")
            else:
                logger.error(f"❌ Sync failed: {result.get('error')}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error syncing to Salesforce: {e}")
            return {"success": False, "error": str(e)}
    
    def sync_to_pipedrive(self, opportunity_id: str, pipedrive_deal_id: str) -> Dict:
        """
        Sync Partner Central opportunity status back to Pipedrive deal.
        
        Args:
            opportunity_id: Partner Central opportunity ID
            pipedrive_deal_id: Pipedrive deal ID to update
            
        Returns:
            Dict with sync result including success status and updated fields
        """
        try:
            from crm.pipedrive_mapper import PipedriveSyncClient
            
            logger.info(f"Syncing PC opportunity {opportunity_id} to Pipedrive deal {pipedrive_deal_id}")
            
            if not self.pipedrive_client.bearer_token:
                return {
                    "success": False,
                    "error": "Pipedrive API token not configured"
                }
            
            sync_client = PipedriveSyncClient(
                api_token=self.pipedrive_client.bearer_token,
                instance_url=self.pipedrive_client.instance_url
            )
            
            result = sync_client.check_and_sync(
                deal_id=pipedrive_deal_id,
                pc_opportunity_id=opportunity_id,
                pc_client=self.mcp_client
            )
            
            if result.get("success"):
                logger.info(f"✅ Successfully synced to Pipedrive deal {pipedrive_deal_id}")
            else:
                logger.error(f"❌ Sync failed: {result.get('error')}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error syncing to Pipedrive: {e}")
            return {"success": False, "error": str(e)}
    
    # --- AWS Marketplace Catalog methods ---
    
    def list_marketplace_offers(self, max_results: int = 10, **filters) -> Dict:
        """List offers (including private offers) from AWS Marketplace Catalog with optional filters."""
        return self.marketplace_client.list_offers(max_results=max_results, **filters)
    
    def list_marketplace_products(self, product_type: str = 'SaaSProduct', max_results: int = 10) -> Dict:
        """List products of a given type from AWS Marketplace Catalog."""
        return self.marketplace_client.list_products(product_type=product_type, max_results=max_results)
    
    def describe_marketplace_entity(self, entity_id: str) -> Dict:
        """Describe a specific entity (offer, product, etc.) from AWS Marketplace Catalog."""
        return self.marketplace_client.describe_entity(entity_id)

    def find_ao_opportunities(self, since_days: int = 180, limit: int = 100) -> List[Dict]:
        """Find AWS-originated opportunities (Origin = 'AWS Referral').

        Demonstrates the value of a custom orchestrator: the Partner Central
        Agent cannot reliably filter the pipeline by Origin = 'AWS Referral',
        but the orchestrator can chain ListOpportunities + GetAwsOpportunitySummary
        + GetOpportunity to do it. See PartnerCentralMCPClient.find_ao_opportunities
        for the full implementation.
        """
        return self.mcp_client.find_ao_opportunities(since_days=since_days, limit=limit)

    def find_engagement_invitations_by_country(self, country_code=None,
                                               since_days: int = 30,
                                               limit: int = 50) -> List[Dict]:
        """Find engagement invitations from AWS, optionally filtered by customer country.

        Demonstrates another custom-orchestrator value-prop: the Partner Central
        Agent has no tool for engagement invitations. The orchestrator chains
        ListEngagementInvitations (with date filter) + GetEngagementInvitation
        (per item) to read the customer country and surfaces invitations from
        AWS scoped to a region/country.
        """
        return self.mcp_client.find_engagement_invitations_by_country(
            country_code=country_code, since_days=since_days, limit=limit
        )


def main():
    """CLI entry point"""
    parser = argparse.ArgumentParser(description='Agent-to-Agent Orchestrator: Next Steps Generator & HubSpot Integration')
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # Update command (existing functionality)
    update_parser = subparsers.add_parser('update', help='Update opportunity next steps')
    update_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    update_parser.add_argument('--prompt', '-p', default='Generate next steps based on the context', help='Prompt for AI')
    update_parser.add_argument('--slack-channel', '-s', action='append', help='Slack channel(s) to read')
    update_parser.add_argument('--local-folder', '-f', action='append', help='Local folder(s) to scan')
    update_parser.add_argument('--upload', '-u', action='append', help='File(s) to upload as context')
    update_parser.add_argument('--dry-run', action='store_true', help='Generate but do not update opportunity')
    update_parser.add_argument(
        '--auto-approve', '-y', action='store_true',
        help='Auto-approve the MCP write so no terminal prompt is needed (use for headless scripts/CI)'
    )
    update_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # HubSpot create command
    hubspot_parser = subparsers.add_parser('hubspot-create', help='Create ACE opportunity from HubSpot deal')
    hubspot_parser.add_argument('--deal-id', '-d', required=True, help='HubSpot Deal ID')
    hubspot_parser.add_argument('--title', '-t', help='Custom project title (defaults to deal name)')
    hubspot_parser.add_argument('--hubspot-token', help='HubSpot bearer token (or set HUBSPOT_BEARER_TOKEN env)')
    hubspot_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # HubSpot list command
    list_parser = subparsers.add_parser('hubspot-list', help='List recent HubSpot deals')
    list_parser.add_argument('--limit', '-l', type=int, default=10, help='Number of deals to list')
    list_parser.add_argument('--hubspot-token', help='HubSpot bearer token (or set HUBSPOT_BEARER_TOKEN env)')
    
    # HubSpot sync command (bi-directional sync: PC → HubSpot)
    sync_parser = subparsers.add_parser('hubspot-sync', help='Sync Partner Central opportunity status to HubSpot deal')
    sync_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    sync_parser.add_argument('--deal-id', '-d', required=True, help='HubSpot Deal ID to update')
    sync_parser.add_argument('--hubspot-token', help='HubSpot bearer token (or set HUBSPOT_BEARER_TOKEN env)')
    sync_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # Salesforce create command
    sf_create_parser = subparsers.add_parser('salesforce-create', help='Create ACE opportunity from Salesforce opportunity')
    sf_create_parser.add_argument('--opportunity-id', '-o', required=True, help='Salesforce Opportunity ID')
    sf_create_parser.add_argument('--title', '-t', help='Custom project title (defaults to opportunity name)')
    sf_create_parser.add_argument('--salesforce-token', help='Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)')
    sf_create_parser.add_argument('--instance-url', help='Salesforce instance URL (or set SALESFORCE_INSTANCE_URL env)')
    sf_create_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # Salesforce list command
    sf_list_parser = subparsers.add_parser('salesforce-list', help='List recent Salesforce opportunities')
    sf_list_parser.add_argument('--limit', '-l', type=int, default=10, help='Number of opportunities to list')
    sf_list_parser.add_argument('--salesforce-token', help='Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)')
    sf_list_parser.add_argument('--instance-url', help='Salesforce instance URL (or set SALESFORCE_INSTANCE_URL env)')
    
    # Salesforce sync command (ACE → Salesforce)
    sf_sync_parser = subparsers.add_parser('salesforce-sync', help='Sync Partner Central opportunity status to Salesforce opportunity')
    sf_sync_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    sf_sync_parser.add_argument('--sf-opportunity-id', '-s', required=True, help='Salesforce Opportunity ID to update')
    sf_sync_parser.add_argument('--salesforce-token', help='Salesforce access token (or set SALESFORCE_ACCESS_TOKEN env)')
    sf_sync_parser.add_argument('--instance-url', help='Salesforce instance URL (or set SALESFORCE_INSTANCE_URL env)')
    sf_sync_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # Pipedrive sync command (ACE → Pipedrive)
    pd_sync_parser = subparsers.add_parser('pipedrive-sync', help='Sync Partner Central opportunity status to Pipedrive deal')
    pd_sync_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
    pd_sync_parser.add_argument('--deal-id', '-d', required=True, help='Pipedrive Deal ID to update')
    pd_sync_parser.add_argument('--pipedrive-token', help='Pipedrive API token (or set PIPEDRIVE_API_TOKEN env)')
    pd_sync_parser.add_argument('--instance-url', help='Pipedrive instance URL (or set PIPEDRIVE_INSTANCE_URL env)')
    pd_sync_parser.add_argument('--config', '-c', help='Path to config.json')
    
    # AWS Marketplace Catalog commands
    mp_list_parser = subparsers.add_parser('marketplace-list', help='List entities from AWS Marketplace Catalog')
    mp_list_parser.add_argument('--entity-type', '-e', default='Offer',
                                choices=['Offer', 'AmiProduct', 'SaaSProduct', 'ContainerProduct', 'DataProduct'],
                                help='Entity type to list (default: Offer)')
    mp_list_parser.add_argument('--limit', '-l', type=int, default=10, help='Number of results to return')
    mp_list_parser.add_argument('--targeting', help='Filter offers by targeting type (e.g., BuyerAccounts, None)')
    mp_list_parser.add_argument('--state', help='Filter offers by state (e.g., Released, Draft)')
    mp_list_parser.add_argument('--product-id', help='Filter offers by product ID')
    mp_list_parser.add_argument('--buyer-accounts', help='Filter offers by buyer account ID (comma-separated for multiple)')
    mp_list_parser.add_argument('--name', help='Filter offers by name (supports wildcards with *)')
    mp_list_parser.add_argument('--config', '-c', help='Path to config.json')
    
    mp_describe_parser = subparsers.add_parser('marketplace-describe', help='Describe a specific AWS Marketplace entity')
    mp_describe_parser.add_argument('--entity-id', '-e', required=True, help='Entity ID to describe (offer ID, product ID, etc.)')
    mp_describe_parser.add_argument('--config', '-c', help='Path to config.json')

    # Ask command — send a question to the Partner Central Agent
    ask_parser = subparsers.add_parser('ask', help='Ask the Partner Central Agent a question')
    ask_parser.add_argument('question', nargs='?', help='Question to ask (or use --prompt)')
    ask_parser.add_argument('--prompt', '-p', help='Question to ask the Partner Central Agent')
    ask_parser.add_argument('--opportunity-id', '-o', help='Opportunity ID for context (optional)')
    ask_parser.add_argument('--config', '-c', help='Path to config.json')

    # Legacy support: if the first CLI argument starts with '-' (a flag like
    # --opportunity-id), it's not a subcommand — go straight to legacy mode.
    # This lets users run:
    #   python orchestrator_agent.py --opportunity-id O123 --upload file.txt
    # without the explicit 'update' subcommand.
        
    if len(sys.argv) > 1 and sys.argv[1].startswith('-'):
        # Legacy mode: treat as 'update' command
        legacy_parser = argparse.ArgumentParser(description='Agent-to-Agent Next Steps Generator')
        legacy_parser.add_argument('--opportunity-id', '-o', required=True, help='Partner Central Opportunity ID')
        legacy_parser.add_argument('--prompt', '-p', default='Generate next steps based on the context', help='Prompt for AI')
        legacy_parser.add_argument('--slack-channel', '-s', action='append', help='Slack channel(s) to read')
        legacy_parser.add_argument('--local-folder', '-f', action='append', help='Local folder(s) to scan')
        legacy_parser.add_argument('--upload', '-u', action='append', help='File(s) to upload as context')
        legacy_parser.add_argument('--dry-run', action='store_true', help='Generate but do not update opportunity')
        legacy_parser.add_argument(
            '--auto-approve', '-y', action='store_true',
            help='Auto-approve the MCP write so no terminal prompt is needed (use for headless scripts/CI)'
        )
        legacy_parser.add_argument('--config', '-c', help='Path to config.json')
        args = legacy_parser.parse_args()
        args.command = 'update'
    else:
        args = parser.parse_args()
        if args.command is None:
            parser.print_help()
            sys.exit(1)
    
    if args.command == 'update':
        agent = OrchestratorAgent(config_path=args.config)
        
        result = agent.run(
            opportunity_id=args.opportunity_id,
            prompt=args.prompt,
            slack_channels=args.slack_channel,
            local_folders=args.local_folder,
            uploaded_files=args.upload,
            update_opportunity=not args.dry_run,
            auto_approve=getattr(args, 'auto_approve', False),
        )
        
        print("\n" + "="*60)
        print("ORCHESTRATOR AGENT RESULT")
        print("="*60)
        print(f"Success: {result.success}")
        print(f"Context Sources: {len(result.context_sources)}")
        print(f"\nGenerated Next Steps:\n{result.next_steps}")
        
        if result.mcp_response:
            try:
                content = result.mcp_response.get('result', {}).get('content', [])
                if content and content[0].get('type') == 'text':
                    inner = json.loads(content[0].get('text', '{}'))
                    status = inner.get('status', 'unknown')
                    print(f"\nMCP Status: {status}")
                    if status == 'requires_approval':
                        print("⏳ Partner Central Agent is waiting for human approval to update the opportunity.")
                    elif status == 'complete':
                        print("✅ Opportunity update completed.")
            except Exception:
                pass
            
            if 'error' in result.mcp_response:
                print(f"\nMCP Error: {result.mcp_response['error']}")
        
        if result.error:
            print(f"\nError: {result.error}")
        
        return 0 if result.success else 1
    
    elif args.command == 'hubspot-create':
        hubspot_token = args.hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            print("❌ Error: HubSpot bearer token required. Use --hubspot-token or set HUBSPOT_BEARER_TOKEN env var.")
            return 1
        
        agent = OrchestratorAgent(config_path=args.config, hubspot_token=hubspot_token)
        
        print("\n" + "="*60)
        print("HUBSPOT → ACE OPPORTUNITY CREATION")
        print("="*60)
        
        result = agent.create_opportunity_from_hubspot(
            deal_id=args.deal_id,
            project_title=args.title
        )
        
        if result.get("success"):
            print("\n✅ SUCCESS!")
            print(f"HubSpot Deal: {result['hubspot_deal']['name']} ({result['hubspot_deal']['company']})")
            print(f"Deal Amount: ${result['hubspot_deal']['amount']:,.2f}")
            print(f"ACE Opportunity ID: {result['ace_opportunity_id']}")
        else:
            print(f"\n❌ FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'hubspot-list':
        hubspot_token = args.hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            print("❌ Error: HubSpot bearer token required. Use --hubspot-token or set HUBSPOT_BEARER_TOKEN env var.")
            return 1
        
        agent = OrchestratorAgent(hubspot_token=hubspot_token)
        deals = agent.list_hubspot_deals(limit=args.limit)
        
        print("\n" + "="*60)
        print("HUBSPOT DEALS")
        print("="*60)
        
        if not deals:
            print("No deals found.")
            return 0
        
        for deal in deals:
            print(f"\n📋 {deal.deal_name}")
            print(f"   ID: {deal.deal_id}")
            print(f"   Amount: ${deal.amount:,.2f}")
            print(f"   Stage: {deal.stage}")
            if deal.close_date:
                print(f"   Close Date: {deal.close_date}")
        
        print(f"\n💡 To create an ACE opportunity from a deal:")
        print(f"   python orchestrator_agent.py hubspot-create -d <DEAL_ID>")
        
        return 0
    
    elif args.command == 'hubspot-sync':
        hubspot_token = args.hubspot_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        if not hubspot_token:
            print("❌ Error: HubSpot bearer token required. Use --hubspot-token or set HUBSPOT_BEARER_TOKEN env var.")
            return 1
        
        agent = OrchestratorAgent(config_path=args.config, hubspot_token=hubspot_token)
        
        print("\n" + "="*60)
        print("PARTNER CENTRAL → HUBSPOT SYNC")
        print("="*60)
        print(f"Opportunity ID: {args.opportunity_id}")
        print(f"HubSpot Deal ID: {args.deal_id}")
        print("="*60)
        
        result = agent.sync_to_hubspot(
            opportunity_id=args.opportunity_id,
            hubspot_deal_id=args.deal_id
        )
        
        if result.get("success"):
            print("\n✅ SYNC SUCCESSFUL!")
            sync_status = result.get("sync_status", {})
            print(f"PC Review Status: {sync_status.get('review_status')}")
            print(f"PC Stage: {sync_status.get('stage')}")
            print(f"HubSpot Stage Updated To: {sync_status.get('recommended_hubspot_stage')}")
            
            updated_props = result.get("updated_properties", {})
            if updated_props:
                print("\nUpdated HubSpot Properties:")
                for key, value in updated_props.items():
                    print(f"  {key}: {value}")
        else:
            print(f"\n❌ SYNC FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'salesforce-create':
        salesforce_token = args.salesforce_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        instance_url = args.instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        
        if not salesforce_token:
            print("❌ Error: Salesforce access token required. Use --salesforce-token or set SALESFORCE_ACCESS_TOKEN env var.")
            return 1
        
        if not instance_url:
            print("❌ Error: Salesforce instance URL required. Use --instance-url or set SALESFORCE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            config_path=args.config,
            salesforce_token=salesforce_token,
            salesforce_instance_url=instance_url
        )
        
        print("\n" + "="*60)
        print("SALESFORCE → ACE OPPORTUNITY CREATION")
        print("="*60)
        
        result = agent.create_opportunity_from_salesforce(
            opportunity_id=args.opportunity_id,
            project_title=args.title
        )
        
        if result.get("success"):
            print("\n✅ SUCCESS!")
            sf_opp = result.get('salesforce_opportunity', {})
            print(f"Salesforce Opportunity: {sf_opp.get('name')} ({sf_opp.get('account')})")
            print(f"Amount: ${sf_opp.get('amount', 0):,.2f}")
            print(f"ACE Opportunity ID: {result['ace_opportunity_id']}")
        else:
            print(f"\n❌ FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'salesforce-list':
        salesforce_token = args.salesforce_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        instance_url = args.instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        
        if not salesforce_token:
            print("❌ Error: Salesforce access token required. Use --salesforce-token or set SALESFORCE_ACCESS_TOKEN env var.")
            return 1
        
        if not instance_url:
            print("❌ Error: Salesforce instance URL required. Use --instance-url or set SALESFORCE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            salesforce_token=salesforce_token,
            salesforce_instance_url=instance_url
        )
        opportunities = agent.list_salesforce_opportunities(limit=args.limit)
        
        print("\n" + "="*60)
        print("SALESFORCE OPPORTUNITIES")
        print("="*60)
        
        if not opportunities:
            print("No opportunities found.")
            return 0
        
        for opp in opportunities:
            print(f"\n📋 {opp.name}")
            print(f"   ID: {opp.opportunity_id}")
            print(f"   Amount: ${opp.amount:,.2f}")
            print(f"   Stage: {opp.stage}")
            if opp.close_date:
                print(f"   Close Date: {opp.close_date}")
        
        print(f"\n💡 To create an ACE opportunity from a Salesforce opportunity:")
        print(f"   python orchestrator_agent.py salesforce-create -o <OPPORTUNITY_ID>")
        
        return 0
    
    elif args.command == 'salesforce-sync':
        salesforce_token = args.salesforce_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        instance_url = args.instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        
        if not salesforce_token:
            print("❌ Error: Salesforce access token required. Use --salesforce-token or set SALESFORCE_ACCESS_TOKEN env var.")
            return 1
        if not instance_url:
            print("❌ Error: Salesforce instance URL required. Use --instance-url or set SALESFORCE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            config_path=args.config,
            salesforce_token=salesforce_token,
            salesforce_instance_url=instance_url
        )
        
        print("\n" + "="*60)
        print("PARTNER CENTRAL → SALESFORCE SYNC")
        print("="*60)
        print(f"PC Opportunity ID: {args.opportunity_id}")
        print(f"Salesforce Opportunity ID: {args.sf_opportunity_id}")
        print("="*60)
        
        result = agent.sync_to_salesforce(
            opportunity_id=args.opportunity_id,
            sf_opportunity_id=args.sf_opportunity_id
        )
        
        if result.get("success"):
            print("\n✅ SYNC SUCCESSFUL!")
            sync_status = result.get("sync_status", {})
            print(f"PC Review Status: {sync_status.get('review_status')}")
            print(f"PC Stage: {sync_status.get('stage')}")
            print(f"Salesforce Stage Updated To: {sync_status.get('recommended_salesforce_stage')}")
            
            updated_fields = result.get("updated_fields", {})
            if updated_fields:
                print("\nUpdated Salesforce Fields:")
                for key, value in updated_fields.items():
                    print(f"  {key}: {value}")
        else:
            print(f"\n❌ SYNC FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'pipedrive-sync':
        pipedrive_token = args.pipedrive_token or os.environ.get('PIPEDRIVE_API_TOKEN')
        instance_url = args.instance_url or os.environ.get('PIPEDRIVE_INSTANCE_URL')
        
        if not pipedrive_token:
            print("❌ Error: Pipedrive API token required. Use --pipedrive-token or set PIPEDRIVE_API_TOKEN env var.")
            return 1
        if not instance_url:
            print("❌ Error: Pipedrive instance URL required. Use --instance-url or set PIPEDRIVE_INSTANCE_URL env var.")
            return 1
        
        agent = OrchestratorAgent(
            config_path=args.config,
            pipedrive_token=pipedrive_token,
            pipedrive_instance_url=instance_url
        )
        
        print("\n" + "="*60)
        print("PARTNER CENTRAL → PIPEDRIVE SYNC")
        print("="*60)
        print(f"PC Opportunity ID: {args.opportunity_id}")
        print(f"Pipedrive Deal ID: {args.deal_id}")
        print("="*60)
        
        result = agent.sync_to_pipedrive(
            opportunity_id=args.opportunity_id,
            pipedrive_deal_id=args.deal_id
        )
        
        if result.get("success"):
            print("\n✅ SYNC SUCCESSFUL!")
            sync_status = result.get("sync_status", {})
            print(f"PC Review Status: {sync_status.get('review_status')}")
            print(f"PC Stage: {sync_status.get('stage')}")
            print(f"Pipedrive Stage Updated To: {sync_status.get('recommended_pipedrive_stage')}")
            
            updated_fields = result.get("updated_fields", {})
            if updated_fields:
                print("\nUpdated Pipedrive Fields:")
                for key, value in updated_fields.items():
                    print(f"  {key}: {value}")
        else:
            print(f"\n❌ SYNC FAILED: {result.get('error')}")
        
        return 0 if result.get("success") else 1
    
    elif args.command == 'marketplace-list':
        agent = OrchestratorAgent(config_path=args.config)
        
        print("\n" + "="*60)
        print(f"AWS MARKETPLACE CATALOG — {args.entity_type} ENTITIES")
        print("="*60)
        
        if args.entity_type == 'Offer':
            # Build filters from CLI arguments
            offer_filters = {}
            if args.targeting:
                offer_filters['targeting'] = args.targeting
            if args.state:
                offer_filters['state'] = args.state
            if args.product_id:
                offer_filters['product_id'] = args.product_id
            if args.buyer_accounts:
                offer_filters['buyer_accounts'] = [a.strip() for a in args.buyer_accounts.split(',')]
            if args.name:
                offer_filters['name'] = args.name
            
            if offer_filters:
                print(f"Filters: {offer_filters}")
            
            result = agent.list_marketplace_offers(max_results=args.limit, **offer_filters)
        else:
            result = agent.list_marketplace_products(product_type=args.entity_type, max_results=args.limit)
        
        if not result.get('success'):
            print(f"\n❌ Error: {result.get('error')}")
            return 1
        
        entities = result.get('entities', [])
        if not entities:
            print(f"No {args.entity_type} entities found.")
            return 0
        
        for entity in entities:
            print(f"\n📦 {entity.get('Name', 'Unnamed')}")
            print(f"   ID: {entity.get('EntityId')}")
            print(f"   Type: {entity.get('EntityType')}")
            if entity.get('Visibility'):
                print(f"   Visibility: {entity.get('Visibility')}")
            if entity.get('LastModifiedDate'):
                print(f"   Last Modified: {entity.get('LastModifiedDate')}")
        
        print(f"\n💡 To describe a specific entity:")
        print(f"   python orchestrator_agent.py marketplace-describe -e <ENTITY_ID>")
        
        return 0
    
    elif args.command == 'marketplace-describe':
        agent = OrchestratorAgent(config_path=args.config)
        
        print("\n" + "="*60)
        print(f"AWS MARKETPLACE CATALOG — ENTITY DETAILS")
        print("="*60)
        
        result = agent.describe_marketplace_entity(entity_id=args.entity_id)
        
        if not result.get('success'):
            print(f"\n❌ Error: {result.get('error')}")
            return 1
        
        print(f"\n📦 Entity: {result.get('entity_id')}")
        print(f"   Type: {result.get('entity_type')}")
        print(f"   ARN: {result.get('entity_arn')}")
        print(f"   Last Modified: {result.get('last_modified_date')}")
        
        details = result.get('details')
        if details:
            print(f"\n   Details:")
            print(f"   {json.dumps(details, indent=2, default=str)[:2000]}")
        
        return 0
    
    elif args.command == 'ask':
        question = args.question or args.prompt
        if not question:
            print("❌ Error: Provide a question as an argument or via --prompt.")
            return 1

        agent = OrchestratorAgent(config_path=args.config)
        config = agent.mcp_client.config
        mcp_endpoint = config['endpoints']['partnercentral_mcp']

        if args.opportunity_id:
            question = f"Regarding opportunity {args.opportunity_id}: {question}"

        import boto3
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

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

        session = boto3.Session()
        credentials = session.get_credentials()

        request = AWSRequest(
            method='POST',
            url=mcp_endpoint,
            data=json.dumps(mcp_payload),
            headers={'Content-Type': 'application/json'}
        )

        service_name = 'partnercentral-agents' if 'gamma' in mcp_endpoint else 'partnercentral-agents-mcp'
        SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(request)

        print(f"\n💬 Asking Partner Central Agent: {question}\n")

        try:
            response = requests.post(
                request.url,
                data=request.body,
                headers=dict(request.headers),
                timeout=120
            )
            response.raise_for_status()
            result = response.json()

            content = result.get('result', {}).get('content', [])
            if content and content[0].get('type') == 'text':
                inner = json.loads(content[0].get('text', '{}'))
                status = inner.get('status', '')
                session_id = inner.get('sessionId', '')

                # Extract agent response
                answer = None
                for item in reversed(inner.get('content', [])):
                    item_type = item.get('type', '')
                    if item_type == 'ASSISTANT_RESPONSE':
                        item_content = item.get('content', {})
                        if isinstance(item_content, dict) and 'text' in item_content:
                            answer = item_content['text']
                            break
                    elif item_type == 'text':
                        answer = item.get('text')
                        break

                if status == 'requires_approval':
                    # Auto-approve read operations, prompt for writes
                    for item in inner.get('content', []):
                        if item.get('type') == 'tool_approval_request':
                            tool_content = item.get('content', {})
                            try:
                                approval_data = json.loads(tool_content.get('text', '{}'))
                                tool_name = approval_data.get('tool_name', '')
                                tool_use_id = approval_data.get('tool_use_id')

                                is_read = any(k in tool_name.lower() for k in ('get', 'list', 'read', 'describe'))

                                if is_read:
                                    decision = 'approve'
                                    print(f"🔄 Auto-approving read operation: {tool_name}")
                                else:
                                    print(f"\n🔐 APPROVAL REQUIRED")
                                    print(f"   Tool: {tool_name}")
                                    while True:
                                        choice = input("\nApprove this action? [y/n]: ").strip().lower()
                                        if choice in ('y', 'yes'):
                                            decision = 'approve'
                                            break
                                        elif choice in ('n', 'no'):
                                            decision = 'reject'
                                            break
                                        print("Please enter 'y' or 'n'")

                                # Send approval
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
                                                "decision": decision
                                            }],
                                            "catalog": config.get('catalog', 'Sandbox'),
                                            "sessionId": session_id
                                        }
                                    }
                                }

                                approval_request = AWSRequest(
                                    method='POST',
                                    url=mcp_endpoint,
                                    data=json.dumps(approval_payload),
                                    headers={'Content-Type': 'application/json'}
                                )
                                SigV4Auth(credentials, service_name, config.get('region', 'us-east-1')).add_auth(approval_request)

                                approval_response = requests.post(
                                    approval_request.url,
                                    data=approval_request.body,
                                    headers=dict(approval_request.headers),
                                    timeout=120
                                )
                                approval_response.raise_for_status()
                                approval_result = approval_response.json()

                                # Extract final answer
                                final_content = approval_result.get('result', {}).get('content', [])
                                if final_content and final_content[0].get('type') == 'text':
                                    final_inner = json.loads(final_content[0].get('text', '{}'))
                                    for fi in reversed(final_inner.get('content', [])):
                                        fi_type = fi.get('type', '')
                                        if fi_type == 'ASSISTANT_RESPONSE':
                                            fi_content = fi.get('content', {})
                                            if isinstance(fi_content, dict) and 'text' in fi_content:
                                                answer = fi_content['text']
                                                break
                                        elif fi_type == 'text':
                                            answer = fi.get('text')
                                            break
                            except Exception as approval_err:
                                logger.warning(f"Error in approval flow: {approval_err}")
                            break

                if answer:
                    print("=" * 60)
                    print("PARTNER CENTRAL AGENT RESPONSE")
                    print("=" * 60)
                    print(f"\n{answer}\n")
                else:
                    print("No response from the agent.")

            return 0

        except Exception as e:
            logger.error(f"Error asking agent: {e}")
            print(f"\n❌ Error: {e}")
            return 1

    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    exit(main())
