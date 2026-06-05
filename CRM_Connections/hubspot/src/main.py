"""HubSpot provisioning CLI — creates the deal properties used by the
TypeScript Lambdas (Share / Refresh / Pull) and the agent card.

The runtime sync logic lives entirely in the AWS-side stacks
(`backend/` for Path A, `agent-backend/` for Path B). This CLI is a
one-time provisioning utility for the partner's HubSpot portal:

    python -m src.main setup-hubspot   # core lifecycle + AWS-team mirror props
    python -m src.main list-stages     # discover stage IDs for STAGE_MAPPING

Picklists and the bidirectional editing surface live in
`scripts/setup_ace_picklists.py` and `scripts/setup_ace_bidirectional_fields.py`
— run those after `setup-hubspot` for the full property set.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

# Load environment variables from .env file at project root
load_dotenv(Path(__file__).parent.parent / ".env")

import typer  # noqa: E402

from .logger import print_status  # noqa: E402

app = typer.Typer(help="HubSpot provisioning utilities for the AWS Partner Central connector.")


@app.command(name="list-stages")
def list_stages(
    pipeline_id: str = typer.Option("default", help="HubSpot pipeline ID to list stages for"),
) -> None:
    """List all deal pipelines and stages from HubSpot.

    Use this to find your stage IDs for configuring `STAGE_MAPPING`
    on the Path A Lambda (the secret blob in
    `crm-connector/ace-share`).
    """
    from .hubspot_client import HubSpotClient

    client = HubSpotClient()

    pipelines = client.get_deal_pipelines()
    if not pipelines:
        print_status("No deal pipelines found", "error")
        raise typer.Exit(code=1)

    for pipeline in pipelines:
        is_target = " ← current" if pipeline["id"] == pipeline_id else ""
        print_status(f"Pipeline: {pipeline['label']} (id: {pipeline['id']}){is_target}", "info")

        stages = sorted(pipeline.get("stages", []), key=lambda s: s.get("displayOrder", 0))
        for stage in stages:
            print(f"    {stage['id']:30s}  {stage['label']}")
        print()

    print_status(
        "Copy the stage IDs (left column) to build your STAGE_MAPPING value, "
        "then save it via `./infra/set-secrets.sh STAGE_MAPPING`.",
        "info",
    )
    print(
        "  Valid ACE stages: Qualified, Technical Validation, Business Validation, "
        "Committed, Launched, Closed Lost"
    )


@app.command(name="setup-hubspot")
def setup_hubspot() -> None:
    """Create the core required custom deal properties in HubSpot.

    Run this once during initial setup. Requires a HubSpot Private App token
    with `crm.objects.deals.write` and `crm.schemas.deals.read` scopes.
    Already-existing properties are skipped safely.

    NOTE: this command provisions ONLY the core lifecycle properties
    (`ace_opportunity_id`, `ace_sync_status`, `aws_review_status`,
    `aws_stage`, `ace_last_sync`, `ace_sync_error`, plus the six
    AWS-team mirror fields). The deal's built-in
    `description` field is sent to ACE as `Project.CustomerBusinessProblem`
    — no custom property to provision for that.

    The 11 customisable ACE-payload picklists (industry, opportunity type,
    primary need, delivery model, customer use case, currency code,
    marketing source, AWS funding used, involvement type, visibility,
    national security) live in `scripts/setup_ace_picklists.py`. Run that
    script after this one.

    The bidirectional editing surface — 10 override properties
    (`ace_additional_comments`, `ace_competitor_name`,
    `ace_aws_partition`, `ace_apn_programs`, `ace_closed_lost_reason`,
    `ace_aws_account_id`, `ace_duns`, `ace_street_address`,
    `ace_other_competitor_names`, `ace_other_solution_description`)
    plus the read-only `aws_review_status` / `aws_stage` /
    `aws_review_comments` / `aws_review_status_reason` mirrors —
    lives in `scripts/setup_ace_bidirectional_fields.py`. Run that
    script too.

    `Project.Title` is sourced from the deal's built-in `dealname`,
    `Project.CustomerBusinessProblem` from the built-in `description`,
    and `LifeCycle.NextSteps` from the built-in `hs_next_step`. No
    custom properties for any of those.
    """
    from .hubspot_client import HubSpotClient

    client = HubSpotClient()

    group_name = "aws_partner_fields"

    # Create property group first
    group_result = client.create_deal_property_group(
        {"name": group_name, "label": "AWS Partner Fields", "displayOrder": -1}
    )
    if group_result is None:
        print_status("Property group 'AWS Partner Fields' — already exists, skipped", "info")
    else:
        print_status("Property group 'AWS Partner Fields' — created", "success")
    print()

    properties = [
        # NOTE: `submit_to_aws` was retired. The card now decides
        # whether to render the Share button by checking whether ANY
        # ACE-related deal property is set (description, ace_*, aws_*).
        # Don't reprovision the boolean — leave the property archived
        # in HubSpot, or hard-delete it via the HubSpot UI.
        {
            "name": "ace_opportunity_id",
            "label": "ACE Opportunity ID",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS ACE opportunity ID (auto-populated by sync)",
        },
        # NOTE: `apn_crm_id` was retired (the AWS-assigned identifier
        # isn't surfaced in the deployment's catalog). Don't reprovision.
        {
            "name": "ace_sync_status",
            "label": "ACE Sync Status",
            "type": "enumeration",
            "fieldType": "select",
            "groupName": group_name,
            "description": (
                "Health of the last sync attempt. Pure 3-value enum "
                "(Not Synced / Synced / Sync Error). The AWS-side state "
                "(Submitted / Approved / Rejected / etc.) lives separately "
                "in `aws_review_status`."
            ),
            "options": [
                {"label": "Not Synced", "value": "Not Synced", "displayOrder": 0,
                 "description": "Initial state — deal has never been shared with AWS."},
                {"label": "Synced", "value": "Synced", "displayOrder": 1,
                 "description": "Last Share / Refresh / EventBridge auto-pull succeeded."},
                {"label": "Sync Error", "value": "Sync Error", "displayOrder": 2,
                 "description": "Last sync attempt failed; see ace_sync_error for the failing step."},
            ],
        },
        {
            "name": "aws_review_status",
            "label": "AWS Review Status",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": (
                "Raw `LifeCycle.ReviewStatus` from AWS Partner Central "
                "(e.g. 'Pending Submission', 'Submitted', 'In review', "
                "'Action Required', 'Approved', 'Rejected'). Free-text so "
                "new ACE states surface without a HubSpot property change."
            ),
        },
        {
            "name": "aws_stage",
            "label": "AWS Stage",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": (
                "Raw `LifeCycle.Stage` from AWS Partner Central "
                "(e.g. 'Prospect', 'Qualified', 'Technical Validation', "
                "'Closed Lost'). Free-text mirror so the live ACE stage is "
                "visible alongside the HubSpot dealstage."
            ),
        },
        {
            "name": "ace_last_sync",
            "label": "ACE Last Sync",
            "type": "datetime",
            "fieldType": "date",
            "groupName": group_name,
            "description": "Timestamp of last successful ACE sync",
        },
        {
            "name": "ace_sync_error",
            "label": "ACE Sync Error",
            "type": "string",
            "fieldType": "textarea",
            "groupName": group_name,
            "description": "Error message from last failed ACE sync attempt",
        },
        # NOTE: HubSpot's built-in deal `description` field is now sent
        # to ACE as `Project.CustomerBusinessProblem`. The legacy
        # `ace_project_description` custom property has been retired —
        # don't reprovision it.
        {
            "name": "ace_aws_account_manager",
            "label": "AWS Account Manager",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS Account Manager name (synced from ACE)",
        },
        {
            "name": "ace_aws_account_manager_email",
            "label": "AWS Account Manager Email",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS Account Manager email (synced from ACE)",
        },
        {
            "name": "ace_aws_sales_rep",
            "label": "AWS Sales Rep",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS Sales Rep name (synced from ACE)",
        },
        {
            "name": "ace_aws_sales_rep_email",
            "label": "AWS Sales Rep Email",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS Sales Rep email (synced from ACE)",
        },
        {
            "name": "ace_aws_partner_sales_manager",
            "label": "AWS Partner Sales Manager",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS Partner Sales Manager (synced from ACE)",
        },
        {
            "name": "ace_aws_partner_development_manager",
            "label": "AWS Partner Development Manager",
            "type": "string",
            "fieldType": "text",
            "groupName": group_name,
            "description": "AWS Partner Development Manager (synced from ACE)",
        },
    ]

    created = 0
    skipped = 0

    for prop in properties:
        result = client.create_deal_property(prop)
        if result is None:
            print_status(f"{prop['label']} — already exists, skipped", "info")
            skipped += 1
        else:
            print_status(f"{prop['label']} — created", "success")
            created += 1

    print()
    print_status(f"Done! Created {created}, skipped {skipped} (already existed)", "success")


if __name__ == "__main__":
    app()
