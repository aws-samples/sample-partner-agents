#!/usr/bin/env bash
#
# Deploy the ACE Share / Refresh backend to AWS.
#
# Configuration (env vars, all optional):
#   AWS_PROFILE        AWS CLI profile. Defaults to the AWS CLI default.
#   AWS_REGION         Target region. Defaults to "us-east-1".
#   STACK_NAME         CloudFormation stack name. Defaults to
#                      "ace-share-refresh".
#   ENV_SUFFIX         Optional environment suffix appended to globally-
#                      named resources (Lambdas, IAM role, DynamoDB,
#                      log groups, Secrets Manager). Empty for
#                      canonical names. Equivalent to passing
#                      --env-suffix.
#
# Prerequisites:
#   - AWS CLI v2.15 or newer
#   - Node.js 20 with `npm ci` and `npm run build` available in ../backend/
#   - The system `zip` and `shasum` CLIs (macOS / Linux defaults)
#   - Python 3 (for the manifest-patch step)
#
# What this script does:
#   1. Builds the two Lambda bundles via `cd ../backend && npm ci && npm run build`.
#   2. Uploads the zips to a per-account artifact bucket (auto-created if
#      missing, private with SSE-KMS).
#   3. Runs `aws cloudformation deploy` with the three S3 Bucket/Key pairs as
#      template parameters.
#   4. Reads the `ApiUrl` stack output and writes it into BOTH:
#        a) hubspot-card/src/app/app-hsmeta.json:config.permittedUrls.fetch
#           (HubSpot enforces an allowlist for hubspot.fetch URLs)
#        b) hubspot-card/src/app/cards/config.local.ts:ACE_API_BASE_URL
#           (the constant the card imports at runtime)
#      Both files are gitignored. The repo ships templates
#      (`app-hsmeta.template.json`, `config.local.ts.example`) that
#      `npm install` materialises on a fresh clone.
#
# Flags:
#   --skip-build         Use existing backend/dist/*.zip bundles without rebuilding.
#   --env-suffix <name>  Append <name> to globally-scoped resource names so
#                        multiple environments can coexist in one AWS account.
#                        Lowercase, digits, hyphens; max 16 chars.
#   -y, --yes            Skip the "about to deploy" confirmation prompt.
#   -h, --help           Show this help.

set -euo pipefail

STACK_NAME="${STACK_NAME:-ace-share-refresh}"
REGION="${AWS_REGION:-us-east-1}"
ENV_SUFFIX="${ENV_SUFFIX:-}"

SKIP_BUILD=false
AUTO_YES=false

# Validate --env-suffix value: lowercase letters, digits, hyphens only,
# max 16 chars, must NOT start or end with a hyphen. Catches the common
# `--env-suffix -dev` typo (leading dash from the user's keyboard) which
# silently produces "ace-share-refresh--dev" — the doubled dash breaks
# every downstream "find me by canonical name" command.
validate_env_suffix() {
  local s="$1"
  if [[ ! "${s}" =~ ^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$ ]]; then
    echo "ERROR: --env-suffix '${s}' is invalid." >&2
    echo "Allowed: lowercase letters/digits/hyphens, max 16 chars," >&2
    echo "must start and end with a letter or digit (e.g. dev, prod-1)." >&2
    echo "If you typed '--env-suffix -dev', drop the leading dash." >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)  SKIP_BUILD=true; shift ;;
    --env-suffix)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --env-suffix requires a value" >&2
        exit 2
      fi
      ENV_SUFFIX="$2"
      validate_env_suffix "${ENV_SUFFIX}"
      shift 2
      ;;
    --env-suffix=*)
      ENV_SUFFIX="${1#--env-suffix=}"
      validate_env_suffix "${ENV_SUFFIX}"
      shift
      ;;
    -y|--yes)      AUTO_YES=true; shift ;;
    -h|--help)
      sed -n '3,46p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# When --env-suffix is set and STACK_NAME is still the default, derive the
# stack name from the suffix so dev and prod don't collide. If the caller
# explicitly set STACK_NAME, honour that.
if [[ -n "${ENV_SUFFIX}" && "${STACK_NAME}" == "ace-share-refresh" ]]; then
  STACK_NAME="ace-share-refresh-${ENV_SUFFIX}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
CARD_APP_MANIFEST="${REPO_ROOT}/hubspot-card/src/app/app-hsmeta.json"
CARD_CONFIG_LOCAL="${REPO_ROOT}/hubspot-card/src/app/cards/config.local.ts"
TEMPLATE="${SCRIPT_DIR}/cloudformation.yaml"

# Resolve the account ID so we can derive a deterministic artifact bucket name.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "${REGION}")"
ARTIFACT_BUCKET="ace-share-refresh-deploy-${ACCOUNT_ID}-${REGION}"

echo "=== ACE Share / Refresh deploy ==="
echo "Stack:           ${STACK_NAME}"
echo "Region:          ${REGION}"
echo "AWS profile:     ${AWS_PROFILE:-<default>}"
echo "Account:         ${ACCOUNT_ID}"
echo "Artifact bucket: ${ARTIFACT_BUCKET}"
echo "Env suffix:      ${ENV_SUFFIX:-<none>}"
echo

if ! "${AUTO_YES}"; then
  read -r -p "Proceed? [y/N] " reply
  [[ "${reply}" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# ---- 1. Build the Lambda bundles --------------------------------------------

if ! "${SKIP_BUILD}"; then
  echo
  echo "=== Building Lambda bundles ==="
  (
    cd "${BACKEND_DIR}"
    if [[ ! -d node_modules ]]; then
      npm ci --no-audit --no-fund
    fi
    npm run build
  )
else
  echo "--skip-build set; using existing ${BACKEND_DIR}/dist/*.zip"
fi

for name in share refresh pull submit; do
  if [[ ! -f "${BACKEND_DIR}/dist/${name}.zip" ]]; then
    echo "ERROR: missing ${BACKEND_DIR}/dist/${name}.zip" >&2
    exit 1
  fi
done

# ---- 2. Ensure artifact bucket exists and upload the zips -------------------

echo
echo "=== Preparing artifact bucket ==="
if ! aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}" --region "${REGION}" 2>/dev/null; then
  echo "Creating ${ARTIFACT_BUCKET} (SSE-KMS, private)..."
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" --region "${REGION}"
  else
    aws s3api create-bucket --bucket "${ARTIFACT_BUCKET}" \
      --region "${REGION}" \
      --create-bucket-configuration "LocationConstraint=${REGION}"
  fi
  aws s3api put-bucket-encryption --bucket "${ARTIFACT_BUCKET}" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
  aws s3api put-public-access-block --bucket "${ARTIFACT_BUCKET}" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi

# Hash each zip so redeploys with unchanged code are a no-op at the
# CloudFormation level (same S3Key → no Lambda replacement).
SHARE_KEY=""
REFRESH_KEY=""
PULL_KEY=""
SUBMIT_KEY=""
for name in share refresh pull submit; do
  zip_path="${BACKEND_DIR}/dist/${name}.zip"
  hash="$(shasum -a 256 "${zip_path}" | awk '{print $1}' | cut -c1-12)"
  s3_key="lambdas/${name}-${hash}.zip"
  aws s3 cp "${zip_path}" "s3://${ARTIFACT_BUCKET}/${s3_key}" \
    --only-show-errors
  case "${name}" in
    share)    SHARE_KEY="${s3_key}" ;;
    refresh)  REFRESH_KEY="${s3_key}" ;;
    pull)     PULL_KEY="${s3_key}" ;;
    submit)   SUBMIT_KEY="${s3_key}" ;;
  esac
  echo "  uploaded ${name} -> s3://${ARTIFACT_BUCKET}/${s3_key}"
done

# ---- 3. Deploy the stack ----------------------------------------------------

echo
echo "=== Deploying CloudFormation stack ==="
aws cloudformation deploy \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "ShareCodeS3Bucket=${ARTIFACT_BUCKET}" \
    "ShareCodeS3Key=${SHARE_KEY}" \
    "RefreshCodeS3Bucket=${ARTIFACT_BUCKET}" \
    "RefreshCodeS3Key=${REFRESH_KEY}" \
    "PullCodeS3Bucket=${ARTIFACT_BUCKET}" \
    "PullCodeS3Key=${PULL_KEY}" \
    "SubmitCodeS3Bucket=${ARTIFACT_BUCKET}" \
    "SubmitCodeS3Key=${SUBMIT_KEY}" \
    "EnvSuffix=${ENV_SUFFIX}"

# ---- 4. Read outputs + sync the card to the live API URL --------------------

echo
echo "=== Stack outputs ==="
API_URL="$(
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
    --output text
)"
SECRET_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" \
    --output text
)"

echo "ApiUrl:    ${API_URL}"
echo "SecretArn: ${SECRET_ARN}"

# Patch app-hsmeta.json so HubSpot allowlists the new URL on hubspot.fetch.
if [[ -f "${CARD_APP_MANIFEST}" ]]; then
  python3 - "${CARD_APP_MANIFEST}" "${API_URL}" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path) as f:
    doc = json.load(f)
cfg = doc.setdefault("config", {})
permitted = cfg.setdefault("permittedUrls", {})
permitted["fetch"] = [url]
with open(path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
  echo "Patched ${CARD_APP_MANIFEST} permittedUrls.fetch=[${API_URL}]"
fi

# Write the card's runtime ACE_API_BASE_URL into the gitignored
# `config.local.ts`. The card source imports `ACE_API_BASE_URL` from
# `./config.local`, which is materialised from `config.local.ts.example`
# by `npm install`'s postinstall hook. Each deploy overwrites the file
# with the current stack's ApiUrl so `hs project upload` ships the
# right URL. The two MUST match the manifest's permittedUrls.fetch
# value above; HubSpot rejects fetches to URLs not in the allowlist.
if [[ -f "${CARD_CONFIG_LOCAL}" || -f "${CARD_CONFIG_LOCAL}.example" ]]; then
  cat > "${CARD_CONFIG_LOCAL}" <<EOF
/**
 * Auto-generated by infra/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
 * DO NOT edit by hand — re-running deploy will overwrite. To switch
 * to a different API URL permanently, change the ApiUrl output of
 * the ace-share-refresh stack and re-run \`./infra/deploy.sh\`.
 *
 * Gitignored — never committed upstream. The repo ships
 * \`config.local.ts.example\` as a template for fresh clones.
 */
export const ACE_API_BASE_URL =
  "${API_URL}";
EOF
  echo "Wrote ${CARD_CONFIG_LOCAL} ACE_API_BASE_URL=${API_URL}"
fi

echo
echo "Next steps (in this order):"
echo "  1. cd hubspot-card && hs project upload   # creates + installs the app"
echo "  2. In HubSpot, install the app, then capture its Access token"
echo "     + Client secret (Development -> Projects -> the app)"
echo "  3. ./infra/set-secrets.sh --auto-bounce   # paste those + the ACE keys"
echo "  4. ./scripts/setup-hubspot-properties.sh  # provision deal properties"
