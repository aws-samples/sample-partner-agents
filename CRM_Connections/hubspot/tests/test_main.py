"""Tests for `src/main.py` CLI commands."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from src.main import app


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def mock_hubspot_client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Patch `HubSpotClient` so setup-hubspot doesn't hit the real HubSpot API."""
    mock_instance = MagicMock()
    mock_instance.create_deal_property_group.return_value = {
        "name": "aws_partner_fields"
    }
    mock_instance.create_deal_property.return_value = {"name": "ok"}

    with patch(
        "src.hubspot_client.HubSpotClient", return_value=mock_instance
    ) as patched:
        yield mock_instance
        assert patched is not None


def test_setup_hubspot_does_not_provision_retired_apn_crm_id(
    runner: CliRunner, mock_hubspot_client: MagicMock
) -> None:
    """`setup-hubspot` MUST NOT (re)create the retired `apn_crm_id`
    property. The field was removed when AWS confirmed it isn't
    surfaced for the deployment's catalog.
    """
    result = runner.invoke(app, ["setup-hubspot"])
    assert result.exit_code == 0, result.stdout

    names = [
        (
            call.args[0]
            if call.args
            else call.kwargs.get("property_def") or {}
        ).get("name")
        for call in mock_hubspot_client.create_deal_property.call_args_list
    ]
    assert "apn_crm_id" not in names, (
        "apn_crm_id has been retired and must not be re-provisioned by "
        f"setup-hubspot; got attempts: {names!r}"
    )


def test_setup_hubspot_provisions_core_lifecycle_props(
    runner: CliRunner, mock_hubspot_client: MagicMock
) -> None:
    """`setup-hubspot` provisions the lifecycle properties the connector
    actively reads / writes."""
    result = runner.invoke(app, ["setup-hubspot"])
    assert result.exit_code == 0, result.stdout

    names = {
        (
            call.args[0]
            if call.args
            else call.kwargs.get("property_def") or {}
        ).get("name")
        for call in mock_hubspot_client.create_deal_property.call_args_list
    }
    for required in (
        "ace_opportunity_id",
        "ace_sync_status",
        "ace_last_sync",
        "ace_sync_error",
        "aws_review_status",
        "aws_stage",
    ):
        assert required in names, (
            f"setup-hubspot must provision `{required}`; got: {sorted(names)!r}"
        )
