#!/usr/bin/env python
"""
Salesforce to Partner Central Data Mapper

This module handles the mapping of Salesforce opportunity data to AWS Partner Central
opportunity format. Customize this file to match your Salesforce field structure
and Partner Central requirements.

Field Mapping Reference:
------------------------
Salesforce Field           -> Partner Central Field
---------------------------------------------------------
Name                       -> Project.Title
Amount                     -> Project.ExpectedCustomerSpend.Amount
CloseDate                  -> LifeCycle.TargetCloseDate
Contact FirstName          -> Customer.Contacts[0].FirstName
Contact LastName           -> Customer.Contacts[0].LastName
Contact Email              -> Customer.Contacts[0].Email
Contact Phone              -> Customer.Contacts[0].Phone
Contact Title              -> Customer.Contacts[0].BusinessTitle
Id                         -> PartnerOpportunityIdentifier (prefixed with SF-)
Account.Name               -> Customer.Account.CompanyName
"""

import logging
from datetime import datetime, timedelta
from typing import Dict, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class SalesforceOpportunity:
    """Represents a Salesforce opportunity with all relevant fields"""
    opportunity_id: str
    name: str
    amount: float
    stage: str
    close_date: str
    account_name: str
    contact_name: str
    contact_email: str
    description: str
    properties: Dict = field(default_factory=dict)


class SalesforceToPartnerCentralMapper:
    """
    Maps Salesforce opportunity data to Partner Central opportunity format.
    
    Customize this class to:
    - Map additional Salesforce fields
    - Change default values
    - Add validation logic
    - Transform data formats
    """
    
    # Default values - customize these for your organization
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
    
    # Minimum days in future for close date (Partner Central requirement)
    MIN_CLOSE_DATE_DAYS = 7
    
    # Country name to ISO 2-letter code mapping
    # Salesforce often stores full country names, but Partner Central requires ISO codes
    COUNTRY_NAME_TO_CODE = {
        # Common country names
        'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'u.s.': 'US', 'u.s.a.': 'US',
        'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB',
        'canada': 'CA',
        'australia': 'AU',
        'germany': 'DE', 'deutschland': 'DE',
        'france': 'FR',
        'japan': 'JP',
        'china': 'CN',
        'india': 'IN',
        'brazil': 'BR',
        'mexico': 'MX',
        'spain': 'ES',
        'italy': 'IT',
        'netherlands': 'NL', 'holland': 'NL',
        'belgium': 'BE',
        'switzerland': 'CH',
        'austria': 'AT',
        'sweden': 'SE',
        'norway': 'NO',
        'denmark': 'DK',
        'finland': 'FI',
        'ireland': 'IE',
        'portugal': 'PT',
        'poland': 'PL',
        'russia': 'RU', 'russian federation': 'RU',
        'south korea': 'KR', 'korea': 'KR', 'republic of korea': 'KR',
        'singapore': 'SG',
        'hong kong': 'HK',
        'taiwan': 'TW',
        'new zealand': 'NZ',
        'south africa': 'ZA',
        'israel': 'IL',
        'united arab emirates': 'AE', 'uae': 'AE',
        'saudi arabia': 'SA',
        'argentina': 'AR',
        'chile': 'CL',
        'colombia': 'CO',
        'peru': 'PE',
        'indonesia': 'ID',
        'malaysia': 'MY',
        'thailand': 'TH',
        'vietnam': 'VN',
        'philippines': 'PH',
        'turkey': 'TR',
        'greece': 'GR',
        'czech republic': 'CZ', 'czechia': 'CZ',
        'hungary': 'HU',
        'romania': 'RO',
        'ukraine': 'UA',
        'egypt': 'EG',
        'nigeria': 'NG',
        'kenya': 'KE',
        'pakistan': 'PK',
        'bangladesh': 'BD',
        'luxembourg': 'LU',
        'puerto rico': 'PR',
    }
    
    # US State abbreviation to full name mapping
    # Partner Central requires full state names, not abbreviations
    US_STATE_ABBREV_TO_NAME = {
        'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
        'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
        'DC': 'Dist. of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii',
        'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
        'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine',
        'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
        'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska',
        'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico',
        'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
        'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island',
        'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
        'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
        'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
        # US Territories
        'AS': 'American Samoa', 'GU': 'Guam', 'MP': 'Northern Mariana Islands',
        'PR': 'Puerto Rico', 'VI': 'Virgin Islands', 'FM': 'Federated States of Micronesia',
        'MH': 'Marshall Islands', 'PW': 'Palau',
    }
    
    # Valid US state/territory names accepted by Partner Central
    VALID_US_STATES = {
        'AFO/FPO', 'Alabama', 'Alaska', 'American Samoa', 'APO/AE', 'Arizona', 'Arkansas',
        'California', 'Colorado', 'Connecticut', 'Delaware', 'Dist. of Columbia',
        'Federated States of Micronesia', 'Florida', 'FPO, AP', 'Georgia', 'Guam', 'Hawaii',
        'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
        'Marshall Islands', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
        'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico',
        'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Palau',
        'Pennsylvania', 'Puerto Rico', 'Rhode Island', 'South Carolina', 'South Dakota',
        'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Virgin Islands', 'Washington',
        'West Virginia', 'Wisconsin', 'Wyoming'
    }
    
    # Valid Partner Central Industry values
    VALID_INDUSTRIES = {
        'Aerospace', 'Agriculture', 'Automotive', 'Computers and Electronics',
        'Consumer Goods', 'Education', 'Energy - Oil and Gas', 'Energy - Power and Utilities',
        'Financial Services', 'Gaming', 'Government', 'Healthcare', 'Hospitality',
        'Life Sciences', 'Manufacturing', 'Marketing and Advertising', 'Media and Entertainment',
        'Mining', 'Non-Profit Organization', 'Professional Services', 'Real Estate and Construction',
        'Retail', 'Software and Internet', 'Telecommunications', 'Transportation and Logistics',
        'Travel', 'Wholesale and Distribution', 'Other'
    }
    
    # Valid Partner Central Delivery Models
    VALID_DELIVERY_MODELS = {
        'SaaS or PaaS', 'BYOL or AMI', 'Managed Services', 'Professional Services', 'Resell', 'Other'
    }
    
    # Valid Partner Central Sales Activities
    VALID_SALES_ACTIVITIES = {
        'Initialized discussions with customer', 'Customer has shown interest in solution',
        'Conducted POC / Demo', 'In evaluation / planning stage',
        'Agreed on solution to Business Problem', 'Completed Action Plan',
        'Finalized Deployment Need', 'SOW Signed'
    }
    
    # Valid Partner Central Customer Use Cases
    VALID_USE_CASES = {
        'AI Machine Learning and Analytics', 'Application Integration', 'Application Migration',
        'Archiving', 'Big Data: Data Warehouse/Data Integration/ETL/Data Lake/BI',
        'Business Applications & Contact Center', 'Business Applications: Mainframe Modernization',
        'Business Applications: SAP Production', 'Centralized Operations Management',
        'Cloud Management Tools', 'Configuration, Pair, and Compliance', 'Connected Services',
        'Containers & Serverless', 'Content Delivery & Edge Services', 'Database Migration',
        'Data Center Migration', 'Desktop & Application Streaming', 'Development and Testing',
        'DevOps', 'Disaster Recovery', 'Ecommerce', 'End User Computing & Contact Center',
        'Energy', 'Genomics', 'HPC', 'Hybrid Application Development', 'Industrial Software',
        'IoT', 'Marketing & Customer Engagement', 'Media & High Performance Computing',
        'Medical & Health Informatics', 'Migration', 'Mixed Reality & Game Tech',
        'Monitoring, logging and performance', 'Networking', 'Other', 'Outposts',
        'SAP', 'Security & Compliance', 'Storage', 'Training', 'VMC', 'Web & Mobile App Development'
    }
    
    # Valid Partner Central Opportunity Types
    VALID_OPPORTUNITY_TYPES = {'Net New Business', 'Flat Renewal', 'Expansion'}
    
    # Valid Partner Central Primary Needs from AWS
    VALID_PRIMARY_NEEDS = {
        'Co-Sell - Architectural Validation', 'Co-Sell - Business Presentation',
        'Co-Sell - Competitive Information', 'Co-Sell - Pricing Assistance',
        'Co-Sell - Technical Consultation', 'Co-Sell - Total Cost of Ownership Evaluation',
        'Co-Sell - Deal Support', 'Co-Sell - Support for Public Tender / RFx'
    }
    
    # Valid Partner Central Lifecycle Stages
    VALID_STAGES = {
        'Prospect', 'Qualified', 'Technical Validation', 'Business Validation',
        'Committed', 'Launched', 'Closed Lost'
    }
    
    # Valid ISO Currency Codes
    VALID_CURRENCY_CODES = {
        'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CNY', 'NZD', 'INR', 'JPY', 'CHF',
        'SEK', 'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AWG', 'AZN',
        'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
        'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CDF', 'CLF', 'CLP', 'COP', 'CRC',
        'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN',
        'ETB', 'FJD', 'FKP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
        'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS', 'IQD', 'IRR', 'ISK',
        'JMD', 'JOD', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD',
        'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA',
        'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR',
        'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'OMR', 'PAB', 'PEN', 'PGK',
        'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR',
        'SBD', 'SCR', 'SDG', 'SGD', 'SHP', 'SLL', 'SOS', 'SRD', 'SSP', 'STN',
        'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD',
        'TWD', 'TZS', 'UAH', 'UGX', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST',
        'XAF', 'XCD', 'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWL'
    }
    
    # Valid Partner Central Marketing Sources
    VALID_MARKETING_SOURCES = {
        'Marketing Activity', 'None'
    }
    
    # Valid ISO country codes accepted by Partner Central
    VALID_COUNTRY_CODES = {
        'TT', 'SS', 'MM', 'GG', 'EE', 'CC', 'BB', 'RS', 'ST', 'NO', 'MN', 'GH', 'DE', 'CD', 'TV', 'PR', 
        'NP', 'MO', 'GI', 'EG', 'KM', 'BD', 'EH', 'TW', 'KN', 'RU', 'PS', 'MP', 'JM', 'IL', 'HK', 'FI', 
        'SV', 'CF', 'BE', 'AD', 'UY', 'AE', 'PT', 'NR', 'MQ', 'IM', 'FJ', 'CG', 'BF', 'UZ', 'CH', 'SX', 
        'RW', 'MR', 'JO', 'IN', 'HM', 'GL', 'FK', 'BG', 'AF', 'TZ', 'SY', 'MS', 'LR', 'JP', 'HN', 'GM', 
        'DJ', 'CI', 'IO', 'BH', 'AG', 'SZ', 'ZA', 'PW', 'NU', 'FM', 'MT', 'LS', 'KR', 'GN', 'DK', 'BI', 
        'MU', 'LT', 'IQ', 'CK', 'BJ', 'AI', 'PY', 'MV', 'LU', 'IR', 'GP', 'FO', 'DM', 'CL', 'BL', 'MW', 
        'LV', 'IS', 'GQ', 'HR', 'CM', 'MX', 'IT', 'VA', 'GR', 'DO', 'CN', 'BM', 'AL', 'YE', 'UA', 'GS', 
        'NZ', 'MY', 'KW', 'HT', 'FR', 'CO', 'BN', 'AM', 'VC', 'AN', 'MZ', 'LY', 'HU', 'GT', 'ER', 'BO', 
        'ES', 'SA', 'GU', 'KY', 'AO', 'WF', 'VE', 'TC', 'SB', 'KZ', 'ET', 'CR', 'BQ', 'SC', 'QA', 'GW', 
        'TD', 'BR', 'AQ', 'VG', 'SD', 'PA', 'BS', 'AR', 'UG', 'SE', 'GY', 'TF', 'CU', 'BT', 'AS', 'ZM', 
        'VI', 'TG', 'RE', 'NA', 'CV', 'AT', 'TH', 'SG', 'MA', 'CW', 'BV', 'AU', 'SH', 'PE', 'NC', 'LA', 
        'CX', 'BW', 'TJ', 'SI', 'MC', 'LB', 'PF', 'CY', 'AW', 'DZ', 'TK', 'SJ', 'LC', 'PG', 'NE', 'MD', 
        'CZ', 'BY', 'AX', 'VN', 'UM', 'TL', 'SK', 'PH', 'NF', 'ME', 'BZ', 'TM', 'SL', 'MF', 'NG', 'AZ', 
        'TN', 'SM', 'MG', 'KE', 'GA', 'GB', 'TO', 'SN', 'PK', 'NI', 'YT', 'MH', 'JE', 'ID', 'SO', 'WS', 
        'PL', 'KG', 'IE', 'ZW', 'PM', 'RO', 'LI', 'GD', 'KH', 'TR', 'PN', 'OM', 'NL', 'MK', 'KI', 'GE', 
        'EC', 'CA', 'US', 'VU', 'SR', 'LK', 'ML', 'GF', 'BA'
    }
    
    def __init__(self, catalog: str = "Sandbox"):
        """
        Initialize the mapper.
        
        Args:
            catalog: Partner Central catalog ("Sandbox" or "AWS")
        """
        self.catalog = catalog
    
    def map_opportunity_to_ace(
        self, 
        opp: SalesforceOpportunity, 
        project_title: Optional[str] = None
    ) -> Dict:
        """
        Map a Salesforce opportunity to Partner Central opportunity payload.
        
        Args:
            opp: SalesforceOpportunity object with opportunity data
            project_title: Optional custom project title (defaults to opportunity name)
            
        Returns:
            Dict containing the complete Partner Central CreateOpportunity payload
        """
        import time
        timestamp = int(time.time())
        
        # Map customer data
        customer = self._map_customer(opp, timestamp)
        
        # Map project data
        project = self._map_project(opp, project_title, timestamp)
        
        # Map lifecycle data
        lifecycle = self._map_lifecycle(opp)
        
        # Generate unique identifiers
        partner_opp_id = self._generate_partner_opportunity_id(opp, timestamp)
        client_token = self._generate_client_token(opp, timestamp)
        
        # Build complete payload
        payload = {
            "Catalog": self.catalog,
            "ClientToken": client_token,
            "Customer": customer,
            "LifeCycle": lifecycle,
            "Marketing": self._map_marketing(opp),
            "OpportunityType": self._map_opportunity_type(opp),
            "Origin": "Partner Referral",
            "PrimaryNeedsFromAws": self._map_primary_needs(opp),
            "Project": project,
            "PartnerOpportunityIdentifier": partner_opp_id
        }
        
        logger.info(f"Mapped Salesforce opportunity {opp.opportunity_id} to Partner Central payload")
        return payload
    
    def _map_customer(self, opp: SalesforceOpportunity, timestamp: int) -> Dict:
        """Map customer/account information"""
        properties = opp.properties
        
        # Extract contact info
        contact = self._map_contact(opp)
        
        # Build account
        company_name = self._generate_company_name(opp, timestamp)
        
        return {
            "Account": {
                "CompanyName": company_name,
                "Industry": self._map_industry(opp),
                "WebsiteUrl": properties.get('website', self.DEFAULT_WEBSITE),
                "Address": self._map_address(opp)
            },
            "Contacts": [contact]
        }
    
    def _map_contact(self, opp: SalesforceOpportunity) -> Dict:
        """Map contact information from Salesforce opportunity"""
        properties = opp.properties
        
        # Get and validate phone number
        raw_phone = properties.get('contact_phone') or ''
        phone = self._format_phone_number(raw_phone)
        
        # Parse contact name into first/last
        first_name = properties.get('contact_first_name') or 'Unknown'
        last_name = properties.get('contact_last_name') or 'Contact'
        
        if first_name == 'Unknown' and opp.contact_name:
            parts = opp.contact_name.split(' ', 1)
            first_name = parts[0] if parts else 'Unknown'
            last_name = parts[1] if len(parts) > 1 else 'Contact'
        
        return {
            "FirstName": first_name,
            "LastName": last_name,
            "Email": opp.contact_email or 'contact@example.com',
            "Phone": phone,
            "BusinessTitle": properties.get('contact_title') or self.DEFAULT_BUSINESS_TITLE
        }
    
    def _format_phone_number(self, phone: str) -> str:
        """
        Format phone number to E.164 format required by Partner Central.
        """
        import re
        
        if not phone:
            return self.DEFAULT_PHONE
        
        # Remove all non-digit characters except leading +
        cleaned = re.sub(r'[^\d+]', '', str(phone))
        
        # If already in E.164 format, validate and return
        if cleaned.startswith('+'):
            if re.match(r'^\+[1-9]\d{1,14}$', cleaned):
                return cleaned
            else:
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
        
        logger.warning(f"Could not parse phone number '{phone}', using default")
        return self.DEFAULT_PHONE
    
    def _map_address(self, opp: SalesforceOpportunity) -> Dict:
        """Map address information"""
        properties = opp.properties
        
        # Get country and convert to ISO code if needed
        raw_country = properties.get('billing_country_code') or properties.get('billing_country') or ''
        country_code = self._convert_country_to_code(raw_country)
        
        # Get state and convert abbreviation to full name if needed (for US)
        raw_state = properties.get('billing_state') or ''
        state = self._convert_state_to_full_name(raw_state, country_code)
        
        # Use 'or' to handle both missing keys AND None values
        return {
            "CountryCode": country_code,
            "StateOrRegion": state,
            "City": properties.get('billing_city') or self.DEFAULT_CITY,
            "PostalCode": properties.get('billing_postal_code') or self.DEFAULT_POSTAL_CODE,
            "StreetAddress": properties.get('billing_street') or self.DEFAULT_STREET
        }
    
    def _convert_state_to_full_name(self, state: str, country_code: str) -> str:
        """
        Convert US state abbreviation to full name.
        
        Partner Central requires full state names (e.g., "New York") not abbreviations (e.g., "NY").
        For non-US countries, returns the state as-is.
        """
        if not state:
            return self.DEFAULT_STATE
        
        state_stripped = state.strip()
        
        # Only convert for US addresses
        if country_code == 'US':
            state_upper = state_stripped.upper()
            
            # If it's a 2-letter abbreviation, convert to full name
            if len(state_upper) == 2 and state_upper in self.US_STATE_ABBREV_TO_NAME:
                full_name = self.US_STATE_ABBREV_TO_NAME[state_upper]
                logger.info(f"Converted state '{state}' to '{full_name}'")
                return full_name
            
            # Check if it's already a valid full state name
            if state_stripped in self.VALID_US_STATES:
                return state_stripped
            
            # Try case-insensitive match against valid states
            state_lower = state_stripped.lower()
            for valid_state in self.VALID_US_STATES:
                if valid_state.lower() == state_lower:
                    return valid_state
            
            logger.warning(f"Could not validate US state '{state}', using default '{self.DEFAULT_STATE}'")
            return self.DEFAULT_STATE
        
        # For non-US countries, return as-is
        return state_stripped
    
    def _convert_country_to_code(self, country: str) -> str:
        """
        Convert country name or code to valid ISO 2-letter code.
        
        Salesforce may store full country names (e.g., "United States") or codes.
        Partner Central requires ISO 2-letter codes (e.g., "US").
        """
        if not country:
            return self.DEFAULT_COUNTRY_CODE
        
        country_upper = country.strip().upper()
        
        # If it's already a valid 2-letter code, return it
        if len(country_upper) == 2 and country_upper in self.VALID_COUNTRY_CODES:
            return country_upper
        
        # Try to find in our name-to-code mapping
        country_lower = country.strip().lower()
        if country_lower in self.COUNTRY_NAME_TO_CODE:
            return self.COUNTRY_NAME_TO_CODE[country_lower]
        
        # Try partial matching for common variations
        for name, code in self.COUNTRY_NAME_TO_CODE.items():
            if name in country_lower or country_lower in name:
                logger.info(f"Matched country '{country}' to code '{code}'")
                return code
        
        logger.warning(f"Could not map country '{country}' to ISO code, using default '{self.DEFAULT_COUNTRY_CODE}'")
        return self.DEFAULT_COUNTRY_CODE
    
    def _map_project(
        self, 
        opp: SalesforceOpportunity, 
        project_title: Optional[str],
        timestamp: int
    ) -> Dict:
        """Map project information"""
        return {
            "Title": project_title or opp.name,
            "CustomerBusinessProblem": self._map_business_problem(opp),
            "CustomerUseCase": self._map_use_case(opp),
            "OtherSolutionDescription": self._map_solution_description(opp),
            "DeliveryModels": [self._map_delivery_model(opp)],
            "SalesActivities": [self._map_sales_activity(opp)],
            "ExpectedCustomerSpend": [self._map_expected_spend(opp, timestamp)]
        }
    
    def _map_business_problem(self, opp: SalesforceOpportunity) -> str:
        """Map customer business problem."""
        if opp.properties.get('customer_business_problem'):
            return opp.properties['customer_business_problem']
        
        if opp.description:
            return opp.description[:500]
        
        # Default based on stage
        stage_problems = {
            'prospecting': 'Initial discovery - understanding customer needs',
            'qualification': 'Customer has identified need for cloud solution',
            'needs analysis': 'Evaluating AWS solutions for business requirements',
            'value proposition': 'Demonstrating value of AWS solution',
            'id. decision makers': 'Identifying key stakeholders',
            'perception analysis': 'Understanding customer perception',
            'proposal/price quote': 'Preparing proposal for AWS engagement',
            'negotiation/review': 'Finalizing terms for AWS engagement',
            'closed won': 'AWS solution selected',
            'closed lost': 'Opportunity closed'
        }
        
        return stage_problems.get(
            opp.stage.lower(), 
            'Opportunity from Salesforce - New Business'
        )
    
    def _map_use_case(self, opp: SalesforceOpportunity) -> str:
        """Map customer use case with validation"""
        use_case = opp.properties.get('use_case', '')
        
        if use_case and use_case in self.VALID_USE_CASES:
            return use_case
        
        # Try case-insensitive match
        if use_case:
            use_case_lower = use_case.lower()
            for valid_uc in self.VALID_USE_CASES:
                if valid_uc.lower() == use_case_lower:
                    return valid_uc
        
        return self.DEFAULT_CUSTOMER_USE_CASE
    
    def _map_solution_description(self, opp: SalesforceOpportunity) -> str:
        """Map solution description"""
        return opp.properties.get('solution_description', 'Partner Solution')
    
    def _map_delivery_model(self, opp: SalesforceOpportunity) -> str:
        """Map delivery model with validation."""
        delivery_model = opp.properties.get('delivery_model', '')
        
        if delivery_model and delivery_model in self.VALID_DELIVERY_MODELS:
            return delivery_model
        
        # Try case-insensitive match
        if delivery_model:
            dm_lower = delivery_model.lower()
            for valid_dm in self.VALID_DELIVERY_MODELS:
                if valid_dm.lower() == dm_lower:
                    return valid_dm
        
        return self.DEFAULT_DELIVERY_MODEL
    
    def _map_sales_activity(self, opp: SalesforceOpportunity) -> str:
        """Map sales activity based on Salesforce stage with validation."""
        stage_activities = {
            'prospecting': 'Initialized discussions with customer',
            'qualification': 'Customer has shown interest in solution',
            'needs analysis': 'Conducted POC / Demo',
            'value proposition': 'Conducted POC / Demo',
            'id. decision makers': 'In evaluation / planning stage',
            'perception analysis': 'In evaluation / planning stage',
            'proposal/price quote': 'Agreed on solution to Business Problem',
            'negotiation/review': 'Completed Action Plan',
            'closed won': 'SOW Signed'
        }
        
        activity = stage_activities.get(opp.stage.lower(), self.DEFAULT_SALES_ACTIVITY)
        
        # Validate the activity is in the allowed set
        if activity in self.VALID_SALES_ACTIVITIES:
            return activity
        
        return self.DEFAULT_SALES_ACTIVITY
    
    def _map_expected_spend(self, opp: SalesforceOpportunity, timestamp: int) -> Dict:
        """Map expected customer spend with currency validation"""
        amount = str(int(opp.amount)) if opp.amount else self.DEFAULT_AMOUNT
        
        # Validate currency code
        currency = opp.properties.get('currency_iso_code', '').upper()
        if currency not in self.VALID_CURRENCY_CODES:
            currency = self.DEFAULT_CURRENCY
        
        return {
            "Amount": amount,
            "CurrencyCode": currency,
            "Frequency": self.DEFAULT_SPEND_FREQUENCY,
            "TargetCompany": opp.properties.get('target_company', 'AWS')
        }
    
    def _map_lifecycle(self, opp: SalesforceOpportunity) -> Dict:
        """Map lifecycle information"""
        return {
            "Stage": self._map_stage(opp),
            "ReviewStatus": "Pending Submission",
            "TargetCloseDate": self._map_close_date(opp)
        }
    
    def _map_stage(self, opp: SalesforceOpportunity) -> str:
        """
        Map Salesforce opportunity stage to Partner Central stage with validation.
        """
        stage_mapping = {
            'prospecting': 'Prospect',
            'qualification': 'Qualified',
            'needs analysis': 'Technical Validation',
            'value proposition': 'Technical Validation',
            'id. decision makers': 'Business Validation',
            'perception analysis': 'Business Validation',
            'proposal/price quote': 'Committed',
            'negotiation/review': 'Committed',
            'closed won': 'Launched',
            'closed lost': 'Closed Lost'
        }
        
        stage = stage_mapping.get(opp.stage.lower(), 'Prospect')
        
        # Validate the stage is in the allowed set
        if stage in self.VALID_STAGES:
            return stage
        
        return 'Prospect'
    
    def _map_close_date(self, opp: SalesforceOpportunity) -> str:
        """Map close date ensuring it's at least MIN_CLOSE_DATE_DAYS in the future."""
        min_close_date = (
            datetime.now() + timedelta(days=self.MIN_CLOSE_DATE_DAYS)
        ).strftime('%Y-%m-%d')
        
        if not opp.close_date:
            return min_close_date
        
        try:
            closedate_str = opp.close_date
            if isinstance(closedate_str, str):
                # Salesforce typically returns YYYY-MM-DD format
                if 'T' in closedate_str:
                    parsed_date = datetime.fromisoformat(closedate_str.replace('Z', '+00:00'))
                    parsed_date_str = parsed_date.strftime('%Y-%m-%d')
                else:
                    parsed_date_str = closedate_str[:10]  # Take just the date part
            else:
                parsed_date_str = str(closedate_str)[:10]
            
            if parsed_date_str > min_close_date:
                return parsed_date_str
        except (ValueError, TypeError) as e:
            logger.warning(f"Failed to parse close date '{opp.close_date}': {e}")
        
        return min_close_date
    
    def _map_marketing(self, opp: SalesforceOpportunity) -> Dict:
        """Map marketing information with validation"""
        source = opp.properties.get('lead_source', '')
        
        # Partner Central only accepts specific marketing source values
        if source and source in self.VALID_MARKETING_SOURCES:
            return {"Source": source}
        
        # Map common Salesforce lead sources to Partner Central values
        if source:
            source_lower = source.lower()
            if any(term in source_lower for term in ['marketing', 'campaign', 'event', 'webinar', 'email']):
                return {"Source": "Marketing Activity"}
        
        return {"Source": "None"}
    
    def _map_opportunity_type(self, opp: SalesforceOpportunity) -> str:
        """Map opportunity type with validation."""
        opp_type = opp.properties.get('type', '')
        
        # Direct match
        if opp_type and opp_type in self.VALID_OPPORTUNITY_TYPES:
            return opp_type
        
        # Map common Salesforce opportunity types
        type_mapping = {
            'new customer': 'Net New Business',
            'new business': 'Net New Business',
            'existing customer - upgrade': 'Expansion',
            'existing customer - replacement': 'Flat Renewal',
            'existing customer - downgrade': 'Flat Renewal',
            'existing business': 'Expansion',
            'renewal': 'Flat Renewal',
            'upsell': 'Expansion',
            'cross-sell': 'Expansion',
            'expansion': 'Expansion',
        }
        
        if opp_type:
            mapped = type_mapping.get(opp_type.lower())
            if mapped:
                return mapped
        
        return 'Net New Business'
    
    def _map_primary_needs(self, opp: SalesforceOpportunity) -> list:
        """Map primary needs from AWS with validation."""
        needs = opp.properties.get('primary_needs', [])
        
        if isinstance(needs, list):
            # Filter to only valid needs
            valid_needs = [n for n in needs if n in self.VALID_PRIMARY_NEEDS]
            if valid_needs:
                return valid_needs
        elif isinstance(needs, str) and needs in self.VALID_PRIMARY_NEEDS:
            return [needs]
        
        return ["Co-Sell - Architectural Validation"]
    
    def _map_industry(self, opp: SalesforceOpportunity) -> str:
        """Map industry from Salesforce Account with validation."""
        industry = opp.properties.get('account_industry', '')
        
        # Direct match against valid industries
        if industry and industry in self.VALID_INDUSTRIES:
            return industry
        
        # Try case-insensitive match
        if industry:
            industry_lower = industry.lower()
            for valid_ind in self.VALID_INDUSTRIES:
                if valid_ind.lower() == industry_lower:
                    return valid_ind
        
        # Map common Salesforce industries to Partner Central values
        industry_mapping = {
            'technology': 'Software and Internet',
            'software': 'Software and Internet',
            'internet': 'Software and Internet',
            'it services': 'Software and Internet',
            'information technology': 'Software and Internet',
            'finance': 'Financial Services',
            'financial': 'Financial Services',
            'banking': 'Financial Services',
            'insurance': 'Financial Services',
            'healthcare': 'Healthcare',
            'health care': 'Healthcare',
            'medical': 'Healthcare',
            'retail': 'Retail',
            'consumer': 'Consumer Goods',
            'manufacturing': 'Manufacturing',
            'industrial': 'Manufacturing',
            'education': 'Education',
            'higher education': 'Education',
            'government': 'Government',
            'public sector': 'Government',
            'federal': 'Government',
            'media': 'Media and Entertainment',
            'entertainment': 'Media and Entertainment',
            'telecommunications': 'Telecommunications',
            'telecom': 'Telecommunications',
            'communications': 'Telecommunications',
            'energy': 'Energy - Power and Utilities',
            'utilities': 'Energy - Power and Utilities',
            'oil': 'Energy - Oil and Gas',
            'gas': 'Energy - Oil and Gas',
            'hospitality': 'Hospitality',
            'hotel': 'Hospitality',
            'transportation': 'Transportation and Logistics',
            'logistics': 'Transportation and Logistics',
            'shipping': 'Transportation and Logistics',
            'travel': 'Travel',
            'aerospace': 'Aerospace',
            'defense': 'Aerospace',
            'agriculture': 'Agriculture',
            'farming': 'Agriculture',
            'automotive': 'Automotive',
            'electronics': 'Computers and Electronics',
            'semiconductor': 'Computers and Electronics',
            'gaming': 'Gaming',
            'life sciences': 'Life Sciences',
            'pharmaceutical': 'Life Sciences',
            'biotech': 'Life Sciences',
            'mining': 'Mining',
            'non-profit': 'Non-Profit Organization',
            'nonprofit': 'Non-Profit Organization',
            'ngo': 'Non-Profit Organization',
            'professional services': 'Professional Services',
            'consulting': 'Professional Services',
            'real estate': 'Real Estate and Construction',
            'construction': 'Real Estate and Construction',
            'wholesale': 'Wholesale and Distribution',
            'distribution': 'Wholesale and Distribution',
            'marketing': 'Marketing and Advertising',
            'advertising': 'Marketing and Advertising',
        }
        
        if industry:
            industry_lower = industry.lower()
            for key, value in industry_mapping.items():
                if key in industry_lower:
                    return value
        
        return self.DEFAULT_INDUSTRY
    
    def _generate_company_name(self, opp: SalesforceOpportunity, timestamp: int) -> str:
        """Generate unique company name for Partner Central."""
        if opp.account_name:
            return f"{opp.account_name}-{timestamp}"
        return f"SFOpportunity-{timestamp}"
    
    def _generate_partner_opportunity_id(self, opp: SalesforceOpportunity, timestamp: int) -> str:
        """Generate unique partner opportunity identifier."""
        return f"SF-{opp.opportunity_id}-{timestamp}"
    
    def _generate_client_token(self, opp: SalesforceOpportunity, timestamp: int) -> str:
        """Generate unique client token for idempotency"""
        safe_name = opp.name.replace(' ', '-')[:20]
        return f"salesforce-{safe_name}-{timestamp}"


class PartnerCentralToSalesforceMapper:
    """
    Maps Partner Central opportunity data back to Salesforce opportunity format.
    
    Use this for bi-directional sync to keep Salesforce opportunities updated
    when Partner Central opportunity status changes.
    """
    
    # Partner Central ReviewStatus → Salesforce Stage mapping
    REVIEW_STATUS_TO_STAGE = {
        "Pending Submission": "Prospecting",
        "Submitted": "Qualification",
        "In Review": "Qualification",
        "Action Required": "Needs Analysis",
        "Approved": "Proposal/Price Quote",
        "Rejected": "Closed Lost"
    }
    
    # Partner Central Stage → Salesforce Stage mapping
    PC_STAGE_TO_SALESFORCE = {
        "Prospect": "Prospecting",
        "Qualified": "Qualification",
        "Technical Validation": "Needs Analysis",
        "Business Validation": "Id. Decision Makers",
        "Committed": "Negotiation/Review",
        "Launched": "Closed Won",
        "Closed Lost": "Closed Lost"
    }
    
    def __init__(self):
        pass
    
    def map_opportunity_to_update(self, opportunity: Dict) -> Dict:
        """
        Map Partner Central opportunity fields to Salesforce opportunity update payload.
        
        Uses only **built-in Salesforce Opportunity fields** so this works
        on any Salesforce org without custom-field setup.
        
        Args:
            opportunity: Partner Central opportunity data from GetOpportunity API
            
        Returns:
            Dict containing Salesforce opportunity fields to update
        """
        fields = {}
        
        lifecycle = opportunity.get('LifeCycle', {})
        project = opportunity.get('Project', {})
        
        # --- Built-in Salesforce fields (always available) ---
        
        # Map stage based on ReviewStatus and PC Stage
        sf_stage = self._map_to_salesforce_stage(lifecycle)
        if sf_stage:
            fields['StageName'] = sf_stage
        
        # Map close date
        target_close_date = lifecycle.get('TargetCloseDate')
        if target_close_date:
            fields['CloseDate'] = target_close_date
        
        # Map amount from ExpectedCustomerSpend
        expected_spend = project.get('ExpectedCustomerSpend', [])
        if expected_spend and len(expected_spend) > 0:
            amount = expected_spend[0].get('Amount')
            if amount:
                fields['Amount'] = float(amount)
        
        # Map name from Project Title
        title = project.get('Title')
        if title:
            fields['Name'] = title
        
        # Map Partner Central NextSteps to Salesforce's built-in NextStep field.
        # Salesforce's `NextStep` is a standard field on every Opportunity (255 char limit).
        next_steps = lifecycle.get('NextSteps')
        if next_steps:
            fields['NextStep'] = next_steps[:255]
        
        return fields
    
    def _map_to_salesforce_stage(self, lifecycle: Dict) -> Optional[str]:
        """
        Determine Salesforce stage based on Partner Central ReviewStatus and Stage.
        """
        review_status = lifecycle.get('ReviewStatus', '')
        pc_stage = lifecycle.get('Stage', '')
        
        # For approved opportunities, use PC Stage mapping
        if review_status == 'Approved':
            return self.PC_STAGE_TO_SALESFORCE.get(pc_stage, 'Proposal/Price Quote')
        
        # For non-approved, use ReviewStatus mapping
        return self.REVIEW_STATUS_TO_STAGE.get(review_status)
    
    def get_sync_status(self, opportunity: Dict) -> Dict:
        """Get a summary of the opportunity status for sync decisions."""
        lifecycle = opportunity.get('LifeCycle', {})
        
        return {
            "opportunity_id": opportunity.get('Id'),
            "review_status": lifecycle.get('ReviewStatus'),
            "stage": lifecycle.get('Stage'),
            "recommended_salesforce_stage": self._map_to_salesforce_stage(lifecycle),
            "next_steps": lifecycle.get('NextSteps', '')[:100] + '...' if lifecycle.get('NextSteps') else None
        }


class SalesforceSyncClient:
    """
    Client for syncing Partner Central changes back to Salesforce.
    """
    
    def __init__(self, bearer_token: str = None, instance_url: str = None):
        import os
        self.bearer_token = bearer_token or os.environ.get('SALESFORCE_ACCESS_TOKEN')
        self.instance_url = instance_url or os.environ.get('SALESFORCE_INSTANCE_URL')
        self.mapper = PartnerCentralToSalesforceMapper()
        
        if not self.bearer_token:
            raise ValueError("Salesforce access token required for sync operations")
        if not self.instance_url:
            raise ValueError("Salesforce instance URL required for sync operations")
    
    def _make_request(self, method: str, endpoint: str, data: Dict = None) -> Dict:
        """Make authenticated request to Salesforce API"""
        import requests
        
        url = f"{self.instance_url}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json"
        }
        
        try:
            if method == "GET":
                response = requests.get(url, headers=headers, timeout=30)
            elif method == "PATCH":
                response = requests.patch(url, headers=headers, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            
            response.raise_for_status()
            return response.json() if response.text else {"success": True}
        except Exception as e:
            return {"error": str(e)}
    
    def update_opportunity(self, opportunity_id: str, fields: Dict) -> Dict:
        """
        Update a Salesforce opportunity with new field values.
        
        Args:
            opportunity_id: Salesforce opportunity ID (e.g., 006xxxxxxxxxxxx)
            fields: Dict of fields to update
            
        Returns:
            API response or error
        """
        endpoint = f"/services/data/v59.0/sobjects/Opportunity/{opportunity_id}"
        return self._make_request("PATCH", endpoint, fields)
    
    def sync_from_opportunity(self, sf_opportunity_id: str, pc_opportunity: Dict) -> Dict:
        """
        Sync Partner Central opportunity status back to Salesforce opportunity.
        
        Args:
            sf_opportunity_id: Salesforce opportunity ID to update
            pc_opportunity: Partner Central opportunity data
            
        Returns:
            Dict with sync result
        """
        import logging
        logger = logging.getLogger(__name__)
        
        # Map PC opportunity to Salesforce fields
        fields = self.mapper.map_opportunity_to_update(pc_opportunity)
        
        if not fields:
            return {
                "success": False,
                "error": "No fields to sync"
            }
        
        # Get sync status for logging
        sync_status = self.mapper.get_sync_status(pc_opportunity)
        logger.info(f"Syncing PC opportunity {sync_status['opportunity_id']} to Salesforce opportunity {sf_opportunity_id}")
        logger.info(f"  PC Status: {sync_status['review_status']} / {sync_status['stage']}")
        logger.info(f"  → Salesforce Stage: {sync_status['recommended_salesforce_stage']}")
        
        # Update Salesforce opportunity
        result = self.update_opportunity(sf_opportunity_id, fields)
        
        if "error" in result:
            logger.error(f"Failed to sync to Salesforce: {result['error']}")
            return {
                "success": False,
                "error": result["error"],
                "sync_status": sync_status
            }
        
        logger.info(f"✅ Successfully synced to Salesforce opportunity {sf_opportunity_id}")
        return {
            "success": True,
            "opportunity_id": sf_opportunity_id,
            "updated_fields": fields,
            "sync_status": sync_status
        }
    
    def check_and_sync(self, sf_opportunity_id: str, pc_opportunity_id: str, pc_client) -> Dict:
        """
        Check Partner Central opportunity status and sync to Salesforce.
        
        Args:
            sf_opportunity_id: Salesforce opportunity ID
            pc_opportunity_id: Partner Central opportunity ID
            pc_client: PartnerCentralMCPClient instance
        """
        opportunity = pc_client.get_opportunity(pc_opportunity_id)
        
        if not opportunity:
            return {
                "success": False,
                "error": f"Could not fetch PC opportunity {pc_opportunity_id}"
            }
        
        return self.sync_from_opportunity(sf_opportunity_id, opportunity)
