#!/usr/bin/env python
"""
Pipedrive to Partner Central Data Mapper.

Maps Pipedrive deal data to AWS Partner Central opportunity format.
Customize field defaults and stage-mapping for your Pipedrive setup.

Field Mapping Reference
-----------------------
Pipedrive Field               -> Partner Central Field
------------------------------   -------------------------------------------
title                            Project.Title
value                            Project.ExpectedCustomerSpend.Amount
currency                         Project.ExpectedCustomerSpend.CurrencyCode
expected_close_date              LifeCycle.TargetCloseDate
stage_id (→ stage name)          LifeCycle.Stage (mapped)
person.name / email / phone      Customer.Contacts[0]
organization.name                Customer.Account.CompanyName
organization.industry (custom)   Customer.Account.Industry
organization.address.*           Customer.Account.Address
id                               PartnerOpportunityIdentifier (prefixed PD-)
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, Optional

logger = logging.getLogger(__name__)


@dataclass
class PipedriveDeal:
    """Represents a Pipedrive deal with all the fields we use."""

    deal_id: str
    title: str
    value: float
    stage: str  # human-readable stage name (resolved from stage_id if needed)
    expected_close_date: str
    org_name: str
    contact_name: str
    contact_email: str
    description: str = ""
    properties: Dict = field(default_factory=dict)


class PipedriveToPartnerCentralMapper:
    """Map a PipedriveDeal into a Partner Central CreateOpportunity payload."""

    # ---- Defaults — customize for your organization --------------------------

    DEFAULT_INDUSTRY = "Software and Internet"
    DEFAULT_WEBSITE = "https://example.com"
    DEFAULT_COUNTRY_CODE = "US"
    DEFAULT_STATE = "California"
    DEFAULT_CITY = "San Francisco"
    DEFAULT_POSTAL_CODE = "94105"
    DEFAULT_STREET = "1 Market Street"
    DEFAULT_PHONE = "+14155550000"
    DEFAULT_BUSINESS_TITLE = "Contact"
    DEFAULT_CUSTOMER_USE_CASE = "Business Applications & Contact Center"
    DEFAULT_DELIVERY_MODEL = "SaaS or PaaS"
    DEFAULT_SALES_ACTIVITY = "Conducted POC / Demo"
    DEFAULT_CURRENCY = "USD"
    DEFAULT_SPEND_FREQUENCY = "Monthly"
    DEFAULT_AMOUNT = "1000"

    MIN_CLOSE_DATE_DAYS = 7

    # ---- Partner Central enum allow-lists (for validation) -------------------

    VALID_INDUSTRIES = {
        "Aerospace", "Agriculture", "Automotive", "Computers and Electronics",
        "Consumer Goods", "Education", "Energy - Oil and Gas",
        "Energy - Power and Utilities", "Financial Services", "Gaming",
        "Government", "Healthcare", "Hospitality", "Life Sciences",
        "Manufacturing", "Marketing and Advertising", "Media and Entertainment",
        "Mining", "Non-Profit Organization", "Professional Services",
        "Real Estate and Construction", "Retail", "Software and Internet",
        "Telecommunications", "Transportation and Logistics", "Travel",
        "Wholesale and Distribution", "Other",
    }

    VALID_DELIVERY_MODELS = {
        "SaaS or PaaS", "BYOL or AMI", "Managed Services",
        "Professional Services", "Resell", "Other",
    }

    VALID_SALES_ACTIVITIES = {
        "Initialized discussions with customer",
        "Customer has shown interest in solution",
        "Conducted POC / Demo",
        "In evaluation / planning stage",
        "Agreed on solution to Business Problem",
        "Completed Action Plan",
        "Finalized Deployment Need",
        "SOW Signed",
    }

    VALID_STAGES = {
        "Prospect", "Qualified", "Technical Validation", "Business Validation",
        "Committed", "Launched", "Closed Lost",
    }

    VALID_CURRENCY_CODES = {
        "USD", "EUR", "GBP", "AUD", "CAD", "CNY", "NZD", "INR", "JPY", "CHF",
        "SEK", "AED", "BRL", "MXN", "SGD", "HKD", "KRW", "ZAR", "RUB", "PLN",
    }

    # Country-name/state mapping tables copied from salesforce_mapper (they're
    # CRM-agnostic — any CRM that gives us raw country/state strings needs
    # these conversions to match Partner Central's enums). See SALESFORCE
    # mapper for the full tables if you need to extend them.
    COUNTRY_NAME_TO_CODE = {
        "united states": "US", "usa": "US", "u.s.": "US", "united states of america": "US",
        "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB",
        "canada": "CA", "australia": "AU", "germany": "DE", "france": "FR",
        "japan": "JP", "china": "CN", "india": "IN", "brazil": "BR", "mexico": "MX",
        "spain": "ES", "italy": "IT", "netherlands": "NL", "belgium": "BE",
        "switzerland": "CH", "austria": "AT", "sweden": "SE", "norway": "NO",
        "denmark": "DK", "finland": "FI", "ireland": "IE", "portugal": "PT",
        "poland": "PL", "russia": "RU", "south korea": "KR", "singapore": "SG",
        "hong kong": "HK", "taiwan": "TW", "new zealand": "NZ", "south africa": "ZA",
        "israel": "IL", "united arab emirates": "AE", "saudi arabia": "SA",
    }

    US_STATE_ABBREV_TO_NAME = {
        "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
        "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
        "DC": "Dist. of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
        "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
        "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
        "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
        "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
        "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
        "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
        "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
        "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
        "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
        "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    }

    VALID_US_STATES = set(US_STATE_ABBREV_TO_NAME.values()) | {
        "American Samoa", "Guam", "Puerto Rico", "Virgin Islands",
    }

    VALID_COUNTRY_CODES = {
        "US", "GB", "CA", "AU", "DE", "FR", "JP", "CN", "IN", "BR", "MX", "ES",
        "IT", "NL", "BE", "CH", "AT", "SE", "NO", "DK", "FI", "IE", "PT", "PL",
        "RU", "KR", "SG", "HK", "TW", "NZ", "ZA", "IL", "AE", "SA",
    }

    # Pipedrive default-pipeline stages (can be customized per company).
    # These are the slugs that Pipedrive typically returns in stage.name.
    PIPEDRIVE_STAGE_MAPPING = {
        "qualified": "Prospect",
        "contact made": "Qualified",
        "demo scheduled": "Technical Validation",
        "proposal made": "Business Validation",
        "negotiations started": "Committed",
        "won": "Launched",
        "lost": "Closed Lost",
    }

    PIPEDRIVE_STAGE_TO_ACTIVITY = {
        "qualified": "Initialized discussions with customer",
        "contact made": "Customer has shown interest in solution",
        "demo scheduled": "Conducted POC / Demo",
        "proposal made": "Agreed on solution to Business Problem",
        "negotiations started": "Completed Action Plan",
        "won": "SOW Signed",
        "lost": "Initialized discussions with customer",
    }

    def __init__(self, catalog: str = "Sandbox"):
        self.catalog = catalog

    # -------------------------------------------------------------------------

    def map_deal_to_opportunity(
        self, deal: PipedriveDeal, project_title: Optional[str] = None
    ) -> Dict:
        """Build the full CreateOpportunity payload for Partner Central."""
        timestamp = int(time.time())

        payload = {
            "Catalog": self.catalog,
            "ClientToken": self._generate_client_token(deal, timestamp),
            "Customer": self._map_customer(deal, timestamp),
            "LifeCycle": self._map_lifecycle(deal),
            "Marketing": self._map_marketing(deal),
            "OpportunityType": self._map_opportunity_type(deal),
            "Origin": "Partner Referral",
            "PrimaryNeedsFromAws": self._map_primary_needs(deal),
            "Project": self._map_project(deal, project_title, timestamp),
            "PartnerOpportunityIdentifier": self._generate_partner_opportunity_id(
                deal, timestamp
            ),
        }

        logger.info(f"Mapped Pipedrive deal {deal.deal_id} to Partner Central payload")
        return payload

    # -------------------------------------------------------------------------

    def _map_customer(self, deal: PipedriveDeal, timestamp: int) -> Dict:
        props = deal.properties
        return {
            "Account": {
                "CompanyName": self._generate_company_name(deal, timestamp),
                "Industry": self._map_industry(deal),
                "WebsiteUrl": props.get("org_website") or self.DEFAULT_WEBSITE,
                "Address": self._map_address(deal),
            },
            "Contacts": [self._map_contact(deal)],
        }

    def _map_contact(self, deal: PipedriveDeal) -> Dict:
        props = deal.properties

        first = props.get("contact_first_name") or ""
        last = props.get("contact_last_name") or ""
        if not first and not last and deal.contact_name:
            parts = deal.contact_name.split(" ", 1)
            first = parts[0] if parts else "Unknown"
            last = parts[1] if len(parts) > 1 else "Contact"

        return {
            "FirstName": first or "Unknown",
            "LastName": last or "Contact",
            "Email": deal.contact_email or "contact@example.com",
            "Phone": self._format_phone(props.get("contact_phone") or ""),
            "BusinessTitle": props.get("contact_title") or self.DEFAULT_BUSINESS_TITLE,
        }

    def _format_phone(self, phone: str) -> str:
        """Return phone in E.164 format Partner Central accepts."""
        if not phone:
            return self.DEFAULT_PHONE
        cleaned = re.sub(r"[^\d+]", "", str(phone))
        if cleaned.startswith("+"):
            if re.match(r"^\+[1-9]\d{1,14}$", cleaned):
                return cleaned
            digits = re.sub(r"[^\d]", "", cleaned)
            if digits and digits[0] != "0":
                return f"+{digits[:15]}"
        cleaned = cleaned.lstrip("0")
        if not cleaned:
            return self.DEFAULT_PHONE
        if len(cleaned) == 10 and cleaned[0] != "0":
            return f"+1{cleaned}"
        if len(cleaned) == 11 and cleaned[0] == "1":
            return f"+{cleaned}"
        if cleaned[0] != "0" and 7 <= len(cleaned) <= 15:
            return f"+{cleaned}"
        logger.warning(f"Could not parse phone '{phone}', using default")
        return self.DEFAULT_PHONE

    def _map_address(self, deal: PipedriveDeal) -> Dict:
        props = deal.properties
        country = self._convert_country(props.get("org_country") or "")
        state = self._convert_state(props.get("org_state") or "", country)
        return {
            "CountryCode": country,
            "StateOrRegion": state,
            "City": props.get("org_city") or self.DEFAULT_CITY,
            "PostalCode": props.get("org_postal_code") or self.DEFAULT_POSTAL_CODE,
            "StreetAddress": props.get("org_address") or self.DEFAULT_STREET,
        }

    def _convert_country(self, raw: str) -> str:
        if not raw:
            return self.DEFAULT_COUNTRY_CODE
        upper = raw.strip().upper()
        if len(upper) == 2 and upper in self.VALID_COUNTRY_CODES:
            return upper
        lower = raw.strip().lower()
        if lower in self.COUNTRY_NAME_TO_CODE:
            return self.COUNTRY_NAME_TO_CODE[lower]
        for name, code in self.COUNTRY_NAME_TO_CODE.items():
            if name in lower or lower in name:
                return code
        logger.warning(f"Could not map country '{raw}', using default")
        return self.DEFAULT_COUNTRY_CODE

    def _convert_state(self, raw: str, country_code: str) -> str:
        if not raw:
            return self.DEFAULT_STATE
        stripped = raw.strip()
        if country_code != "US":
            return stripped
        upper = stripped.upper()
        if len(upper) == 2 and upper in self.US_STATE_ABBREV_TO_NAME:
            return self.US_STATE_ABBREV_TO_NAME[upper]
        if stripped in self.VALID_US_STATES:
            return stripped
        lower = stripped.lower()
        for valid in self.VALID_US_STATES:
            if valid.lower() == lower:
                return valid
        return self.DEFAULT_STATE

    # -------------------------------------------------------------------------

    def _map_project(
        self, deal: PipedriveDeal, project_title: Optional[str], timestamp: int
    ) -> Dict:
        return {
            "Title": project_title or deal.title,
            "CustomerBusinessProblem": self._map_business_problem(deal),
            "CustomerUseCase": self._map_use_case(deal),
            "OtherSolutionDescription": self._map_solution_description(deal),
            "DeliveryModels": [self._map_delivery_model(deal)],
            "SalesActivities": [self._map_sales_activity(deal)],
            "ExpectedCustomerSpend": [self._map_expected_spend(deal)],
        }

    def _map_business_problem(self, deal: PipedriveDeal) -> str:
        if deal.properties.get("customer_business_problem"):
            return deal.properties["customer_business_problem"]
        if deal.description:
            return deal.description[:500]
        stage_lower = deal.stage.lower() if deal.stage else ""
        stage_problems = {
            "qualified": "Initial discovery — understanding customer needs",
            "contact made": "Customer has shown interest in cloud solution",
            "demo scheduled": "Evaluating AWS solutions for business requirements",
            "proposal made": "Ready to proceed with AWS implementation",
            "negotiations started": "Finalizing terms for AWS engagement",
            "won": "AWS solution selected",
            "lost": "Opportunity closed",
        }
        return stage_problems.get(stage_lower, "Opportunity from Pipedrive - New Business")

    def _map_use_case(self, deal: PipedriveDeal) -> str:
        return deal.properties.get("use_case") or self.DEFAULT_CUSTOMER_USE_CASE

    def _map_solution_description(self, deal: PipedriveDeal) -> str:
        return deal.properties.get("solution_description") or "Partner Solution"

    def _map_delivery_model(self, deal: PipedriveDeal) -> str:
        candidate = deal.properties.get("delivery_model") or ""
        return candidate if candidate in self.VALID_DELIVERY_MODELS else self.DEFAULT_DELIVERY_MODEL

    def _map_sales_activity(self, deal: PipedriveDeal) -> str:
        stage_lower = (deal.stage or "").lower()
        activity = self.PIPEDRIVE_STAGE_TO_ACTIVITY.get(stage_lower, self.DEFAULT_SALES_ACTIVITY)
        return activity if activity in self.VALID_SALES_ACTIVITIES else self.DEFAULT_SALES_ACTIVITY

    def _map_expected_spend(self, deal: PipedriveDeal) -> Dict:
        amount = str(int(deal.value)) if deal.value else self.DEFAULT_AMOUNT
        currency_raw = (deal.properties.get("currency") or "").upper()
        currency = currency_raw if currency_raw in self.VALID_CURRENCY_CODES else self.DEFAULT_CURRENCY
        return {
            "Amount": amount,
            "CurrencyCode": currency,
            "Frequency": self.DEFAULT_SPEND_FREQUENCY,
            "TargetCompany": deal.properties.get("target_company") or "AWS",
        }

    def _map_lifecycle(self, deal: PipedriveDeal) -> Dict:
        return {
            "Stage": self._map_stage(deal),
            "ReviewStatus": "Pending Submission",
            "TargetCloseDate": self._map_close_date(deal),
        }

    def _map_stage(self, deal: PipedriveDeal) -> str:
        stage_lower = (deal.stage or "").lower()
        mapped = self.PIPEDRIVE_STAGE_MAPPING.get(stage_lower, "Prospect")
        return mapped if mapped in self.VALID_STAGES else "Prospect"

    def _map_close_date(self, deal: PipedriveDeal) -> str:
        min_close = (datetime.now() + timedelta(days=self.MIN_CLOSE_DATE_DAYS)).strftime("%Y-%m-%d")
        raw = deal.expected_close_date
        if not raw:
            return min_close
        try:
            parsed = raw[:10] if isinstance(raw, str) else str(raw)[:10]
            # Ensure it's a valid date and at least MIN days in the future.
            datetime.strptime(parsed, "%Y-%m-%d")
            return parsed if parsed > min_close else min_close
        except (ValueError, TypeError) as e:
            logger.warning(f"Invalid close_date '{raw}': {e}")
            return min_close

    def _map_marketing(self, deal: PipedriveDeal) -> Dict:
        return {"Source": "Marketing Activity" if deal.properties.get("campaign") else "None"}

    def _map_opportunity_type(self, deal: PipedriveDeal) -> str:
        opp_type = (deal.properties.get("opportunity_type") or "").lower()
        if "renewal" in opp_type:
            return "Flat Renewal"
        if "expansion" in opp_type or "upsell" in opp_type:
            return "Expansion"
        return "Net New Business"

    def _map_primary_needs(self, deal: PipedriveDeal) -> list:
        return ["Co-Sell - Architectural Validation"]

    def _map_industry(self, deal: PipedriveDeal) -> str:
        industry = deal.properties.get("org_industry") or ""
        if industry in self.VALID_INDUSTRIES:
            return industry
        mapping = {
            "technology": "Software and Internet",
            "software": "Software and Internet",
            "financial": "Financial Services",
            "banking": "Financial Services",
            "healthcare": "Healthcare",
            "retail": "Retail",
            "manufacturing": "Manufacturing",
            "education": "Education",
            "government": "Government",
            "media": "Media and Entertainment",
            "telecommunications": "Telecommunications",
            "energy": "Energy - Power and Utilities",
            "hospitality": "Hospitality",
            "transportation": "Transportation and Logistics",
            "professional services": "Professional Services",
        }
        if industry:
            industry_lower = industry.lower()
            for key, value in mapping.items():
                if key in industry_lower:
                    return value
        return self.DEFAULT_INDUSTRY

    # -------------------------------------------------------------------------

    def _generate_company_name(self, deal: PipedriveDeal, timestamp: int) -> str:
        base = deal.org_name or "PDOpportunity"
        return f"{base}-{timestamp}"

    def _generate_partner_opportunity_id(self, deal: PipedriveDeal, timestamp: int) -> str:
        return f"PD-{deal.deal_id}-{timestamp}"

    def _generate_client_token(self, deal: PipedriveDeal, timestamp: int) -> str:
        safe = re.sub(r"\s+", "-", (deal.title or "deal"))[:20]
        return f"pipedrive-{safe}-{timestamp}"


class PartnerCentralToPipedriveMapper:
    """
    Maps Partner Central opportunity data back to Pipedrive deal format.
    
    Use this for bi-directional sync to keep Pipedrive deals updated
    when Partner Central opportunity status changes.
    """
    
    # Partner Central ReviewStatus → Pipedrive Stage mapping
    # These map to Pipedrive's default pipeline stage names
    REVIEW_STATUS_TO_STAGE = {
        "Pending Submission": "Qualified",
        "Submitted": "Contact Made",
        "In Review": "Contact Made",
        "Action Required": "Contact Made",
        "Approved": "Proposal Made",
        "Rejected": "Lost"
    }
    
    # Partner Central Stage → Pipedrive Stage mapping
    PC_STAGE_TO_PIPEDRIVE = {
        "Prospect": "Qualified",
        "Qualified": "Contact Made",
        "Technical Validation": "Demo Scheduled",
        "Business Validation": "Proposal Made",
        "Committed": "Negotiations Started",
        "Launched": "Won",
        "Closed Lost": "Lost"
    }
    
    def __init__(self):
        pass
    
    def map_opportunity_to_deal_update(self, opportunity: Dict) -> Dict:
        """
        Map Partner Central opportunity fields to Pipedrive deal update payload.
        
        Uses only **built-in Pipedrive Deal fields** so this works on any
        Pipedrive account without custom-field setup. Note: Pipedrive
        doesn't have a dedicated "next step" field — we sync ACE NextSteps
        into the `description` field with a clear marker so partners can
        see it in the deal.
        
        Args:
            opportunity: Partner Central opportunity data from GetOpportunity API
            
        Returns:
            Dict containing Pipedrive deal fields to update
        """
        fields = {}
        
        lifecycle = opportunity.get('LifeCycle', {})
        project = opportunity.get('Project', {})
        
        # --- Built-in Pipedrive fields (always available) ---
        
        # Map stage name (Pipedrive uses stage_id, but we return the name for lookup)
        pipedrive_stage = self._map_to_pipedrive_stage(lifecycle)
        if pipedrive_stage:
            fields['stage_name'] = pipedrive_stage
            # Map to status for won/lost
            if pipedrive_stage == 'Won':
                fields['status'] = 'won'
            elif pipedrive_stage == 'Lost':
                fields['status'] = 'lost'
            else:
                fields['status'] = 'open'
        
        # Map close date (Pipedrive uses expected_close_date)
        target_close_date = lifecycle.get('TargetCloseDate')
        if target_close_date:
            fields['expected_close_date'] = target_close_date
        
        # Map amount (Pipedrive uses 'value')
        expected_spend = project.get('ExpectedCustomerSpend', [])
        if expected_spend and len(expected_spend) > 0:
            amount = expected_spend[0].get('Amount')
            if amount:
                fields['value'] = float(amount)
        
        # Map title
        title = project.get('Title')
        if title:
            fields['title'] = title
        
        # Pipedrive doesn't have a built-in "next step" field, so we sync
        # ACE NextSteps into the `description` field with a clear marker.
        # The marker lets us replace just our content on subsequent syncs.
        next_steps = lifecycle.get('NextSteps')
        if next_steps:
            fields['description'] = (
                f"[ACE Next Steps] {next_steps[:1000]}"
            )
        
        return fields
    
    def _map_to_pipedrive_stage(self, lifecycle: Dict) -> Optional[str]:
        """
        Determine Pipedrive stage based on Partner Central ReviewStatus and Stage.
        """
        review_status = lifecycle.get('ReviewStatus', '')
        pc_stage = lifecycle.get('Stage', '')
        
        # For approved opportunities, use PC Stage mapping
        if review_status == 'Approved':
            return self.PC_STAGE_TO_PIPEDRIVE.get(pc_stage, 'Proposal Made')
        
        # For non-approved, use ReviewStatus mapping
        return self.REVIEW_STATUS_TO_STAGE.get(review_status)
    
    def get_sync_status(self, opportunity: Dict) -> Dict:
        """Get a summary of the opportunity status for sync decisions."""
        lifecycle = opportunity.get('LifeCycle', {})
        
        return {
            "opportunity_id": opportunity.get('Id'),
            "review_status": lifecycle.get('ReviewStatus'),
            "stage": lifecycle.get('Stage'),
            "recommended_pipedrive_stage": self._map_to_pipedrive_stage(lifecycle),
            "next_steps": lifecycle.get('NextSteps', '')[:100] + '...' if lifecycle.get('NextSteps') else None
        }


class PipedriveSyncClient:
    """
    Client for syncing Partner Central changes back to Pipedrive.
    """
    
    def __init__(self, api_token: str = None, instance_url: str = None):
        import os
        self.api_token = api_token or os.environ.get('PIPEDRIVE_API_TOKEN')
        self.instance_url = (instance_url or os.environ.get('PIPEDRIVE_INSTANCE_URL', '')).rstrip('/')
        self.mapper = PartnerCentralToPipedriveMapper()
        
        if not self.api_token:
            raise ValueError("Pipedrive API token required for sync operations")
        if not self.instance_url:
            raise ValueError("Pipedrive instance URL required for sync operations")
    
    def _make_request(self, method: str, endpoint: str, data: Dict = None) -> Dict:
        """Make authenticated request to Pipedrive API"""
        import requests
        
        url = f"{self.instance_url}/api/v1{endpoint}"
        params = {"api_token": self.api_token}
        headers = {"Content-Type": "application/json"}
        
        try:
            if method == "GET":
                response = requests.get(url, params=params, headers=headers, timeout=30)
            elif method == "PUT":
                response = requests.put(url, params=params, headers=headers, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            
            response.raise_for_status()
            result = response.json()
            if result.get('success'):
                return result.get('data', {})
            return {"error": result.get('error', 'Unknown Pipedrive error')}
        except Exception as e:
            return {"error": str(e)}
    
    def _resolve_stage_id(self, stage_name: str) -> Optional[int]:
        """
        Resolve a Pipedrive stage name to its stage_id.
        
        Pipedrive requires stage_id for updates, not stage names.
        """
        try:
            import requests
            url = f"{self.instance_url}/api/v1/stages"
            params = {"api_token": self.api_token}
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            result = response.json()
            
            if result.get('success') and result.get('data'):
                for stage in result['data']:
                    if stage.get('name', '').lower() == stage_name.lower():
                        return stage['id']
        except Exception:
            pass
        return None
    
    def update_deal(self, deal_id: str, fields: Dict) -> Dict:
        """
        Update a Pipedrive deal with new field values.
        
        Args:
            deal_id: Pipedrive deal ID
            fields: Dict of fields to update
            
        Returns:
            API response or error
        """
        # If stage_name is provided, resolve it to stage_id
        update_data = {}
        for key, value in fields.items():
            if key == 'stage_name':
                stage_id = self._resolve_stage_id(value)
                if stage_id:
                    update_data['stage_id'] = stage_id
            else:
                update_data[key] = value
        
        endpoint = f"/deals/{deal_id}"
        return self._make_request("PUT", endpoint, update_data)
    
    def sync_from_opportunity(self, deal_id: str, pc_opportunity: Dict) -> Dict:
        """
        Sync Partner Central opportunity status back to Pipedrive deal.
        
        Args:
            deal_id: Pipedrive deal ID to update
            pc_opportunity: Partner Central opportunity data
            
        Returns:
            Dict with sync result
        """
        import logging
        logger = logging.getLogger(__name__)
        
        # Map PC opportunity to Pipedrive fields
        fields = self.mapper.map_opportunity_to_deal_update(pc_opportunity)
        
        if not fields:
            return {
                "success": False,
                "error": "No fields to sync"
            }
        
        # Get sync status for logging
        sync_status = self.mapper.get_sync_status(pc_opportunity)
        logger.info(f"Syncing PC opportunity {sync_status['opportunity_id']} to Pipedrive deal {deal_id}")
        logger.info(f"  PC Status: {sync_status['review_status']} / {sync_status['stage']}")
        logger.info(f"  → Pipedrive Stage: {sync_status['recommended_pipedrive_stage']}")
        
        # Update Pipedrive deal
        result = self.update_deal(deal_id, fields)
        
        if "error" in result:
            logger.error(f"Failed to sync to Pipedrive: {result['error']}")
            return {
                "success": False,
                "error": result["error"],
                "sync_status": sync_status
            }
        
        logger.info(f"✅ Successfully synced to Pipedrive deal {deal_id}")
        return {
            "success": True,
            "deal_id": deal_id,
            "updated_fields": fields,
            "sync_status": sync_status
        }
    
    def check_and_sync(self, deal_id: str, pc_opportunity_id: str, pc_client) -> Dict:
        """
        Check Partner Central opportunity status and sync to Pipedrive.
        
        Args:
            deal_id: Pipedrive deal ID
            pc_opportunity_id: Partner Central opportunity ID
            pc_client: PartnerCentralMCPClient instance
        """
        opportunity = pc_client.get_opportunity(pc_opportunity_id)
        
        if not opportunity:
            return {
                "success": False,
                "error": f"Could not fetch PC opportunity {pc_opportunity_id}"
            }
        
        return self.sync_from_opportunity(deal_id, opportunity)
