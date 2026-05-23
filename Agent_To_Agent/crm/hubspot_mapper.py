#!/usr/bin/env python
"""
HubSpot to Partner Central Data Mapper

This module handles the mapping of HubSpot deal data to AWS Partner Central
opportunity format. Customize this file to match your HubSpot field structure
and Partner Central requirements.

Field Mapping Reference:
------------------------
HubSpot Field              -> Partner Central Field
---------------------------------------------------------
Deal Name                  -> Project.Title
Amount                     -> Project.ExpectedCustomerSpend.Amount
Close Date                 -> LifeCycle.TargetCloseDate
Contact First Name         -> Customer.Contacts[0].FirstName
Contact Last Name          -> Customer.Contacts[0].LastName
Contact Email              -> Customer.Contacts[0].Email
Contact Phone              -> Customer.Contacts[0].Phone
Contact Job Title          -> Customer.Contacts[0].BusinessTitle
Deal ID                    -> PartnerOpportunityIdentifier (prefixed with HS-)
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class HubSpotDeal:
    """Represents a HubSpot deal with all relevant fields"""
    deal_id: str
    deal_name: str
    amount: float
    stage: str
    close_date: str
    company_name: str
    contact_name: str
    contact_email: str
    description: str
    properties: Dict = field(default_factory=dict)


class HubSpotToPartnerCentralMapper:
    """
    Maps HubSpot deal data to Partner Central opportunity format.
    
    Customize this class to:
    - Map additional HubSpot fields
    - Change default values
    - Add validation logic
    - Transform data formats
    """
    
    # Default values - customize these for your organization
    DEFAULT_INDUSTRY = "Software and Internet"
    DEFAULT_WEBSITE = "https://example.com"
    DEFAULT_COUNTRY_CODE = "US"
    DEFAULT_STATE = "Massachusetts"
    DEFAULT_CITY = "Cambridge"
    DEFAULT_POSTAL_CODE = "02139"
    DEFAULT_STREET = "25 First Street"
    DEFAULT_PHONE = "+15550000"
    DEFAULT_BUSINESS_TITLE = "Contact"
    DEFAULT_CUSTOMER_USE_CASE = "Business Applications & Contact Center"
    DEFAULT_DELIVERY_MODEL = "SaaS or PaaS"
    DEFAULT_SALES_ACTIVITY = "Conducted POC / Demo"
    DEFAULT_CURRENCY = "USD"
    DEFAULT_SPEND_FREQUENCY = "Monthly"
    DEFAULT_AMOUNT = "1000"
    
    # Minimum days in future for close date (Partner Central requirement)
    MIN_CLOSE_DATE_DAYS = 7
    
    def __init__(self, catalog: str = "Sandbox"):
        """
        Initialize the mapper.
        
        Args:
            catalog: Partner Central catalog ("Sandbox" or "AWS")
        """
        self.catalog = catalog
    
    def map_deal_to_opportunity(
        self, 
        deal: HubSpotDeal, 
        project_title: Optional[str] = None
    ) -> Dict:
        """
        Map a HubSpot deal to Partner Central opportunity payload.
        
        Args:
            deal: HubSpotDeal object with deal data
            project_title: Optional custom project title (defaults to deal name)
            
        Returns:
            Dict containing the complete Partner Central CreateOpportunity payload
        """
        import time
        timestamp = int(time.time())
        
        # Map customer data
        customer = self._map_customer(deal, timestamp)
        
        # Map project data
        project = self._map_project(deal, project_title, timestamp)
        
        # Map lifecycle data
        lifecycle = self._map_lifecycle(deal)
        
        # Generate unique identifiers
        partner_opp_id = self._generate_partner_opportunity_id(deal, timestamp)
        client_token = self._generate_client_token(deal, timestamp)
        
        # Build complete payload
        payload = {
            "Catalog": self.catalog,
            "ClientToken": client_token,
            "Customer": customer,
            "LifeCycle": lifecycle,
            "Marketing": self._map_marketing(deal),
            "OpportunityType": self._map_opportunity_type(deal),
            "Origin": "Partner Referral",
            "PrimaryNeedsFromAws": self._map_primary_needs(deal),
            "Project": project,
            "PartnerOpportunityIdentifier": partner_opp_id
        }
        
        logger.info(f"Mapped HubSpot deal {deal.deal_id} to Partner Central payload")
        return payload
    
    def _map_customer(self, deal: HubSpotDeal, timestamp: int) -> Dict:
        """Map customer/account information"""
        properties = deal.properties
        
        # Extract contact info
        contact = self._map_contact(deal)
        
        # Build account - customize company name generation as needed
        # Using timestamp ensures uniqueness in Partner Central
        company_name = self._generate_company_name(deal, timestamp)
        
        return {
            "Account": {
                "CompanyName": company_name,
                "Industry": self._map_industry(deal),
                "WebsiteUrl": properties.get('website', self.DEFAULT_WEBSITE),
                "Address": self._map_address(deal)
            },
            "Contacts": [contact]
        }
    
    def _map_contact(self, deal: HubSpotDeal) -> Dict:
        """Map contact information from HubSpot deal"""
        properties = deal.properties
        
        # Get and validate phone number
        raw_phone = properties.get('contact_phone', '')
        phone = self._format_phone_number(raw_phone)
        
        return {
            "FirstName": properties.get('contact_first_name', 'Unknown'),
            "LastName": properties.get('contact_last_name', 'Contact'),
            "Email": deal.contact_email or 'contact@example.com',
            "Phone": phone,
            "BusinessTitle": properties.get('contact_title', self.DEFAULT_BUSINESS_TITLE)
        }
    
    def _format_phone_number(self, phone: str) -> str:
        """
        Format phone number to E.164 format required by Partner Central.
        
        Partner Central requires: +[1-9]\d{1,14} (e.g., +15551234567)
        
        Args:
            phone: Raw phone number from HubSpot
            
        Returns:
            E.164 formatted phone number or default
        """
        import re
        
        if not phone:
            return self.DEFAULT_PHONE
        
        # Remove all non-digit characters except leading +
        cleaned = re.sub(r'[^\d+]', '', str(phone))
        
        # If already in E.164 format, validate and return
        if cleaned.startswith('+'):
            # Validate E.164 pattern: +[1-9]\d{1,14}
            if re.match(r'^\+[1-9]\d{1,14}$', cleaned):
                return cleaned
            else:
                # Try to fix by removing invalid characters after +
                digits_only = re.sub(r'[^\d]', '', cleaned)
                if digits_only and digits_only[0] != '0':
                    return f"+{digits_only[:15]}"
        
        # Remove leading zeros
        cleaned = cleaned.lstrip('0')
        
        if not cleaned:
            return self.DEFAULT_PHONE
        
        # If it's a 10-digit US number, add +1
        if len(cleaned) == 10 and cleaned[0] != '0':
            return f"+1{cleaned}"
        
        # If it's 11 digits starting with 1 (US with country code), add +
        if len(cleaned) == 11 and cleaned[0] == '1':
            return f"+{cleaned}"
        
        # For other formats, assume it needs a + prefix
        if cleaned[0] != '0' and len(cleaned) >= 7 and len(cleaned) <= 15:
            return f"+{cleaned}"
        
        # Fallback to default if we can't parse it
        logger.warning(f"Could not parse phone number '{phone}', using default")
        return self.DEFAULT_PHONE
    
    def _map_address(self, deal: HubSpotDeal) -> Dict:
        """Map address information - customize based on your HubSpot fields"""
        properties = deal.properties
        
        return {
            "CountryCode": properties.get('country_code', self.DEFAULT_COUNTRY_CODE),
            "StateOrRegion": properties.get('state', self.DEFAULT_STATE),
            "City": properties.get('city', self.DEFAULT_CITY),
            "PostalCode": properties.get('postal_code', self.DEFAULT_POSTAL_CODE),
            "StreetAddress": properties.get('street', self.DEFAULT_STREET)
        }
    
    def _map_project(
        self, 
        deal: HubSpotDeal, 
        project_title: Optional[str],
        timestamp: int
    ) -> Dict:
        """Map project information"""
        return {
            "Title": project_title or deal.deal_name,
            "CustomerBusinessProblem": self._map_business_problem(deal),
            "CustomerUseCase": self._map_use_case(deal),
            "OtherSolutionDescription": self._map_solution_description(deal),
            "DeliveryModels": [self._map_delivery_model(deal)],
            "SalesActivities": [self._map_sales_activity(deal)],
            "ExpectedCustomerSpend": [self._map_expected_spend(deal, timestamp)]
        }
    
    def _map_business_problem(self, deal: HubSpotDeal) -> str:
        """
        Map customer business problem.
        
        Customize this to extract from HubSpot custom fields or generate
        based on deal properties.
        """
        # Check for custom field first
        if deal.properties.get('customer_business_problem'):
            return deal.properties['customer_business_problem']
        
        # Check description
        if deal.description:
            return deal.description[:500]  # Truncate if too long
        
        # Default based on deal stage
        stage_problems = {
            'appointmentscheduled': 'Initial discovery - understanding customer needs',
            'qualifiedtobuy': 'Customer has identified need for cloud solution',
            'presentationscheduled': 'Evaluating AWS solutions for business requirements',
            'decisionmakerboughtin': 'Ready to proceed with AWS implementation',
            'contractsent': 'Finalizing terms for AWS engagement',
            'closedwon': 'AWS solution selected',
            'closedlost': 'Opportunity closed'
        }
        
        return stage_problems.get(
            deal.stage.lower().replace(' ', ''), 
            'Deal from HubSpot - New Business'
        )
    
    def _map_use_case(self, deal: HubSpotDeal) -> str:
        """Map customer use case - customize based on your deal types"""
        return deal.properties.get('use_case', self.DEFAULT_CUSTOMER_USE_CASE)
    
    def _map_solution_description(self, deal: HubSpotDeal) -> str:
        """Map solution description"""
        return deal.properties.get('solution_description', 'Partner Solution')
    
    def _map_delivery_model(self, deal: HubSpotDeal) -> str:
        """
        Map delivery model.
        
        Valid values: "SaaS or PaaS", "BYOL or AMI", "Managed Services",
                      "Professional Services", "Resell", "Other"
        """
        return deal.properties.get('delivery_model', self.DEFAULT_DELIVERY_MODEL)
    
    def _map_sales_activity(self, deal: HubSpotDeal) -> str:
        """
        Map sales activity.
        
        Valid values: "Initialized discussions with customer",
                      "Customer has shown interest in solution",
                      "Conducted POC / Demo",
                      "In evaluation / planning stage",
                      "Agreed on solution to Business Problem",
                      "Completed Action Plan",
                      "Finalized Deployment Need",
                      "SOW Signed"
        """
        # Map HubSpot stage to sales activity
        stage_activities = {
            'appointmentscheduled': 'Initialized discussions with customer',
            'qualifiedtobuy': 'Customer has shown interest in solution',
            'presentationscheduled': 'Conducted POC / Demo',
            'decisionmakerboughtin': 'Agreed on solution to Business Problem',
            'contractsent': 'Completed Action Plan',
            'closedwon': 'SOW Signed'
        }
        
        return stage_activities.get(
            deal.stage.lower().replace(' ', ''),
            self.DEFAULT_SALES_ACTIVITY
        )
    
    def _map_expected_spend(self, deal: HubSpotDeal, timestamp: int) -> Dict:
        """Map expected customer spend"""
        amount = str(int(deal.amount)) if deal.amount else self.DEFAULT_AMOUNT
        
        return {
            "Amount": amount,
            "CurrencyCode": deal.properties.get('currency', self.DEFAULT_CURRENCY),
            "Frequency": self.DEFAULT_SPEND_FREQUENCY,
            "TargetCompany": deal.properties.get('target_company', 'AWS')
        }
    
    def _map_lifecycle(self, deal: HubSpotDeal) -> Dict:
        """Map lifecycle information"""
        return {
            "Stage": self._map_stage(deal),
            "ReviewStatus": "Pending Submission",
            "TargetCloseDate": self._map_close_date(deal)
        }
    
    def _map_stage(self, deal: HubSpotDeal) -> str:
        """
        Map HubSpot deal stage to Partner Central stage.
        
        Valid Partner Central stages:
        - Prospect
        - Qualified
        - Technical Validation
        - Business Validation
        - Committed
        - Launched
        - Closed Lost
        """
        stage_mapping = {
            'appointmentscheduled': 'Prospect',
            'qualifiedtobuy': 'Qualified',
            'presentationscheduled': 'Technical Validation',
            'decisionmakerboughtin': 'Business Validation',
            'contractsent': 'Committed',
            'closedwon': 'Launched',
            'closedlost': 'Closed Lost'
        }
        
        return stage_mapping.get(
            deal.stage.lower().replace(' ', ''),
            'Prospect'
        )
    
    def _map_close_date(self, deal: HubSpotDeal) -> str:
        """
        Map close date ensuring it's at least MIN_CLOSE_DATE_DAYS in the future.
        """
        min_close_date = (
            datetime.now() + timedelta(days=self.MIN_CLOSE_DATE_DAYS)
        ).strftime('%Y-%m-%d')
        
        if not deal.close_date:
            return min_close_date
        
        try:
            closedate_str = deal.close_date
            if isinstance(closedate_str, str) and ('T' in closedate_str or '-' in closedate_str):
                parsed_date = datetime.fromisoformat(closedate_str.replace('Z', '+00:00'))
                parsed_date_str = parsed_date.strftime('%Y-%m-%d')
            else:
                close_timestamp = int(closedate_str) / 1000
                parsed_date_str = datetime.fromtimestamp(close_timestamp).strftime('%Y-%m-%d')
            
            # Use the later of: parsed date or minimum required date
            if parsed_date_str > min_close_date:
                return parsed_date_str
        except (ValueError, TypeError) as e:
            logger.warning(f"Failed to parse close date '{deal.close_date}': {e}")
        
        return min_close_date
    
    def _map_marketing(self, deal: HubSpotDeal) -> Dict:
        """Map marketing information"""
        return {
            "Source": deal.properties.get('marketing_source', 'None')
        }
    
    def _map_opportunity_type(self, deal: HubSpotDeal) -> str:
        """
        Map opportunity type.
        
        Valid values: "Net New Business", "Flat Renewal", "Expansion"
        """
        return deal.properties.get('opportunity_type', 'Net New Business')
    
    def _map_primary_needs(self, deal: HubSpotDeal) -> list:
        """
        Map primary needs from AWS.
        
        Valid values include:
        - "Co-Sell - Architectural Validation"
        - "Co-Sell - Business Presentation"
        - "Co-Sell - Competitive Information"
        - "Co-Sell - Pricing Assistance"
        - "Co-Sell - Technical Consultation"
        - "Co-Sell - Total Cost of Ownership Evaluation"
        - "Co-Sell - Deal Support"
        - "Co-Sell - Support for Public Tender / RFx"
        """
        default_needs = ["Co-Sell - Architectural Validation"]
        return deal.properties.get('primary_needs', default_needs)
    
    def _map_industry(self, deal: HubSpotDeal) -> str:
        """
        Map industry.
        
        Valid values include: "Aerospace", "Agriculture", "Automotive",
        "Computers and Electronics", "Consumer Goods", "Education",
        "Energy - Oil and Gas", "Energy - Power and Utilities",
        "Financial Services", "Gaming", "Government", "Healthcare",
        "Hospitality", "Life Sciences", "Manufacturing", "Marketing and Advertising",
        "Media and Entertainment", "Mining", "Non-Profit Organization",
        "Professional Services", "Real Estate and Construction", "Retail",
        "Software and Internet", "Telecommunications", "Transportation and Logistics",
        "Travel", "Wholesale and Distribution", "Other"
        """
        return deal.properties.get('industry', self.DEFAULT_INDUSTRY)
    
    def _generate_company_name(self, deal: HubSpotDeal, timestamp: int) -> str:
        """
        Generate unique company name for Partner Central.
        
        Partner Central requires unique company names. This generates one
        using a timestamp. Customize as needed for your use case.
        """
        if deal.company_name:
            return f"{deal.company_name}-{timestamp}"
        return f"ValidAWSCreate-{timestamp}"
    
    def _generate_partner_opportunity_id(self, deal: HubSpotDeal, timestamp: int) -> str:
        """
        Generate unique partner opportunity identifier.
        
        Format: HS-{deal_id}-{timestamp}
        This allows creating multiple opportunities from the same HubSpot deal.
        """
        return f"HS-{deal.deal_id}-{timestamp}"
    
    def _generate_client_token(self, deal: HubSpotDeal, timestamp: int) -> str:
        """Generate unique client token for idempotency"""
        return f"hubspot-{deal.deal_name}-{timestamp}"



class PartnerCentralToHubSpotMapper:
    """
    Maps Partner Central opportunity data back to HubSpot deal format.
    
    Use this for bi-directional sync to keep HubSpot deals updated
    when Partner Central opportunity status changes.
    """
    
    # Partner Central ReviewStatus → HubSpot Deal Stage mapping
    REVIEW_STATUS_TO_STAGE = {
        "Pending Submission": "appointmentscheduled",
        "Submitted": "qualifiedtobuy",
        "In Review": "qualifiedtobuy",
        "Action Required": "qualifiedtobuy",
        "Approved": "presentationscheduled",
        "Rejected": "closedlost"
    }
    
    # Partner Central Stage → HubSpot Deal Stage mapping
    PC_STAGE_TO_HUBSPOT = {
        "Prospect": "appointmentscheduled",
        "Qualified": "qualifiedtobuy",
        "Technical Validation": "presentationscheduled",
        "Business Validation": "decisionmakerboughtin",
        "Committed": "contractsent",
        "Launched": "closedwon",
        "Closed Lost": "closedlost"
    }
    
    def __init__(self):
        pass
    
    def map_opportunity_to_deal_update(self, opportunity: Dict, sync_stage: bool = False) -> Dict:
        """
        Map Partner Central opportunity fields to a minimal HubSpot deal
        update payload — by default, **only `hs_next_step`** is synced.
        
        Why so minimal? Workshop participants connect their own HubSpot
        portal, which may use a non-default sales pipeline, custom deal
        names/owners, or have field-level validation rules. Syncing more
        than `hs_next_step` risks 400 errors on any of those.
        
        `hs_next_step` is a built-in HubSpot Deal property available on
        every portal and accepts free-form text up to 500 chars — perfect
        for showing bidirectional sync in a demo without portal-specific
        setup.
        
        Args:
            opportunity: Partner Central opportunity data from GetOpportunity API
            sync_stage: When True, also write dealstage (default sales
                pipeline only). Off by default to avoid 400 errors on
                portals that use different stage IDs.
            
        Returns:
            Dict containing HubSpot deal properties to update
        """
        properties = {}
        
        lifecycle = opportunity.get('LifeCycle', {})
        
        # Primary demo field: HubSpot's built-in Next Step.
        next_steps = lifecycle.get('NextSteps')
        if next_steps:
            properties['hs_next_step'] = next_steps[:500]  # HubSpot length limit
        
        # Optional: stage. Off by default — different portals use different
        # pipeline stage IDs and writing the wrong one returns 400 Bad Request.
        if sync_stage:
            hubspot_stage = self._map_to_hubspot_stage(lifecycle)
            if hubspot_stage:
                properties['dealstage'] = hubspot_stage
        
        return properties
    
    def _map_to_hubspot_stage(self, lifecycle: Dict) -> Optional[str]:
        """
        Determine HubSpot stage based on Partner Central ReviewStatus and Stage.
        
        Priority: ReviewStatus takes precedence for early stages,
                  PC Stage takes precedence for later stages.
        """
        review_status = lifecycle.get('ReviewStatus', '')
        pc_stage = lifecycle.get('Stage', '')
        
        # For approved opportunities, use PC Stage mapping
        if review_status == 'Approved':
            return self.PC_STAGE_TO_HUBSPOT.get(pc_stage, 'presentationscheduled')
        
        # For non-approved, use ReviewStatus mapping
        return self.REVIEW_STATUS_TO_STAGE.get(review_status)
    
    def get_sync_status(self, opportunity: Dict) -> Dict:
        """
        Get a summary of the opportunity status for sync decisions.
        
        Returns:
            Dict with status information for logging/display
        """
        lifecycle = opportunity.get('LifeCycle', {})
        
        return {
            "opportunity_id": opportunity.get('Id'),
            "review_status": lifecycle.get('ReviewStatus'),
            "stage": lifecycle.get('Stage'),
            "recommended_hubspot_stage": self._map_to_hubspot_stage(lifecycle),
            "next_steps": lifecycle.get('NextSteps', '')[:100] + '...' if lifecycle.get('NextSteps') else None
        }


class HubSpotSyncClient:
    """
    Client for syncing Partner Central changes back to HubSpot.
    
    Extends HubSpotClient with update capabilities for bi-directional sync.
    """
    
    BASE_URL = "https://api.hubapi.com"
    
    def __init__(self, bearer_token: str = None):
        import os
        self.bearer_token = bearer_token or os.environ.get('HUBSPOT_BEARER_TOKEN')
        self.mapper = PartnerCentralToHubSpotMapper()
        
        if not self.bearer_token:
            raise ValueError("HubSpot bearer token required for sync operations")
    
    def _make_request(self, method: str, endpoint: str, data: Dict = None) -> Dict:
        """Make authenticated request to HubSpot API"""
        import requests
        
        url = f"{self.BASE_URL}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json"
        }
        
        try:
            if method == "GET":
                response = requests.get(url, headers=headers, timeout=30)
            elif method == "PATCH":
                response = requests.patch(url, headers=headers, json=data, timeout=30)
            elif method == "POST":
                response = requests.post(url, headers=headers, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            
            if response.status_code >= 400:
                # HubSpot returns a JSON body explaining what went wrong —
                # surface that in the error so callers (and the UI) can show
                # the actual reason instead of a generic "400 Bad Request".
                detail = ''
                try:
                    body = response.json()
                    detail = body.get('message') or body.get('error') or ''
                    # Property-level errors live under 'errors' or 'context'
                    errs = body.get('errors') or []
                    if errs:
                        parts = [
                            (e.get('message') or e.get('errorCode') or str(e))
                            for e in errs[:3]
                        ]
                        detail = (detail + ' | ' + '; '.join(parts)).strip(' |')
                except Exception:
                    detail = response.text[:300]
                return {
                    "error": f"HubSpot {response.status_code}: {detail or response.reason}",
                    "status_code": response.status_code,
                }
            
            return response.json() if response.text else {"success": True}
        except Exception as e:
            return {"error": str(e)}
    
    def update_deal(self, deal_id: str, properties: Dict) -> Dict:
        """
        Update a HubSpot deal with new properties.
        
        Args:
            deal_id: HubSpot deal ID
            properties: Dict of properties to update
            
        Returns:
            API response or error
        """
        # Filter out None values; custom fields are kept (must be configured in HubSpot)
        filtered_props = {k: v for k, v in properties.items() if v is not None}
        
        endpoint = f"/crm/v3/objects/deals/{deal_id}"
        return self._make_request("PATCH", endpoint, {"properties": filtered_props})
    
    def sync_from_opportunity(self, deal_id: str, opportunity: Dict) -> Dict:
        """
        Sync Partner Central opportunity status back to HubSpot deal.
        
        Args:
            deal_id: HubSpot deal ID to update
            opportunity: Partner Central opportunity data
            
        Returns:
            Dict with sync result
        """
        import logging
        logger = logging.getLogger(__name__)
        
        # Map opportunity to HubSpot properties
        properties = self.mapper.map_opportunity_to_deal_update(opportunity)
        
        if not properties:
            return {
                "success": False,
                "error": "No properties to sync"
            }
        
        # Get sync status for logging
        sync_status = self.mapper.get_sync_status(opportunity)
        logger.info(f"Syncing opportunity {sync_status['opportunity_id']} to HubSpot deal {deal_id}")
        logger.info(f"  PC Status: {sync_status['review_status']} / {sync_status['stage']}")
        logger.info(f"  → HubSpot Stage: {sync_status['recommended_hubspot_stage']}")
        
        # Update HubSpot deal
        result = self.update_deal(deal_id, properties)
        
        if "error" in result:
            logger.error(f"Failed to sync to HubSpot: {result['error']}")
            return {
                "success": False,
                "error": result["error"],
                "sync_status": sync_status
            }
        
        logger.info(f"✅ Successfully synced to HubSpot deal {deal_id}")
        return {
            "success": True,
            "deal_id": deal_id,
            "updated_properties": properties,
            "sync_status": sync_status
        }
    
    def check_and_sync(
        self, 
        deal_id: str, 
        opportunity_id: str,
        pc_client
    ) -> Dict:
        """
        Check Partner Central opportunity status and sync to HubSpot if changed.
        
        Args:
            deal_id: HubSpot deal ID
            opportunity_id: Partner Central opportunity ID
            pc_client: PartnerCentralMCPClient instance
            
        Returns:
            Dict with sync result
        """
        # Get current opportunity status
        opportunity = pc_client.get_opportunity(opportunity_id)
        
        if not opportunity:
            return {
                "success": False,
                "error": f"Could not fetch opportunity {opportunity_id}"
            }
        
        # Sync to HubSpot
        return self.sync_from_opportunity(deal_id, opportunity)
