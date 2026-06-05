#!/usr/bin/env python3
"""
One-shot ops script: seed (or refresh) the `ace_aws_products` HubSpot
deal property with the AWS Product catalog from
aws-samples/partner-crm-integration-samples/resources/SampleAWSProducts.csv.

The property is created with `fieldType = "checkbox"` (HubSpot's
internal name for "Multiple checkboxes" — surfaces a multi-select
dropdown WITH a built-in search box on the deal sidebar/card editor).
Options are sourced from the upstream CSV, deduplicated, and ordered
by display order so the dropdown is alphabetized.

Usage:
    HUBSPOT_PRIVATE_APP_TOKEN=pat-... \\
    CSV_PATH=/path/to/SampleAWSProducts.csv \\
    python3 scripts/seed-aws-products-picklist.py [--dry-run]

Env:
  HUBSPOT_PRIVATE_APP_TOKEN  Required. Must have `crm.schemas.deals.write`
                             scope. The token also needs `crm.schemas.deals.read`
                             to introspect whether the property already
                             exists.
  CSV_PATH                   Optional. Defaults to /tmp/SampleAWSProducts.csv.
                             The script never modifies this file.

Flags:
  --dry-run                  Print the planned API call without sending it.
                             Useful for verifying the option count and
                             payload shape before touching the portal.

Exit codes:
  0 — success.
  1 — token / scope failure.
  2 — CSV parse failure / empty options.
  3 — HubSpot API error response.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request

PROPERTY_NAME = "ace_aws_products"
PROPERTY_LABEL = "ACE AWS Products"
PROPERTY_GROUP = "aws_partner_fields"
HUBSPOT_API_BASE = "https://api.hubapi.com"


def parse_csv(path: str) -> list[dict[str, str]]:
    """Parse the AWS catalog CSV. Each row has columns:
    'AWS Product Code', 'Product Name', 'Product Description', 'Product Family'.

    Returns a list of unique-by-code rows in their CSV order. The
    upstream CSV has a few literal duplicates (e.g.
    `AmazonCodeGuruProfiler` appears twice with different descriptions);
    we keep the first occurrence and silently drop subsequent ones.
    """
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    # `utf-8-sig` strips the BOM HubSpot/Excel sometimes prepend so
    # the column key matches "AWS Product Code" not "\ufeffAWS Product Code".
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            code = (row.get("AWS Product Code") or "").strip()
            name = (row.get("Product Name") or "").strip()
            family = (row.get("Product Family") or "").strip()
            if not code or not name:
                continue
            if code in seen:
                continue
            seen.add(code)
            out.append(
                {
                    "code": code,
                    "name": name,
                    "family": family,
                }
            )
    return out


def to_hubspot_options(rows: list[dict[str, str]]) -> list[dict[str, object]]:
    """Convert catalog rows into HubSpot picklist option payloads.

    Each option is: {label, value, displayOrder, hidden}. We:
      - Use the AWS Product Code as the `value` (this is what the
        backend lambda forwards to AssociateOpportunity).
      - Use "<Product Name> (<code>)" as the `label` so the rep can
        match by either friendly name or code in the search box.
      - Sort the options alphabetically by label so the rendered
        dropdown is predictable. HubSpot typically respects
        `displayOrder`; alphabetizing by label is a safe fallback.
    """
    enriched: list[dict[str, object]] = []
    for row in rows:
        label = f"{row['name']} ({row['code']})"
        enriched.append(
            {
                "label": label,
                "value": row["code"],
                "description": row["family"] or None,
                "hidden": False,
            }
        )
    enriched.sort(key=lambda r: str(r["label"]).lower())
    for i, opt in enumerate(enriched):
        opt["displayOrder"] = i
    return enriched


def hubspot_request(
    method: str,
    path: str,
    token: str,
    body: dict | None = None,
) -> dict:
    """Issue a JSON request against HubSpot's API. Raises with a
    friendly error envelope on non-2xx so the caller can surface it
    cleanly.
    """
    url = f"{HUBSPOT_API_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HubSpot {method} {path} → {e.code}: {body}") from e


def property_exists(token: str) -> bool:
    """Return True iff `ace_aws_products` already exists on the deal
    object.
    """
    try:
        hubspot_request(
            "GET", f"/crm/v3/properties/deals/{PROPERTY_NAME}", token
        )
        return True
    except RuntimeError as e:
        if "→ 404" in str(e):
            return False
        raise


def build_create_payload(options: list[dict[str, object]]) -> dict:
    """Payload for POST /crm/v3/properties/deals — create the property
    fresh.
    """
    return {
        "name": PROPERTY_NAME,
        "label": PROPERTY_LABEL,
        "type": "enumeration",
        "fieldType": "checkbox",  # HubSpot's "Multiple checkboxes"
        "groupName": PROPERTY_GROUP,
        "description": (
            "AWS Products associated with this opportunity. Sent to AWS "
            "Partner Central as RelatedEntityIdentifiers.AwsProducts via "
            "AssociateOpportunity. Sourced from "
            "aws-samples/partner-crm-integration-samples/resources/"
            "SampleAWSProducts.csv."
        ),
        "options": options,
        "formField": True,
    }


def build_update_payload(options: list[dict[str, object]]) -> dict:
    """Payload for PATCH /crm/v3/properties/deals/<name> — update the
    options on an existing property. We only touch `options` so we
    don't accidentally overwrite a hand-edited label or group.
    """
    return {"options": options}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("HUBSPOT_PRIVATE_APP_TOKEN")
    if not token:
        print("ERROR: HUBSPOT_PRIVATE_APP_TOKEN not set", file=sys.stderr)
        return 1

    csv_path = os.environ.get("CSV_PATH", "/tmp/SampleAWSProducts.csv")
    if not os.path.isfile(csv_path):
        print(f"ERROR: CSV not found at {csv_path}", file=sys.stderr)
        return 2

    rows = parse_csv(csv_path)
    if not rows:
        print("ERROR: CSV had zero usable rows", file=sys.stderr)
        return 2

    options = to_hubspot_options(rows)
    print(f"Parsed {len(rows)} unique product codes from {csv_path}")
    print(f"First option:  {json.dumps(options[0])}")
    print(f"Last  option:  {json.dumps(options[-1])}")

    if args.dry_run:
        print("\n--dry-run set; not calling HubSpot.")
        return 0

    print("\nChecking whether the property already exists...")
    exists = property_exists(token)
    if exists:
        print(f"Property '{PROPERTY_NAME}' exists — refreshing options.")
        body = build_update_payload(options)
        path = f"/crm/v3/properties/deals/{PROPERTY_NAME}"
        method = "PATCH"
    else:
        print(f"Property '{PROPERTY_NAME}' does not exist — creating.")
        body = build_create_payload(options)
        path = "/crm/v3/properties/deals"
        method = "POST"

    print(f"\n{method} {path}")
    try:
        resp = hubspot_request(method, path, token, body)
    except RuntimeError as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        return 3
    print(f"\nSuccess. {len(options)} options seeded.")
    print(f"HubSpot response keys: {sorted(resp.keys())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
