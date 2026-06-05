"""Shared helper to fetch the HubSpot Private App token from AWS Secrets
Manager. Used by every `setup_ace_*.py` provisioner so the secret name,
AWS profile, and region are configurable in ONE place via env vars
rather than hardcoded across multiple scripts.

Env vars (optional):
  ACE_SHARE_SECRET_ID   AWS Secrets Manager secret holding the deployment's
                        HubSpot + AWS ACE secrets blob.
                        Default: "crm-connector/ace-share" (or
                        "crm-connector/ace-share-${ENV_SUFFIX}" when
                        ENV_SUFFIX is set and ACE_SHARE_SECRET_ID
                        wasn't explicitly overridden).
  ENV_SUFFIX            Environment suffix used at deploy time. Mirrors
                        the deploy-script convention. Auto-derives the
                        default secret ID when set.
  AWS_PROFILE           AWS CLI profile to use. Default: the AWS CLI default.
  AWS_REGION            AWS region. Default: "us-east-1".

Partners deploying their own copy of this connector should set their own
secret ID and profile via these env vars; nothing in this file is
specific to the original deployment.
"""

from __future__ import annotations

import json
import os
import subprocess


def _resolve_secret_id() -> str:
    """Mirror the shell scripts' env-suffix convention so a workshop
    deployed with `--env-suffix dev` automatically resolves to the
    matching secret blob without the user having to set
    ACE_SHARE_SECRET_ID by hand."""
    explicit = os.environ.get("ACE_SHARE_SECRET_ID")
    if explicit:
        return explicit
    suffix = os.environ.get("ENV_SUFFIX", "").strip()
    base = "crm-connector/ace-share"
    return f"{base}-{suffix}" if suffix else base


SECRET_ID = _resolve_secret_id()
PROFILE = os.environ.get("AWS_PROFILE")
REGION = os.environ.get("AWS_REGION", "us-east-1")


def get_hubspot_token() -> str:
    """Read `HUBSPOT_PRIVATE_APP_TOKEN` out of the deployment's Secrets
    Manager blob. Raises `KeyError` if the secret blob exists but the
    key is missing; raises `subprocess.CalledProcessError` if the
    AWS CLI call itself fails (typically: missing profile, missing
    secret, missing IAM permission)."""
    cmd = [
        "aws", "secretsmanager", "get-secret-value",
        "--secret-id", SECRET_ID,
        "--region", REGION,
        "--query", "SecretString",
        "--output", "text",
    ]
    if PROFILE:
        cmd.extend(["--profile", PROFILE])
    raw = subprocess.check_output(cmd)
    blob = json.loads(raw)
    return blob["HUBSPOT_PRIVATE_APP_TOKEN"]
