"""
CRM Integration Registry.

This module defines the plug-in interface and central registry for CRM
integrations used by the demo UI. To add a new CRM:

1. Create a <crm>_mapper.py with your field mapping logic
2. Create a <crm>_adapter.py that subclasses CrmAdapter and defines `spec`
3. Import it at the bottom of this file (inside `_register_builtin_adapters`)

To remove a CRM, comment out its import in `_register_builtin_adapters`.
Nothing else in the codebase needs to change — demo_ui.py, the frontend JS,
the CLI, and the orchestrator all discover CRMs through this registry.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Type

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CrmSpec:
    """Static metadata describing a CRM integration.

    The UI reads this via GET /api/crm/specs to render the dropdown, token
    input, and (when applicable) instance URL input. Everything the UI needs
    to know about a CRM's surface lives here; the adapter class owns the
    behavior.
    """

    # Stable identifier used in URLs and API payloads (lowercase, no spaces).
    id: str

    # Human-friendly name shown in the dropdown.
    display_name: str

    # What does this CRM call a sales record? ("Deal" / "Opportunity")
    # Used in button labels and result strings.
    record_label: str

    # Short plural label for the UI button ("Load HubSpot Deals").
    load_button_label: str

    # Label and placeholder for the token input field.
    token_label: str = "Bearer Token"
    token_placeholder: str = "Enter your bearer token"

    # If the CRM requires an instance URL (Salesforce, Pipedrive),
    # set these. Leave None for CRMs with a fixed global endpoint (HubSpot).
    instance_url_label: Optional[str] = None
    instance_url_placeholder: Optional[str] = None

    # Optional link to the per-CRM integration guide (for the "learn more"
    # hint in the UI).
    docs_url: Optional[str] = None

    def to_dict(self) -> Dict:
        """Serialize for the /api/crm/specs endpoint."""
        return asdict(self)


class CrmAdapter(ABC):
    """Abstract interface every CRM adapter must implement.

    Each adapter is a thin wrapper around a CRM client (e.g. HubSpotClient)
    and a mapper (e.g. HubSpotToPartnerCentralMapper). It normalizes the
    outputs into CRM-agnostic dicts so the demo UI never has to care which
    CRM it's talking to.
    """

    # Subclasses must set this as a class-level attribute.
    spec: CrmSpec

    def __init__(self, token: str, instance_url: Optional[str] = None):
        self.token = token
        self.instance_url = (instance_url or "").rstrip("/")

        if not self.token:
            raise ValueError(f"{self.spec.display_name} token is required")
        if self.spec.instance_url_label and not self.instance_url:
            raise ValueError(
                f"{self.spec.display_name} instance URL is required"
            )

    # --- Required methods ----------------------------------------------------

    @abstractmethod
    def list_records(self, limit: int = 10) -> List[Dict]:
        """Return a normalized list of recent records.

        Each record must have these keys (strings/numbers only, JSON-safe):
            - id (str)
            - name (str)
            - amount (float)
            - stage (str)
            - close_date (str, ISO date or "")
        """

    @abstractmethod
    def get_record_details(self, record_id: str) -> Dict:
        """Return a normalized detail dict for the "See details" modal.

        Required keys:
            - crm_type (str)
            - id (str)
            - name (str)
            - amount (float)
            - stage (str)
            - close_date (str)
            - description (str)

        Optional keys (include when the CRM has them):
            - contact: {name, email, first_name, last_name, phone, title}
            - account: {name, industry}
            - address: {street, city, state, postal_code, country}
            - raw_properties: {...}  # CRM-specific extras for debugging
        """

    @abstractmethod
    def create_ace_opportunity(
        self,
        agent,  # OrchestratorAgent (avoid circular import in type hint)
        record_id: str,
        project_title: Optional[str] = None,
    ) -> Dict:
        """Create an ACE opportunity in Partner Central from a CRM record.

        Returns a normalized dict with these keys:
            - success (bool)
            - ace_opportunity_id (str | None)
            - record_name (str)
            - record_amount (float)
            - error (str | None)
        """


# -----------------------------------------------------------------------------
# Registry
# -----------------------------------------------------------------------------

_REGISTRY: Dict[str, Type[CrmAdapter]] = {}


def register(adapter_cls: Type[CrmAdapter]) -> Type[CrmAdapter]:
    """Class decorator to register a CRM adapter.

    Usage:
        @register
        class HubSpotAdapter(CrmAdapter):
            spec = CrmSpec(id="hubspot", ...)
            ...
    """
    if not hasattr(adapter_cls, "spec") or not isinstance(adapter_cls.spec, CrmSpec):
        raise TypeError(
            f"{adapter_cls.__name__} must define a `spec: CrmSpec` class attribute"
        )
    crm_id = adapter_cls.spec.id
    if crm_id in _REGISTRY:
        logger.warning(
            f"CRM adapter '{crm_id}' is being re-registered; "
            f"{_REGISTRY[crm_id].__name__} will be replaced by {adapter_cls.__name__}"
        )
    _REGISTRY[crm_id] = adapter_cls
    logger.debug(f"Registered CRM adapter: {crm_id} -> {adapter_cls.__name__}")
    return adapter_cls


def get_adapter_class(crm_id: str) -> Optional[Type[CrmAdapter]]:
    """Return the adapter class for a given CRM id, or None if not registered."""
    return _REGISTRY.get(crm_id)


def all_specs() -> List[Dict]:
    """Return all registered CRM specs (JSON-serializable)."""
    return [cls.spec.to_dict() for cls in _REGISTRY.values()]


def all_ids() -> List[str]:
    """Return all registered CRM ids in registration order."""
    return list(_REGISTRY.keys())


# -----------------------------------------------------------------------------
# Built-in adapter bootstrap
# -----------------------------------------------------------------------------

def _register_builtin_adapters() -> None:
    """Import and register the built-in CRM adapters.

    To DISABLE a CRM, comment out the matching import below.
    To ADD a new CRM, add an import for your new adapter module.
    Imports have the side effect of running the @register decorator.
    """
    # Order here determines the order CRMs appear in the UI dropdown.
    from crm import hubspot_adapter  # noqa: F401
    from crm import salesforce_adapter  # noqa: F401
    from crm import pipedrive_adapter  # noqa: F401


_register_builtin_adapters()
