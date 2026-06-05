#!/usr/bin/env bash
#
# One-shot wrapper that provisions every HubSpot custom property the
# CRM card depends on. Replaces five separate commands in the workshop
# (Lab 11) with a single call.
#
# Steps (all idempotent — safe to re-run):
#   1. Required deal properties + the aws_partner_fields property group.
#   2. Bidirectional picklists (industry, currency, opportunity type ...).
#   3. Bidirectional freeform fields (involvement type, visibility ...).
#   4. Solution Offerings multi-checkbox picklist.
#   5. AWS Products multi-checkbox picklist (~390 entries from the
#      AWS-published sample catalog).
#
# Usage:
#   ./scripts/setup-hubspot-properties.sh                   # all 5 steps
#   ./scripts/setup-hubspot-properties.sh --skip-aws-products
#   ./scripts/setup-hubspot-properties.sh --profile my-aws-profile
#
# Configuration (env vars, all optional):
#   AWS_PROFILE   AWS CLI profile (used to read the HubSpot token from
#                 Secrets Manager). Overridden by --profile.
#   AWS_REGION    Defaults to us-east-1.
#   ENV_SUFFIX    Environment suffix used at deploy time. Equivalent to
#                 passing --env-suffix. Resolves the right secret blob
#                 when the CRM stack was deployed with --env-suffix.
#   ACE_SHARE_SECRET_ID  Defaults to crm-connector/ace-share (or
#                 crm-connector/ace-share-${ENV_SUFFIX} when ENV_SUFFIX
#                 is set).
#   AWS_PRODUCTS_CSV  Path to the AWS Products CSV. Defaults to
#                 /tmp/SampleAWSProducts.csv. Auto-downloaded from
#                 aws-samples/partner-crm-integration-samples on first
#                 run if the file doesn't exist.
#
# Flags:
#   --profile <name>    Set AWS_PROFILE for the run.
#   --region <name>     Set AWS_REGION for the run.
#   --env-suffix <name>  Match a stack deployed with --env-suffix.
#                        Lowercase letters/digits/hyphens, max 16 chars.
#   --skip-aws-products  Skip step 5. Useful if you've already seeded
#                        the picklist and don't want to re-download the
#                        CSV from GitHub.
#   -h, --help           Show this help.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SKIP_AWS_PRODUCTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --profile requires a value" >&2
        exit 2
      fi
      export AWS_PROFILE="$2"
      shift 2
      ;;
    --profile=*)
      export AWS_PROFILE="${1#--profile=}"
      shift
      ;;
    --region)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --region requires a value" >&2
        exit 2
      fi
      export AWS_REGION="$2"
      shift 2
      ;;
    --region=*)
      export AWS_REGION="${1#--region=}"
      shift
      ;;
    --skip-aws-products) SKIP_AWS_PRODUCTS=true; shift ;;
    --env-suffix)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --env-suffix requires a value" >&2
        exit 2
      fi
      export ENV_SUFFIX="$2"
      if [[ ! "${ENV_SUFFIX}" =~ ^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$ ]]; then
        echo "ERROR: --env-suffix '${ENV_SUFFIX}' is invalid." >&2
        echo "Allowed: lowercase letters/digits/hyphens, max 16 chars." >&2
        exit 2
      fi
      shift 2
      ;;
    --env-suffix=*)
      export ENV_SUFFIX="${1#--env-suffix=}"
      if [[ ! "${ENV_SUFFIX}" =~ ^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$ ]]; then
        echo "ERROR: --env-suffix '${ENV_SUFFIX}' is invalid." >&2
        exit 2
      fi
      shift
      ;;
    -h|--help)
      sed -n '3,46p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

AWS_PRODUCTS_CSV="${AWS_PRODUCTS_CSV:-/tmp/SampleAWSProducts.csv}"
AWS_PRODUCTS_URL="https://raw.githubusercontent.com/aws-samples/partner-crm-integration-samples/main/resources/SampleAWSProducts.csv"

echo "=== HubSpot custom properties setup ==="
echo "AWS profile: ${AWS_PROFILE:-<default>}"
echo "AWS region:  ${AWS_REGION:-us-east-1}"
echo

# --- venv activation --------------------------------------------------------
# The Python provisioning scripts depend on the project's virtualenv
# (typer, hubspot-api-client, etc.). If no venv is active and one
# doesn't exist at .venv/, create it and install the project deps so
# this script works on a fresh clone without a manual `pip install`
# step. Use `python3` consistently — bare `python` is intercepted by
# tools like `rye` on some workstations and refuses to run when there
# isn't a project lock it recognises.
ensure_venv() {
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    echo "Using already-active virtualenv: ${VIRTUAL_ENV}"
    return
  fi

  local venv_dir="${REPO_ROOT}/.venv"
  local activate=""
  if [[ -f "${venv_dir}/bin/activate" ]]; then
    activate="${venv_dir}/bin/activate"
  elif [[ -f "${venv_dir}/Scripts/activate" ]]; then
    activate="${venv_dir}/Scripts/activate"  # Windows / Git Bash
  fi

  if [[ -z "${activate}" ]]; then
    echo "No virtualenv found at ${venv_dir}. Creating one with python3..."
    python3 -m venv "${venv_dir}"
    if [[ -f "${venv_dir}/bin/activate" ]]; then
      activate="${venv_dir}/bin/activate"
    else
      activate="${venv_dir}/Scripts/activate"
    fi
    # shellcheck disable=SC1090
    source "${activate}"
    echo "Installing project deps (pip install -e \".[dev]\") ..."
    # --no-cache-dir avoids "Cache entry deserialization failed"
    # warnings when the user has a corrupt ~/.cache/pip — those are
    # harmless but flood the log on first install.
    pip install --no-cache-dir --quiet --upgrade pip
    pip install --no-cache-dir --quiet -e "${REPO_ROOT}[dev]"
    echo "Virtualenv ready at ${venv_dir}"
    return
  fi

  # shellcheck disable=SC1090
  source "${activate}"
  echo "Activated virtualenv at ${venv_dir}"

  # Make sure the project itself is installed editable in the venv —
  # otherwise `python -m src.main` fails with ModuleNotFoundError.
  if ! python3 -c "import src.main" 2>/dev/null; then
    echo "Project deps look incomplete; running pip install -e \".[dev]\" ..."
    pip install --no-cache-dir --quiet --upgrade pip
    pip install --no-cache-dir --quiet -e "${REPO_ROOT}[dev]"
  fi
}

ensure_venv

# --- token export -----------------------------------------------------------
# Step 1 (`python3 -m src.main setup-hubspot`) reads HUBSPOT_API_KEY from
# the environment via the legacy HubSpotConfig dataclass. The other four
# scripts read HUBSPOT_PRIVATE_APP_TOKEN from Secrets Manager via
# _hubspot_token.py. Both names point at the same value — the workshop
# token sitting in `crm-connector/ace-share`. Fetch it once via the
# helper and export under both names so every step has what it needs.
echo
echo "=== Fetching HubSpot token from Secrets Manager ==="

# Resolve the secret ID to read. The Python provisioning scripts read
# from $ACE_SHARE_SECRET_ID via _hubspot_token.py — set it here so we
# only have to know about the suffix in one place.
if [[ -z "${ACE_SHARE_SECRET_ID:-}" ]]; then
  if [[ -n "${ENV_SUFFIX:-}" ]]; then
    export ACE_SHARE_SECRET_ID="crm-connector/ace-share-${ENV_SUFFIX}"
  else
    export ACE_SHARE_SECRET_ID="crm-connector/ace-share"
  fi
fi
echo "Reading from secret: ${ACE_SHARE_SECRET_ID}"

# Have get-hubspot-token.sh resolve via the matching stack name. It
# honours STACK_NAME / ENV_SUFFIX too.
if [[ -n "${ENV_SUFFIX:-}" ]]; then
  HS_TOKEN="$(STACK_NAME="ace-share-refresh-${ENV_SUFFIX}" "${SCRIPT_DIR}/get-hubspot-token.sh")"
else
  HS_TOKEN="$("${SCRIPT_DIR}/get-hubspot-token.sh")"
fi
if [[ -z "${HS_TOKEN}" ]]; then
  echo "ERROR: HubSpot token is empty. Did set-secrets.sh complete in Lab 10?" >&2
  exit 1
fi
export HUBSPOT_API_KEY="${HS_TOKEN}"
export HUBSPOT_PRIVATE_APP_TOKEN="${HS_TOKEN}"
echo "Token loaded (length: ${#HS_TOKEN} chars)."
unset HS_TOKEN

# --- step 1: setup-hubspot --------------------------------------------------
echo
echo "=== 1/5  Required deal properties (python3 -m src.main setup-hubspot) ==="
(cd "${REPO_ROOT}" && python3 -m src.main setup-hubspot)

# --- step 2: bidirectional picklists ----------------------------------------
echo
echo "=== 2/5  Bidirectional picklists ==="
(cd "${REPO_ROOT}" && python3 scripts/setup_ace_picklists.py)

# --- step 3: bidirectional freeform fields ----------------------------------
echo
echo "=== 3/5  Bidirectional freeform fields ==="
(cd "${REPO_ROOT}" && python3 scripts/setup_ace_bidirectional_fields.py)

# --- step 4: solutions picklist ---------------------------------------------
echo
echo "=== 4/5  Solution Offerings picklist ==="
(cd "${REPO_ROOT}" && python3 scripts/setup_ace_solutions.py)

# --- step 5: AWS Products picklist ------------------------------------------
if "${SKIP_AWS_PRODUCTS}"; then
  echo
  echo "=== 5/5  AWS Products picklist [skipped via --skip-aws-products] ==="
else
  echo
  echo "=== 5/5  AWS Products picklist (~390 entries) ==="
  if [[ ! -f "${AWS_PRODUCTS_CSV}" ]]; then
    echo "Downloading ${AWS_PRODUCTS_URL}"
    echo "        -> ${AWS_PRODUCTS_CSV}"
    curl -fsSL "${AWS_PRODUCTS_URL}" -o "${AWS_PRODUCTS_CSV}"
  else
    echo "Using cached CSV at ${AWS_PRODUCTS_CSV}"
    echo "(delete the file or set AWS_PRODUCTS_CSV=... to refresh)"
  fi
  (cd "${REPO_ROOT}" && CSV_PATH="${AWS_PRODUCTS_CSV}" python3 scripts/seed-aws-products-picklist.py)
fi

echo
echo "=== HubSpot custom properties setup complete ==="
echo
echo "Verify in HubSpot:"
echo "  Settings -> Properties -> Deal properties -> filter by group"
echo "  'AWS Partner Central' (group id: aws_partner_fields)."
echo
