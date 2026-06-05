#!/usr/bin/env python3
"""
Provision (or update) the bidirectional ACE-payload deal properties in
HubSpot. Each editable ACE field gets:

  - An `ace_*` OVERRIDE property: operator-edited; flows HubSpot → AWS on
    Share/Update.
  - An `aws_*` MIRROR property: read-only mirror of the live AWS-side
    value; refreshed on every Share / Refresh round-trip.

Run: `python3 scripts/setup_ace_bidirectional_fields.py`

Token source: AWS Secrets Manager (default secret id
``crm-connector/ace-share``, key ``HUBSPOT_PRIVATE_APP_TOKEN``). Override
with env vars ``ACE_SHARE_SECRET_ID``, ``AWS_PROFILE``, and
``AWS_REGION`` — see ``_hubspot_token.py``.

Idempotent: each property is created via POST first; on 409 (already
exists) we PATCH the description and (when applicable) the picklist
options to keep the field in sync. Existing deal-property values are
preserved.

This script complements `setup_ace_picklists.py` (the original 11
override picklists). Run both — they don't conflict.
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

# --- ACE enum picklists (from the AWS SDK
# `client-partnercentral-selling/dist-types/models/enums.d.ts`) ----------------

COMPETITOR_NAME = [
    "Akamai", "AliCloud", "Co-location", "Google Cloud Platform",
    "IBM Softlayer", "Microsoft Azure", "No Competition", "On-Prem",
    "Oracle Cloud", "*Other", "Other- Cost Optimization",
]

CLOSED_LOST_REASON = [
    "Customer Deficiency", "Customer Experience",
    "Delay / Cancellation of Project", "Financial/Commercial",
    "Legal / Tax / Regulatory", "Lost to Competitor - Google",
    "Lost to Competitor - Microsoft", "Lost to Competitor - Other",
    "Lost to Competitor - SoftLayer", "Lost to Competitor - VMWare",
    "No Opportunity", "On Premises Deployment", "Other", "Partner Gap",
    "People/Relationship/Governance", "Price", "Product/Technology",
    "Security / Compliance", "Technical Limitations",
]

AWS_PARTITION = ["aws-eusc"]

APN_PROGRAMS = [
    "APN Immersion Days", "APN Solution Space",
    "ATO (Authority to Operate)", "AWS Marketplace Campaign",
    "IS Immersion Day SFID Program", "ISV Workload Migration",
    "Migration Acceleration Program", "P3", "Partner Launch Initiative",
    "Partner Opportunity Acceleration Funded", "The Next Smart",
    "VMware Cloud on AWS", "Well-Architected", "Windows",
    "Workspaces/AppStream Accelerator Program", "WWPS NDPP",
]

# Marketing.Channels enum values per the AWS SDK
# (`@aws-sdk/client-partnercentral-selling/dist-types/models/enums.d.ts`).
MARKETING_CHANNELS = [
    "AWS Marketing Central", "Content Syndication", "Display",
    "Email", "Live Event", "Out Of Home (OOH)", "Print", "Search",
    "Social", "Telemarketing", "TV", "Video", "Virtual Event",
]

# Marketing.UseCases is documented as a free-text string array on the
# AWS wire (see SDK type `string[] | undefined`). Partner Central's
# UI surfaces a curated picklist but the API itself does NOT validate
# against a closed enum — values like "Analytics" appear in real
# Sandbox data even though they're not in the UI list. So the HubSpot
# property is provisioned as free-text (single-line string) and Refresh
# writes the AWS value verbatim. Operators can still type any of the
# Partner Central UI's labels by hand. No HubSpot-side enum to maintain.


def options(values: Sequence[str]) -> list[dict]:
    return [
        {"label": v, "value": v, "displayOrder": i}
        for i, v in enumerate(values)
    ]


# --- Property definitions ----------------------------------------------------
#
# Override fields (ace_*) are editable single-line / textarea / picklist /
# multi-select properties. Mirror fields (aws_*) are read-only single-line
# strings the operator should not edit (HubSpot has no "read-only" attribute
# on the property itself; we rely on convention + the card UI not exposing
# an editor).

PROPERTIES: list[dict] = [
    # ========== Project — text-area overrides ==========
    {
        "name": "ace_additional_comments",
        "label": "ACE Additional Comments",
        "type": "string",
        "fieldType": "textarea",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Project.AdditionalComments — Share writes "
            "the HubSpot value to AWS; Refresh writes the AWS value "
            "back here. Omitted from ACE payload when blank."
        ),
    },
    {
        "name": "ace_other_competitor_names",
        "label": "ACE Other Competitor Names",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Project.OtherCompetitorNames — only "
            "applies when Project.CompetitorName is '*Other'. Omitted "
            "from ACE payload when blank."
        ),
    },
    {
        "name": "ace_other_solution_description",
        "label": "ACE Other Solution Description",
        "type": "string",
        "fieldType": "textarea",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Project.OtherSolutionDescription — "
            "describes the offered solution when "
            "RelatedEntityIdentifiers.Solutions = 'Other'. Omitted "
            "from ACE payload when blank."
        ),
    },
    # ========== Project — picklists ==========
    {
        "name": "ace_competitor_name",
        "label": "ACE Competitor Name",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Project.CompetitorName, ACE-defined enum. "
            "Leave blank to omit (ACE rejects empty strings on enum "
            "fields)."
        ),
        "options": options(COMPETITOR_NAME),
    },
    {
        "name": "ace_aws_partition",
        "label": "ACE AWS Partition",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Project.AwsPartition. Set to 'aws-eusc' "
            "for AWS European Sovereign Cloud opportunities; leave "
            "blank for all other partitions (default)."
        ),
        "options": options(AWS_PARTITION),
    },
    {
        "name": "ace_apn_programs",
        "label": "ACE APN Programs",
        "type": "enumeration",
        "fieldType": "checkbox",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Project.ApnPrograms — multi-select. "
            "Programs that influenced the opportunity. Omitted from "
            "ACE payload when none selected."
        ),
        "options": options(APN_PROGRAMS),
    },
    # ========== LifeCycle picklist ==========
    {
        "name": "ace_closed_lost_reason",
        "label": "ACE Closed Lost Reason",
        "type": "enumeration",
        "fieldType": "select",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. LifeCycle.ClosedLostReason — only sent "
            "to ACE when stage is 'Closed Lost'. Required by ACE in "
            "that stage; ignored otherwise."
        ),
        "options": options(CLOSED_LOST_REASON),
    },
    # ========== Customer.Account overrides ==========
    {
        "name": "ace_aws_account_id",
        "label": "ACE Customer AWS Account ID",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Customer.Account.AwsAccountId — must "
            "match regex ([0-9]{12}|\\w{1,12}). Omitted from ACE "
            "payload when blank — ACE rejects empty strings on this "
            "field with INVALID_STRING_FORMAT."
        ),
    },
    {
        "name": "ace_duns",
        "label": "ACE Customer DUNS",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Customer.Account.Duns — must be exactly "
            "9 digits. Omitted from ACE payload when blank — ACE "
            "rejects empty strings on this field with "
            "INVALID_STRING_FORMAT."
        ),
    },
    {
        "name": "ace_street_address",
        "label": "ACE Customer Street Address",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Customer.Account.Address.StreetAddress — "
            "free-text. Defaults to absent (HubSpot companies don't "
            "have a street-address field by default). Set per-deal "
            "when ACE submission requires it."
        ),
    },
    # ========== Customer.Account — deal-level fallback fields ==========
    # Mirrors of the company-sourced Customer.Account.* fields, copied
    # to the deal so reverse-synced opportunities (no associated
    # HubSpot company) can be Shared without forcing the rep to
    # attach a company first. The Share path uses these as fallbacks
    # when the company association is empty; the company association
    # remains canonical for company-originated deals. A HubSpot
    # workflow on the operator side can copy these values from the
    # associated company on association.
    {
        "name": "ace_company_name",
        "label": "ACE Customer Company Name",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Deal-level fallback for "
            "Customer.Account.CompanyName. Used when the deal has no "
            "associated HubSpot company (e.g. reverse-synced from "
            "AWS via EventBridge). When the deal IS associated with a "
            "company, this field is overridden by the company's name."
        ),
    },
    {
        "name": "ace_country_code",
        "label": "ACE Customer Country Code",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Deal-level fallback for "
            "Customer.Account.Address.CountryCode (ISO 3166-1 alpha-2, "
            "e.g. US, IE, AU). Used when the deal has no associated "
            "HubSpot company."
        ),
    },
    {
        "name": "ace_postal_code",
        "label": "ACE Customer Postal Code",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Deal-level fallback for "
            "Customer.Account.Address.PostalCode. Required by ACE's "
            "SubmitOpportunity step. Used when the deal has no "
            "associated HubSpot company."
        ),
    },
    {
        "name": "ace_state_or_region",
        "label": "ACE Customer State or Region",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Deal-level fallback for "
            "Customer.Account.Address.StateOrRegion. Required by ACE "
            "for US opportunities. Used when the deal has no associated "
            "HubSpot company."
        ),
    },
    {
        "name": "ace_city",
        "label": "ACE Customer City",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Deal-level fallback for "
            "Customer.Account.Address.City. Used when the deal has no "
            "associated HubSpot company."
        ),
    },
    {
        "name": "ace_website_url",
        "label": "ACE Customer Website URL",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Deal-level fallback for "
            "Customer.Account.WebsiteUrl. Plain hostnames are accepted "
            "(https:// is added automatically). Used when the deal has "
            "no associated HubSpot company."
        ),
    },
    # ========== Marketing.* sub-fields (Marketing Activity flow) ==========
    # Surfaced when ace_marketing_source = "Yes" (i.e.
    # Marketing.Source = "Marketing Activity"). All optional; empty
    # values are NOT sent to ACE. Refresh round-trips them back so
    # AWS-side edits are visible in HubSpot.
    {
        "name": "ace_marketing_campaign_name",
        "label": "ACE Marketing Campaign Name",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Marketing.CampaignName — free-text "
            "campaign identifier sent when ace_marketing_source is "
            "'Yes'. Empty values are not sent to ACE."
        ),
    },
    {
        "name": "ace_marketing_use_cases",
        "label": "ACE Marketing Use Cases",
        "type": "string",
        "fieldType": "text",
        "groupName": GROUP_NAME,
        "description": (
            "Bidirectional. Marketing.UseCases — a `;`-separated "
            "list of use-case labels (e.g. 'Analytics;Big Data'). "
            "Sent when ace_marketing_source is 'Yes'. Free-text "
            "rather than a closed picklist because AWS documents "
            "UseCases as a string array (not a fixed enum) and "
            "Partner Central's UI may surface values our list "
            "doesn't anticipate. Empty values are not sent to ACE."
        ),
    },
    {
        "name": "ace_marketing_channels",
        "label": "ACE Marketing Channels",
        "type": "enumeration",
        "fieldType": "checkbox",
        "groupName": GROUP_NAME,
        "options": options(MARKETING_CHANNELS),
        "description": (
            "Bidirectional. Marketing.Channels — multi-select from "
            "ACE's closed Channel enum. Sent when ace_marketing_source "
            "is 'Yes'."
        ),
    },
]


# --- Mirror (read-only-by-convention) properties ----------------------------
# Single line strings. Multi-select picklists from ACE are serialised as
# `;`-separated strings so they fit in a string field.
#
# Bidirectional model (post-consolidation): every editable ACE field is
# round-tripped through its `ace_*` operator-edited property — Share
# pushes HubSpot → AWS, Refresh pulls AWS → HubSpot into the SAME
# field. The `aws_*` properties below are limited to AWS-side state
# that has NO operator-controlled equivalent (review status / stage /
# reviewer feedback). Anything else would be duplicate clutter.

MIRROR_FIELDS: list[tuple[str, str, str]] = [
    ("aws_review_comments", "AWS Review Comments (mirror)",
     "LifeCycle.ReviewComments — feedback from the AWS reviewer. "
     "Read-only."),
    ("aws_review_status_reason", "AWS Review Status Reason (mirror)",
     "LifeCycle.ReviewStatusReason — applies when ReviewStatus is "
     "Rejected or Action Required. Read-only."),
]

for name, label, desc in MIRROR_FIELDS:
    PROPERTIES.append(
        {
            "name": name,
            "label": label,
            "type": "string",
            "fieldType": "text",
            "groupName": GROUP_NAME,
            "description": desc,
        }
    )


# --- Plumbing ----------------------------------------------------------------


def upsert_property(token: str, prop: dict) -> str:
    """Create the property; on 409, PATCH the description (and options
    when present)."""
    name = prop["name"]
    create_url = "https://api.hubapi.com/crm/v3/properties/deals"
    patch_url = f"https://api.hubapi.com/crm/v3/properties/deals/{name}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(
        create_url, data=json.dumps(prop).encode(), headers=headers,
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req)
        return f"created ({resp.status})"
    except urllib.error.HTTPError as e:
        if e.status != 409:
            return f"create failed: {e.status} {e.read().decode()[:200]}"

    patch_body: dict = {
        "description": prop.get("description", ""),
        "label": prop.get("label", ""),
    }
    if "options" in prop:
        patch_body["options"] = prop["options"]
    req = urllib.request.Request(
        patch_url, data=json.dumps(patch_body).encode(),
        headers=headers, method="PATCH",
    )
    try:
        urllib.request.urlopen(req)
        return "updated"
    except urllib.error.HTTPError as e:
        return f"patch failed: {e.status} {e.read().decode()[:200]}"


def main() -> int:
    token = get_hubspot_token()
    print(
        f"Provisioning {len(PROPERTIES)} bidirectional ACE deal "
        f"properties under group '{GROUP_NAME}'\n"
    )
    for prop in PROPERTIES:
        result = upsert_property(token, prop)
        print(f"  {prop['name']:36s} {prop.get('fieldType','?'):8s} {result}")
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
