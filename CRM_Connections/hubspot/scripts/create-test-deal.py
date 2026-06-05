#!/usr/bin/env python3
"""
Create (or update) a HubSpot deal with everything the Share Lambda
needs to pass preconditions: name, stage, amount, future close date,
description ≥20 chars, customer location (country, state, postal
code), the full ACE classification picklists (use case, industry,
involvement type, visibility, opportunity type, delivery models),
plus a Solution Offering OR a free-text fallback.

Used by the workshop (Lab 12a) to bootstrap a fresh test account that
has no deals yet. Idempotent: re-running with the same `--name`
updates the existing deal in place rather than creating a duplicate.

Defaults match what `setup_ace_picklists.py` and Lab 13's smoke test
expect — running this against a freshly-provisioned portal produces
a deal that's immediately ready to Share.

Token source: AWS Secrets Manager (default secret id
``crm-connector/ace-share``, key ``HUBSPOT_PRIVATE_APP_TOKEN``).
Override with ``ACE_SHARE_SECRET_ID``, ``AWS_PROFILE``, ``AWS_REGION``
— see ``_hubspot_token.py``. If ``HUBSPOT_PRIVATE_APP_TOKEN`` is
already set in the environment, that takes precedence and Secrets
Manager isn't read.

Usage:
    python3 scripts/create-test-deal.py
    python3 scripts/create-test-deal.py --name "Smoke Test 2"
    python3 scripts/create-test-deal.py --solution S-1234567

Exit codes:
  0 — created or updated successfully.
  1 — token / scope failure.
  2 — HubSpot API error.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _hubspot_token import get_hubspot_token  # noqa: E402

API_BASE = "https://api.hubapi.com"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create or update a workshop test deal."
    )
    parser.add_argument(
        "--name",
        default="Workshop Smoke Test",
        help="Deal name. Re-running with the same name updates in place.",
    )
    parser.add_argument(
        "--amount",
        default="50000",
        help="Deal amount (USD-equivalent). Default: 50000.",
    )
    parser.add_argument(
        "--stage",
        default="appointmentscheduled",
        help=(
            "HubSpot internal stage ID. Default: appointmentscheduled. "
            "Run `python3 -m src.main list-stages` to discover IDs."
        ),
    )
    parser.add_argument(
        "--country",
        default="US",
        help="ACE customer country code (ISO-3166 alpha-2). Default: US.",
    )
    parser.add_argument(
        "--state",
        default="California",
        help=(
            "ACE customer state/region. ACE expects the full English "
            "state name for US customers (e.g. 'California', not "
            "'CA'). Default: California. Other countries: pass the "
            "appropriate region label."
        ),
    )
    parser.add_argument(
        "--postal-code",
        default="94016",
        help="ACE customer postal code. Default: 94016.",
    )
    parser.add_argument(
        "--solution",
        default="",
        help=(
            "Solution Offering ID (e.g. S-1234567). If omitted, a "
            "free-text fallback is set in ace_other_solution_description "
            "instead — either path passes the Share Lambda preconditions."
        ),
    )
    parser.add_argument(
        "--close-date-days",
        type=int,
        default=90,
        help="Days from today for closedate. Default: 90 (≈3 months).",
    )
    parser.add_argument(
        "--company-name",
        default="Workshop Customer",
        help="ACE customer company name. Default: Workshop Customer.",
    )
    parser.add_argument(
        "--website",
        default="https://www.testcomp.com",
        help="ACE customer website URL. Default: https://www.testcomp.com",
    )
    parser.add_argument(
        "--industry",
        default="Aerospace",
        help=(
            "ACE Industry picklist value. Default: Aerospace. Must be "
            "one of the values seeded by setup_ace_picklists.py."
        ),
    )
    parser.add_argument(
        "--use-case",
        default="Archiving",
        help="ACE Customer Use Case picklist value. Default: Archiving.",
    )
    parser.add_argument(
        "--opportunity-type",
        default="Net New Business",
        help=(
            "ACE Opportunity Type picklist value. One of: Net New "
            "Business, Expansion, Flat Renewal. Default: Net New Business."
        ),
    )
    parser.add_argument(
        "--delivery-model",
        default="SaaS or PaaS",
        help=(
            "ACE Delivery Models. `;`-separate multiple values "
            "(e.g. 'SaaS or PaaS;Managed Services'). Default: SaaS or PaaS."
        ),
    )
    parser.add_argument(
        "--involvement-type",
        default="Co-Sell",
        help="ACE Involvement Type. One of: Co-Sell, For Visibility Only.",
    )
    parser.add_argument(
        "--visibility",
        default="Full",
        help="ACE Visibility. One of: Full, Limited. Default: Full.",
    )
    parser.add_argument(
        "--national-security",
        default="No",
        help="ACE National Security. Yes/No. Default: No.",
    )
    parser.add_argument(
        "--marketing-source",
        default="No",
        help=(
            "Is Opportunity from Marketing Activity? Yes/No. "
            "Default: No."
        ),
    )
    parser.add_argument(
        "--primary-needs",
        default="Co-Sell - Architectural Validation",
        help=(
            "ACE Primary Needs from AWS. `;`-separate multiple values. "
            "Default: 'Co-Sell - Architectural Validation'."
        ),
    )
    parser.add_argument(
        "--sales-activities",
        default="Initialized discussions with customer",
        help=(
            "ACE Sales Activities. `;`-separate multiple values. "
            "Default: 'Initialized discussions with customer'."
        ),
    )
    parser.add_argument(
        "--env-suffix",
        default="",
        help=(
            "Environment suffix matching the CRMi stack deploy. Resolves "
            "the right Secrets Manager blob (crm-connector/ace-share-<suffix>) "
            "to read the HubSpot token from. Empty means canonical "
            "secret 'crm-connector/ace-share'."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned API call without sending it.",
    )
    return parser.parse_args()


def hubspot_request(
    token: str,
    method: str,
    path: str,
    body: dict | None = None,
) -> dict:
    """Make a HubSpot CRM v3 API call. Returns parsed JSON.
    Raises ``RuntimeError`` on non-2xx with verbatim response body."""
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8") if e.fp else ""
        raise RuntimeError(
            f"HubSpot API {method} {path} -> {e.code}: {body_text}"
        ) from e


def search_deal_by_name(token: str, name: str) -> str | None:
    """Return the ID of the first deal matching ``dealname``, or ``None``."""
    body = {
        "filterGroups": [
            {
                "filters": [
                    {
                        "propertyName": "dealname",
                        "operator": "EQ",
                        "value": name,
                    }
                ]
            }
        ],
        "properties": ["dealname"],
        "limit": 1,
    }
    resp = hubspot_request(token, "POST", "/crm/v3/objects/deals/search", body)
    results = resp.get("results", [])
    return results[0]["id"] if results else None


def build_properties(args: argparse.Namespace) -> dict[str, str]:
    closedate = (
        dt.date.today() + dt.timedelta(days=args.close_date_days)
    ).isoformat()
    description = (
        "Smoke test for the workshop. This description is at least 20 "
        "characters long so it passes validation as the ACE "
        "CustomerBusinessProblem field."
    )

    # ACE rejects 2-letter US state abbreviations with a verbose
    # INVALID_ENUM_VALUE error. Catch the most common slip
    # (`--state CA` instead of `--state California`) before the
    # value round-trips to AWS. Non-US country codes are passed
    # through unchanged because ACE's enum validation per-country
    # is opaque to us.
    if args.country.upper() == "US":
        US_STATE_ABBR_TO_FULL = {
            "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
            "CA": "California", "CO": "Colorado", "CT": "Connecticut",
            "DE": "Delaware", "DC": "Dist. of Columbia", "FL": "Florida",
            "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
            "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky",
            "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
            "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
            "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
            "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire",
            "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
            "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
            "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
            "PR": "Puerto Rico", "RI": "Rhode Island",
            "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee",
            "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
            "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin",
            "WY": "Wyoming",
        }
        if len(args.state) == 2 and args.state.upper() in US_STATE_ABBR_TO_FULL:
            full = US_STATE_ABBR_TO_FULL[args.state.upper()]
            print(
                f"NOTE: --state '{args.state}' is a US postal abbreviation. "
                f"ACE requires the full English state name; substituting "
                f"'{full}'.",
                file=sys.stderr,
            )
            args.state = full

    props: dict[str, str] = {
        # Core HubSpot fields
        "dealname": args.name,
        "dealstage": args.stage,
        "amount": args.amount,
        "closedate": closedate,
        "description": description,
        # Customer location (Customer.Account.Address.*)
        "ace_country_code": args.country,
        "ace_state_or_region": args.state,
        "ace_postal_code": args.postal_code,
        "ace_company_name": args.company_name,
        "ace_website_url": args.website,
        # ACE classification picklists. All required by ACE on Create
        # (the Share Lambda fills hardcoded defaults if any are blank,
        # but explicit values mean the deal looks the same in HubSpot
        # as it does on the AWS side after Share — fewer surprises).
        "ace_industry": args.industry,
        "ace_customer_use_case": args.use_case,
        "ace_opportunity_type": args.opportunity_type,
        "ace_delivery_model": args.delivery_model,
        "ace_involvement_type": args.involvement_type,
        "ace_visibility": args.visibility,
        "ace_national_security": args.national_security,
        "ace_marketing_source": args.marketing_source,
        "ace_primary_need_from_aws": args.primary_needs,
        "ace_sales_activities": args.sales_activities,
    }

    # Either ace_solutions OR ace_other_solution_description is required.
    # If the user passed --solution, use the picklist field. Otherwise
    # fall back to the free-text alternative so the deal still passes
    # preconditions on first save.
    if args.solution:
        props["ace_solutions"] = args.solution
    else:
        props["ace_other_solution_description"] = (
            "Solution offering not assigned, validating offer."
        )

    return props


def main() -> int:
    args = parse_args()

    # Thread --env-suffix into the helper's resolution by writing it
    # back into the environment before the (lazy) module-level
    # SECRET_ID resolution kicks in. Reload `_hubspot_token` so its
    # SECRET_ID picks up the override.
    if args.env_suffix and not os.environ.get("ENV_SUFFIX"):
        os.environ["ENV_SUFFIX"] = args.env_suffix
        import importlib  # local import; only when needed
        import _hubspot_token as _ht
        importlib.reload(_ht)

    token = os.environ.get("HUBSPOT_PRIVATE_APP_TOKEN", "").strip()
    if not token:
        try:
            token = get_hubspot_token()
        except Exception as e:  # noqa: BLE001
            print(
                f"ERROR: could not fetch HubSpot token from Secrets Manager: {e}",
                file=sys.stderr,
            )
            print(
                "Set HUBSPOT_PRIVATE_APP_TOKEN in the environment or run "
                "./infra/set-secrets.sh first.",
                file=sys.stderr,
            )
            return 1

    properties = build_properties(args)

    if args.dry_run:
        print("DRY RUN — would POST/PATCH the following deal properties:")
        print(json.dumps(properties, indent=2))
        return 0

    existing_id = search_deal_by_name(token, args.name)

    if existing_id:
        print(f"Deal '{args.name}' already exists (id={existing_id}); updating.")
        try:
            resp = hubspot_request(
                token,
                "PATCH",
                f"/crm/v3/objects/deals/{existing_id}",
                {"properties": properties},
            )
        except RuntimeError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
        deal_id = resp.get("id", existing_id)
    else:
        print(f"Creating deal '{args.name}'.")
        try:
            resp = hubspot_request(
                token,
                "POST",
                "/crm/v3/objects/deals",
                {"properties": properties},
            )
        except RuntimeError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
        deal_id = resp["id"]

    portal_id = os.environ.get("HUBSPOT_PORTAL_ID", "")
    deal_url = (
        f"https://app.hubspot.com/contacts/{portal_id}/deal/{deal_id}"
        if portal_id
        else f"https://app.hubspot.com/contacts/<your-portal-id>/deal/{deal_id}"
    )
    print(f"OK. Deal id: {deal_id}")
    print(f"Open in HubSpot: {deal_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
