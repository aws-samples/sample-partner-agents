#!/usr/bin/env python3
"""
Provision (or update) the customisable ACE-payload-override deal properties
in HubSpot. Each property mirrors a field in the ACE CreateOpportunity /
StartEngagement payload that previously was hardcoded; surfacing them as
picklists lets operators customise per-deal without redeploying.

Token source: AWS Secrets Manager (default secret id
``crm-connector/ace-share``, key ``HUBSPOT_PRIVATE_APP_TOKEN``). Override
with env vars ``ACE_SHARE_SECRET_ID``, ``AWS_PROFILE``, and
``AWS_REGION`` — see ``_hubspot_token.py``.

Idempotency: each property is created via POST first; on 409 (already
exists) we PATCH the options to keep the picklist in sync. Default values
in the payload itself live in `backend/lib/payload.ts` — this script only
manages the HubSpot picklist surface.

Run:
    python3 scripts/setup_ace_picklists.py

Safe to re-run; existing deal-property values are preserved.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _hubspot_token import get_hubspot_token  # noqa: E402

GROUP_NAME = "aws_partner_fields"

# --- Picklists ---------------------------------------------------------------
# Each tuple: (option label, option value, display order). Values must match
# ACE's enum spelling exactly — they're sent on the wire when the deal is
# shared.

INDUSTRY = [
    "Aerospace", "Agriculture", "Automotive", "Computers and Electronics",
    "Consumer Goods", "Education", "Energy - Oil and Gas",
    "Energy - Power and Utilities", "Financial Services", "Gaming",
    "Government", "Healthcare", "Hospitality", "Life Sciences",
    "Manufacturing", "Marketing and Advertising", "Media and Entertainment",
    "Mining", "Non-Profit Organization", "Other", "Professional Services",
    "Real Estate and Construction", "Retail", "Software and Internet",
    "Telecommunications", "Transportation and Logistics", "Travel",
    "Wholesale and Distribution",
]

OPPORTUNITY_TYPE = ["Net New Business", "Expansion", "Flat Renewal"]

PRIMARY_NEED_FROM_AWS = [
    "Co-Sell - Architectural Validation",
    "Co-Sell - Business Presentation",
    "Co-Sell - Competitive Information",
    "Co-Sell - Deal Support",
    "Co-Sell - Pricing Assistance",
    "Co-Sell - Support for Public Tender / RFx",
    "Co-Sell - Technical Consultation",
    "Co-Sell - Total Cost of Ownership Evaluation",
]

DELIVERY_MODEL = [
    "SaaS or PaaS", "BYOL or AMI", "Managed Services",
    "Professional Services", "Resell", "Other",
]

SALES_ACTIVITIES = [
    "Initialized discussions with customer",
    "Customer has shown interest in solution",
    "Conducted POC / Demo",
    "In evaluation / planning stage",
    "Agreed on solution to Business Problem",
    "Completed Action Plan",
    "Finalized Deployment Need",
    "SOW Signed",
]

CUSTOMER_USE_CASE = [
    "AI Machine Learning and Analytics",
    "Archiving",
    "Big Data: Data Warehouse / Data Integration / ETL / Data Lake / BI",
    "Blockchain",
    "Business Applications: Mainframe Modernization",
    "Business Applications & Contact Center",
    "Business Applications & SAP Production",
    "Centralized Operations Management",
    "Cloud Management Tools",
    "Cloud Management Tools & DevOps with Continuous Integration & Continuous Delivery (CICD)",
    "Configuration, Compliance & Auditing",
    "Connected Services",
    "Containers & Serverless",
    "Content Delivery & Edge Services",
    "Database",
    "Edge Computing / End User Computing",
    "Energy",
    "Enterprise Governance & Controls",
    "Enterprise Resource Planning",
    "Financial Services",
    "Healthcare and Life Sciences",
    "High Performance Computing",
    "Hybrid Application Platform",
    "Industrial Software",
    "IOT",
    "Manufacturing, Supply Chain and Operations",
    "Media & High performance computing (HPC)",
    "Migration / Database Migration",
    "Monitoring, logging and performance",
    "Monitoring & Observability",
    "Networking",
    "Outpost",
    "SAP",
    "Security & Compliance",
    "Storage & Backup",
    "Training",
    "VMC",
    "VMWare",
    "Web development & DevOps",
]

# Top common currencies. Operators can extend the picklist later if needed.
CURRENCY_CODE = [
    "USD", "EUR", "GBP", "JPY", "CNY", "CAD", "AUD", "CHF", "INR", "BRL",
    "MXN", "SGD", "HKD", "SEK", "NOK", "DKK", "ZAR", "NZD", "TRY", "KRW",
    "RUB", "AED", "ILS", "PLN", "THB",
]

YES_NO = ["No", "Yes"]
INVOLVEMENT_TYPE = ["Co-Sell", "For Visibility Only"]
VISIBILITY = ["Full", "Limited"]


def options(values: Sequence[str]) -> list[dict]:
    """Build HubSpot option dicts in display order."""
    return [
        {"label": v, "value": v, "displayOrder": i} for i, v in enumerate(values)
    ]


# --- Property definitions ----------------------------------------------------

PROPERTIES = [
    {
        "name": "ace_industry",
        "label": "ACE Industry",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Customer industry sent to AWS Partner Central. Defaults to "
            "'Software and Internet' when unset. Must be one of ACE's 28 "
            "industry values; values outside the enum are rejected by ACE."
        ),
        "options": options(INDUSTRY),
    },
    {
        "name": "ace_opportunity_type",
        "label": "ACE Opportunity Type",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "OpportunityType sent on CreateOpportunity. Defaults to "
            "'Net New Business' when unset."
        ),
        "options": options(OPPORTUNITY_TYPE),
    },
    {
        "name": "ace_primary_need_from_aws",
        "label": "ACE Primary Needs from AWS",
        "type": "enumeration",
        "fieldType": "checkbox",
        "groupName": GROUP_NAME,
        "description": (
            "PrimaryNeedsFromAws array sent on CreateOpportunity. Multi-select; "
            "all chosen values are sent. Defaults to "
            "['Co-Sell - Architectural Validation'] when none selected."
        ),
        "options": options(PRIMARY_NEED_FROM_AWS),
    },
    {
        "name": "ace_delivery_model",
        "label": "ACE Delivery Models",
        "type": "enumeration",
        "fieldType": "checkbox",
        "groupName": GROUP_NAME,
        "description": (
            "Project.DeliveryModels array sent on CreateOpportunity. Multi-select; "
            "all chosen values are sent. Defaults to ['SaaS or PaaS'] when "
            "none selected."
        ),
        "options": options(DELIVERY_MODEL),
    },
    {
        "name": "ace_sales_activities",
        "label": "ACE Sales Activities",
        "type": "enumeration",
        "fieldType": "checkbox",
        "groupName": GROUP_NAME,
        "description": (
            "Project.SalesActivities array sent on CreateOpportunity / "
            "UpdateOpportunity. Multi-select; ACE expects activities to "
            "accumulate as the opportunity progresses (e.g. a Committed "
            "opp keeps the earlier 'Initialized discussions' activity). "
            "When blank, the stage-default cumulative array is used."
        ),
        "options": options(SALES_ACTIVITIES),
    },
    {
        "name": "ace_customer_use_case",
        "label": "ACE Customer Use Case",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Project.CustomerUseCase. Defaults to "
            "'Business Applications & Contact Center'. Single-select from "
            "the 39 ACE-accepted values."
        ),
        "options": options(CUSTOMER_USE_CASE),
    },
    {
        "name": "ace_currency_code",
        "label": "ACE Currency Code",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "ExpectedCustomerSpend currency. Defaults to 'USD' when unset. "
            "Picklist contains the top 25 currencies; ACE accepts any "
            "ISO 4217 code if extended later."
        ),
        "options": options(CURRENCY_CODE),
    },
    {
        # Surfaced as a friendly Yes/No question. The TS Lambda payload
        # builder translates Yes → "Marketing Activity" and No → "None"
        # at the wire boundary so ACE still receives its enum-required
        # values.
        "name": "ace_marketing_source",
        "label": "Is Opportunity from Marketing Activity?",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Marketing.Source value sent to ACE. 'No' (default) means "
            "the deal is not sourced from an AWS marketing activity. "
            "'Yes' means it is — and on the wire becomes 'Marketing "
            "Activity', which requires Marketing.AwsFundingUsed to be "
            "set (controlled by the 'ACE AWS Funding Used' field)."
        ),
        "options": options(YES_NO),
    },
    {
        "name": "ace_aws_funding_used",
        "label": "ACE AWS Funding Used",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Marketing.AwsFundingUsed. Only relevant when Marketing.Source = "
            "'Marketing Activity'. Defaults to 'No'."
        ),
        "options": options(YES_NO),
    },
    {
        "name": "ace_involvement_type",
        "label": "ACE Involvement Type",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "AwsSubmission.InvolvementType used by "
            "StartEngagementFromOpportunityTask. Defaults to 'Co-Sell'."
        ),
        "options": options(INVOLVEMENT_TYPE),
    },
    {
        "name": "ace_visibility",
        "label": "ACE Visibility",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "AwsSubmission.Visibility used by "
            "StartEngagementFromOpportunityTask. Defaults to 'Full'."
        ),
        "options": options(VISIBILITY),
    },
    {
        "name": "ace_national_security",
        "label": "ACE National Security",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "NationalSecurity flag on CreateOpportunity. Set to 'Yes' "
            "ONLY when the customer's industry is Government and the "
            "opportunity is national-security related — additional ACE "
            "review steps apply. Defaults to 'No'."
        ),
        "options": options(YES_NO),
    },
]


# --- Plumbing ----------------------------------------------------------------


def upsert_property(token: str, prop: dict) -> str:
    """Create the property, or PATCH its options/description if it exists."""
    name = prop["name"]
    create_url = "https://api.hubapi.com/crm/v3/properties/deals"
    patch_url = f"https://api.hubapi.com/crm/v3/properties/deals/{name}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Try create first.
    req = urllib.request.Request(
        create_url, data=json.dumps(prop).encode(), headers=headers, method="POST"
    )
    try:
        resp = urllib.request.urlopen(req)
        return f"created ({resp.status})"
    except urllib.error.HTTPError as e:
        if e.status != 409:
            return f"create failed: {e.status} {e.read().decode()[:200]}"

    # Already exists — PATCH options, label, and description (skip
    # type/fieldType, those can't be changed).
    patch_body: dict = {
        "description": prop.get("description", ""),
        "label": prop.get("label", ""),
    }
    if "options" in prop:
        patch_body["options"] = prop["options"]
    req = urllib.request.Request(
        patch_url,
        data=json.dumps(patch_body).encode(),
        headers=headers,
        method="PATCH",
    )
    try:
        urllib.request.urlopen(req)
        return "updated"
    except urllib.error.HTTPError as e:
        return f"patch failed: {e.status} {e.read().decode()[:200]}"


def main() -> int:
    token = get_hubspot_token()
    print(f"Provisioning {len(PROPERTIES)} ACE deal properties under group "
          f"'{GROUP_NAME}'\n")
    for prop in PROPERTIES:
        result = upsert_property(token, prop)
        print(f"  {prop['name']:32s} {prop.get('fieldType','?'):8s} {result}")
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
