#!/usr/bin/env python3
"""Provision the `ace_solutions` deal property.

Holds the `;`-separated list of `RelatedEntityIdentifiers.Solutions`
associated with each ACE Opportunity (your AWS Partner Central
Solution Offering ID, e.g. `S-XXXXXXX`). The Share button reads this
field on every click: each `;`-separated value becomes an
`AssociateOpportunity` call on create, and on update the diff between
this field and AWS's current associations drives an attach-then-detach
reconciliation. Refresh writes the live AWS value back so external
Partner-Central edits surface in HubSpot.

Token source: AWS Secrets Manager (default secret id
``crm-connector/ace-share``, key ``HUBSPOT_PRIVATE_APP_TOKEN``).
Override with env vars ``ACE_SHARE_SECRET_ID``, ``AWS_PROFILE``, and
``AWS_REGION`` — see ``_hubspot_token.py``.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _hubspot_token import get_hubspot_token  # noqa: E402

PROP = {
    "name": "ace_solutions",
    "label": "ACE Solution Offerings",
    "type": "string",
    "fieldType": "text",
    "groupName": "aws_partner_fields",
    "description": (
        "AWS Partner Central Solution Offering ID(s) associated with "
        "the ACE Opportunity (e.g. 'S-XXXXXXX'). `;`-separated when "
        "multiple solutions are linked. Sales reps populate this on "
        "the deal before clicking Share. Refresh overwrites it with "
        "AWS's live value. If the deal doesn't fit a registered "
        "Solution Offering, leave this blank and use the "
        "ace_other_solution_description field instead — the Share "
        "button skips AssociateOpportunity in that case."
    ),
}


def main() -> int:
    token = get_hubspot_token()
    base = "https://api.hubapi.com/crm/v3/properties/deals"
    req = urllib.request.Request(
        base,
        data=json.dumps(PROP).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
        print(f"{PROP['name']:20s} created")
    except urllib.error.HTTPError as e:
        if e.status != 409:
            print(f"create failed: {e.status} {e.read().decode()[:200]}")
            return 1
        patch = urllib.request.Request(
            f"{base}/{PROP['name']}",
            data=json.dumps(
                {"label": PROP["label"], "description": PROP["description"]}
            ).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="PATCH",
        )
        try:
            urllib.request.urlopen(patch)
            print(f"{PROP['name']:20s} updated")
        except urllib.error.HTTPError as e2:
            print(
                f"patch failed: {e2.status} {e2.read().decode()[:200]}"
            )
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
