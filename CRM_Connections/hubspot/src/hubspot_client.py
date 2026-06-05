"""Standalone HubSpot API client for ACE sync.

Wraps the HubSpot CRM v3/v4 API with the specific methods needed for deal sync.
Uses only the `requests` library — no HubSpot SDK dependency.

Rate limiting: HubSpot allows 100 requests per 10 seconds for private apps.
This client tracks request timestamps and applies exponential backoff on 429 responses.
"""

from __future__ import annotations

import os
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import requests
from requests.exceptions import HTTPError

from .logger import get_logger

logger = get_logger(__name__)


@dataclass
class HubSpotConfig:
    """HubSpot API configuration."""

    api_key: str = ""
    base_url: str = "https://api.hubapi.com"

    def __post_init__(self) -> None:
        if not self.api_key:
            self.api_key = os.environ.get("HUBSPOT_API_KEY", "")
        if not self.api_key:
            raise ValueError("HUBSPOT_API_KEY environment variable is required")


class HubSpotClient:
    """Lightweight HubSpot CRM API client with rate limiting.

    Maintains a sliding window of the last 100 request timestamps (10-second window).
    Applies exponential backoff on 429 (rate limit) responses.
    """

    # Rate limit: 100 requests per 10 seconds for private apps
    MAX_REQUESTS_PER_WINDOW = 100
    WINDOW_SECONDS = 10.0

    def __init__(self, config: HubSpotConfig | None = None) -> None:
        self.config = config or HubSpotConfig()
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            }
        )
        # Sliding window of request timestamps (seconds since epoch)
        self._request_times: deque[float] = deque(maxlen=self.MAX_REQUESTS_PER_WINDOW)
        self._backoff_until = 0.0  # Unix timestamp: don't make requests until this time

    def _check_and_enforce_rate_limit(self) -> None:
        """Check rate limit and sleep if necessary to stay under 100 requests per 10 seconds."""
        now = time.time()

        # Remove timestamps older than the window
        while self._request_times and (now - self._request_times[0]) > self.WINDOW_SECONDS:
            self._request_times.popleft()

        # If at capacity, sleep until the oldest request falls out of the window
        if len(self._request_times) >= self.MAX_REQUESTS_PER_WINDOW:
            sleep_until = self._request_times[0] + self.WINDOW_SECONDS
            sleep_duration = sleep_until - now
            if sleep_duration > 0:
                logger.debug(f"Rate limit: sleeping {sleep_duration:.2f}s to stay under 100 req/10s")
                time.sleep(sleep_duration)
                now = time.time()

        # Also respect exponential backoff if a 429 was recently received
        if now < self._backoff_until:
            sleep_duration = self._backoff_until - now
            logger.debug(f"Backoff: sleeping {sleep_duration:.2f}s after 429 response")
            time.sleep(sleep_duration)
            self._backoff_until = 0.0

        # Record this request
        self._request_times.append(time.time())

    def _make_request(self, method: str, endpoint: str, **kwargs: Any) -> dict[str, Any]:
        """Make HTTP request with rate limiting and backoff on 429.

        Args:
            method: 'get', 'post', 'patch'
            endpoint: API endpoint path
            **kwargs: passed to session method (params, json, etc.)

        Returns:
            Parsed JSON response.

        Raises:
            HTTPError: for non-429 errors
        """
        self._check_and_enforce_rate_limit()

        url = f"{self.config.base_url}{endpoint}"
        backoff_seconds = 1.0

        while True:
            try:
                if method == "get":
                    response = self._session.get(url, **kwargs)
                elif method == "post":
                    response = self._session.post(url, **kwargs)
                elif method == "patch":
                    response = self._session.patch(url, **kwargs)
                else:
                    raise ValueError(f"Unsupported method: {method}")

                response.raise_for_status()
                return response.json()

            except HTTPError:
                if response.status_code == 429:
                    # Rate limited — apply exponential backoff
                    logger.warning(
                        f"Hit rate limit (429) on {method.upper()} {endpoint}, backing off {backoff_seconds}s"
                    )
                    self._backoff_until = time.time() + backoff_seconds
                    backoff_seconds = min(backoff_seconds * 2, 30.0)  # Cap at 30s
                    time.sleep(self._backoff_until - time.time())
                else:
                    # Other HTTP error — log the response body (HubSpot puts
                    # the useful detail there) then re-raise so callers still
                    # see the HTTPError.
                    try:
                        body = response.json()
                        logger.error(
                            f"HubSpot {method.upper()} {endpoint} -> {response.status_code}: {body}"
                        )
                    except Exception:
                        logger.error(
                            f"HubSpot {method.upper()} {endpoint} -> {response.status_code}: "
                            f"{response.text[:500]}"
                        )
                    raise

    def get(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """GET request to HubSpot API with rate limiting."""
        return self._make_request("get", endpoint, params=params)

    def post(self, endpoint: str, json_data: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST request to HubSpot API with rate limiting."""
        return self._make_request("post", endpoint, json=json_data)

    def patch(self, endpoint: str, json_data: dict[str, Any] | None = None) -> dict[str, Any]:
        """PATCH request to HubSpot API with rate limiting."""
        return self._make_request("patch", endpoint, json=json_data)

    # =========================================================================
    # Pipeline & Stage Discovery
    # =========================================================================

    def get_deal_pipelines(self) -> list[dict[str, Any]]:
        """Fetch all deal pipelines with their stages."""
        data = self.get("/crm/v3/pipelines/deals")
        return data.get("results", [])

    def get_pipeline_stages(self, pipeline_id: str) -> list[dict[str, Any]]:
        """Fetch stages for a specific deal pipeline."""
        data = self.get(f"/crm/v3/pipelines/deals/{pipeline_id}/stages")
        return data.get("results", [])

    # =========================================================================
    # Deal Operations
    # =========================================================================

    def update_deal(self, deal_id: int, properties: dict[str, Any]) -> dict[str, Any]:
        """Update a deal's properties."""
        return self.patch(f"/crm/v3/objects/deals/{deal_id}", json_data={"properties": properties})

    def get_deal_company_associations(self, deal_ids: list[int]) -> dict[int, list[int]]:
        """Get company associations for deals using batch API.

        Returns {deal_id: [company_id, ...]}.
        """
        if not deal_ids:
            return {}

        associations: dict[int, list[int]] = {}
        endpoint = "/crm/v3/associations/deals/companies/batch/read"

        # Batch in groups of 100 (HubSpot limit)
        for i in range(0, len(deal_ids), 100):
            batch = deal_ids[i : i + 100]
            payload = {"inputs": [{"id": str(did)} for did in batch]}

            try:
                response = self.post(endpoint, json_data=payload)
                for result in response.get("results", []):
                    deal_id = int(result["from"]["id"])
                    company_ids = [int(to["id"]) for to in result.get("to", [])]
                    associations[deal_id] = company_ids
            except Exception as e:
                logger.warning(f"Failed to get company associations for batch: {e}")
                for did in batch:
                    associations[did] = []

        return associations

    def get_company(self, company_id: int, properties: list[str] | None = None) -> CompanyResult:
        """Fetch a company by ID with specified properties."""
        params = {}
        if properties:
            params["properties"] = ",".join(properties)
        data = self.get(f"/crm/v3/objects/companies/{company_id}", params=params)
        props = data.get("properties", {})
        return CompanyResult(
            id=int(data["id"]),
            name=props.get("name", ""),
            domain=props.get("domain", ""),
            custom_properties=props,
        )

    # =========================================================================
    # Property Management
    # =========================================================================

    def create_deal_property_group(self, group_def: dict[str, Any]) -> dict[str, Any] | None:
        """Create a custom deal property group. Returns None if it already exists."""
        try:
            return self.post("/crm/v3/properties/deals/groups", json_data=group_def)
        except HTTPError as e:
            if e.response.status_code == 409:
                return None  # Already exists
            raise

    def create_deal_property(self, property_def: dict[str, Any]) -> dict[str, Any] | None:
        """Create a custom deal property. Returns None if it already exists."""
        try:
            return self.post("/crm/v3/properties/deals", json_data=property_def)
        except HTTPError as e:
            if e.response.status_code == 409:
                return None  # Already exists
            raise


@dataclass
class CompanyResult:
    """Simplified company data container."""

    id: int
    name: str
    domain: str
    custom_properties: dict[str, Any] | None = None
