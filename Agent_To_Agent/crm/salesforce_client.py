"""Salesforce CRM REST client (fetches opportunities)."""

import os
import logging
from typing import Dict, List, Optional
from crm.salesforce_mapper import SalesforceOpportunity

logger = logging.getLogger(__name__)


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
