"""Pipedrive CRM REST client (fetches deals)."""

import os
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


class PipedriveClient:
    """Client for Pipedrive CRM API to fetch deals."""

    def __init__(self, bearer_token: str = None, instance_url: str = None):
        """
        Initialize Pipedrive client.

        Args:
            bearer_token: Pipedrive API token (or set PIPEDRIVE_API_TOKEN env).
            instance_url: Pipedrive company URL (e.g. https://yourco.pipedrive.com).
                          Also accepts PIPEDRIVE_INSTANCE_URL env var.
        """
        self.bearer_token = bearer_token or os.environ.get('PIPEDRIVE_API_TOKEN')
        self.instance_url = instance_url or os.environ.get('PIPEDRIVE_INSTANCE_URL', '')

        if self.instance_url.endswith('/'):
            self.instance_url = self.instance_url[:-1]

        if not self.bearer_token:
            logger.warning("Pipedrive API token not configured")

        # Cache of stage_id -> stage name. Populated lazily on first access.
        # Pipedrive's /deals and /deals/{id} endpoints return stage_id but not
        # stage_name, so we resolve names from /stages once per client instance.
        self._stage_name_by_id: Optional[Dict[int, str]] = None

    def _resolve_stage_name(self, stage_id) -> str:
        """Return the stage name for a given stage_id, fetching /stages on first call."""
        if not stage_id:
            return ""

        # Lazy-load the stage cache
        if self._stage_name_by_id is None:
            stages_resp = self._make_request("GET", "/stages")
            cache: Dict[int, str] = {}
            if isinstance(stages_resp, dict) and stages_resp.get("data"):
                for stage in stages_resp["data"]:
                    sid = stage.get("id")
                    sname = stage.get("name", "")
                    if sid is not None:
                        cache[int(sid)] = sname
            self._stage_name_by_id = cache

        try:
            return self._stage_name_by_id.get(int(stage_id), "")
        except (TypeError, ValueError):
            return ""

    def _make_request(self, method: str, endpoint: str, data: Dict = None, params: Dict = None) -> Dict:
        """Make an authenticated request to Pipedrive API v1.

        Pipedrive's API accepts auth via the `api_token` query parameter on every
        request. The docs also list an OAuth-only `Authorization: Bearer` scheme,
        but it does NOT accept personal API tokens via the Bearer header — such
        calls come back as 401 unauthorized. So always append `api_token` here.
        """
        import requests

        if not self.bearer_token:
            return {"error": "Pipedrive API token not configured"}
        if not self.instance_url:
            return {"error": "Pipedrive instance URL not configured"}

        url = f"{self.instance_url}/api/v1{endpoint}"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        # Merge api_token into params so requests handles URL-encoding.
        merged_params = dict(params) if params else {}
        merged_params["api_token"] = self.bearer_token

        try:
            if method == "GET":
                response = requests.get(url, headers=headers, params=merged_params, timeout=30)
            elif method == "POST":
                response = requests.post(url, headers=headers, params=merged_params, json=data, timeout=30)
            else:
                return {"error": f"Unsupported method: {method}"}
            response.raise_for_status()
            return response.json() if response.text else {}
        except requests.exceptions.HTTPError as e:
            logger.error(f"Pipedrive API error: {e}")
            error_body = ""
            try:
                error_body = e.response.json() if e.response else ""
            except Exception:
                error_body = e.response.text if e.response else ""
            return {
                "error": str(e),
                "status_code": e.response.status_code if e.response else None,
                "details": error_body,
            }
        except Exception as e:
            logger.error(f"Pipedrive request error: {e}")
            return {"error": str(e)}

    def get_person(self, person_id) -> Dict:
        """Fetch a person (contact) by ID."""
        result = self._make_request("GET", f"/persons/{person_id}")
        return result.get("data") if isinstance(result, dict) and "data" in result else {}

    def get_organization(self, org_id) -> Dict:
        """Fetch an organization (account) by ID."""
        result = self._make_request("GET", f"/organizations/{org_id}")
        return result.get("data") if isinstance(result, dict) and "data" in result else {}

    def get_deal(self, deal_id: str):
        """Fetch a deal by ID with resolved person + organization."""
        from crm.pipedrive_mapper import PipedriveDeal

        result = self._make_request("GET", f"/deals/{deal_id}")
        if "error" in result or not result.get("data"):
            logger.error(f"Failed to fetch Pipedrive deal {deal_id}: {result.get('error')}")
            return None

        deal = result["data"]

        # Resolve organization
        org_name = ""
        org_props: Dict = {}
        org_id = None
        if isinstance(deal.get("org_id"), dict):
            org_name = deal["org_id"].get("name", "")
            org_id = deal["org_id"].get("value")
        elif deal.get("org_id"):
            org_id = deal["org_id"]
        if org_id:
            org = self.get_organization(org_id) or {}
            if org:
                org_name = org_name or org.get("name", "")
                # Pipedrive organization fields. Note: Pipedrive orgs don't
                # have a standard website field, so we omit WebsiteUrl here and
                # let the mapper fall back to its DEFAULT_WEBSITE. If your org
                # uses a custom field for website, plumb it through via a custom
                # field key here (and keep in mind Pipedrive custom-field keys
                # are 40-char hex hashes, not human names).
                org_props = {
                    "org_address": org.get("address", ""),
                    "org_city": org.get("address_locality", ""),
                    "org_state": org.get("address_admin_area_level_1", ""),
                    "org_postal_code": org.get("address_postal_code", ""),
                    "org_country": org.get("address_country", ""),
                    "org_industry": org.get("industry", ""),  # often a custom field
                }

        # Resolve person (primary contact)
        contact_first_name = ""
        contact_last_name = ""
        contact_name = ""
        contact_email = ""
        contact_phone = ""
        contact_title = ""
        person_id = None
        if isinstance(deal.get("person_id"), dict):
            contact_name = deal["person_id"].get("name", "")
            person_id = deal["person_id"].get("value")
        elif deal.get("person_id"):
            person_id = deal["person_id"]
        if person_id:
            person = self.get_person(person_id) or {}
            if person:
                contact_first_name = person.get("first_name", "") or ""
                contact_last_name = person.get("last_name", "") or ""
                contact_name = contact_name or (
                    f"{contact_first_name} {contact_last_name}".strip() or person.get("name", "")
                )
                contact_title = person.get("job_title", "") or ""
                # Pipedrive returns email/phone as arrays of {label, value, primary}
                for entry in person.get("email", []) or []:
                    if entry.get("primary") and entry.get("value"):
                        contact_email = entry["value"]
                        break
                if not contact_email and (person.get("email") or []):
                    first_entry = (person["email"] or [{}])[0]
                    contact_email = first_entry.get("value", "") if isinstance(first_entry, dict) else ""
                for entry in person.get("phone", []) or []:
                    if entry.get("primary") and entry.get("value"):
                        contact_phone = entry["value"]
                        break
                if not contact_phone and (person.get("phone") or []):
                    first_entry = (person["phone"] or [{}])[0]
                    contact_phone = first_entry.get("value", "") if isinstance(first_entry, dict) else ""

        # Stage — Pipedrive's /deals and /deals/{id} endpoints return stage_id
        # but not stage_name. Resolve the name via the /stages cache when missing.
        stage_name = deal.get("stage_name", "") or deal.get("stage", "") or ""
        if not stage_name:
            stage_name = self._resolve_stage_name(deal.get("stage_id"))

        return PipedriveDeal(
            deal_id=str(deal.get("id", deal_id)),
            title=deal.get("title", "Untitled Deal"),
            value=float(deal.get("value", 0) or 0),
            stage=stage_name,
            expected_close_date=deal.get("expected_close_date", "") or "",
            org_name=org_name,
            contact_name=contact_name,
            contact_email=contact_email,
            description=deal.get("notes", "") or "",
            properties={
                **org_props,
                "currency": deal.get("currency", ""),
                "contact_first_name": contact_first_name,
                "contact_last_name": contact_last_name,
                "contact_phone": contact_phone,
                "contact_title": contact_title,
                "pipeline_id": deal.get("pipeline_id"),
                "stage_id": deal.get("stage_id"),
            },
        )

    def list_deals(self, limit: int = 10) -> List:
        """List recent open deals."""
        from crm.pipedrive_mapper import PipedriveDeal

        result = self._make_request(
            "GET",
            "/deals",
            params={"status": "open", "limit": limit, "start": 0, "sort": "update_time DESC"},
        )
        if "error" in result:
            logger.error(f"Failed to list Pipedrive deals: {result['error']}")
            return []

        deals = []
        for item in result.get("data") or []:
            org_name = ""
            if isinstance(item.get("org_id"), dict):
                org_name = item["org_id"].get("name", "")

            deals.append(
                PipedriveDeal(
                    deal_id=str(item.get("id", "")),
                    title=item.get("title", "Untitled"),
                    value=float(item.get("value", 0) or 0),
                    stage=(
                        item.get("stage_name", "")
                        or item.get("stage", "")
                        or self._resolve_stage_name(item.get("stage_id"))
                    ),
                    expected_close_date=item.get("expected_close_date", "") or "",
                    org_name=org_name,
                    contact_name=(item.get("person_name") or "") if isinstance(item.get("person_name"), str) else "",
                    contact_email="",
                    description="",
                    properties={"currency": item.get("currency", "")},
                )
            )
        return deals
