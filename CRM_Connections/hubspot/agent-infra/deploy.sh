#!/usr/bin/env bash
#
# Deploy the AWS Partner Central Agent backend.
#
# Configuration (env vars, all optional):
#   AWS_PROFILE        AWS CLI profile. Defaults to the AWS CLI default.
#   AWS_REGION         Target region. Defaults to "us-east-1".
#   STACK_NAME         CloudFormation stack name. Defaults to "ace-agent".
#   ENV_SUFFIX         Optional environment suffix appended to globally-
#                      named resources (Lambdas, IAM roles, DynamoDB job
#                      table, log groups, Secrets Manager). Empty for
#                      canonical names. Equivalent to passing
#                      --env-suffix.
#
# Prerequisites:
#   - AWS CLI v2.15 or newer
#   - Node.js 20 with `npm ci` and `npm run build` available in ../agent-backend/
#   - The system `zip` and `shasum` CLIs
#   - Python 3 (for manifest patching)
#
# What this script does:
#   1. Builds the agent Lambda bundle via `cd ../agent-backend && npm ci && npm run build`.
#   2. Uploads the zip to a per-account artifact bucket (auto-created if missing).
#   3. Runs `aws cloudformation deploy` with the S3 Bucket/Key pair.
#   4. Reads the `ApiUrl` stack output and writes it into BOTH:
#        a) ../agent-card/src/app/app-hsmeta.json:config.permittedUrls.fetch
#        b) ../agent-card/src/app/cards/config.local.ts:AGENT_API_BASE_URL
#      Both files are gitignored. The repo ships templates
#      (`app-hsmeta.template.json`, `config.local.ts.example`) that
#      `npm install` materialises on a fresh clone.
#
# Flags:
#   --skip-build         Use existing agent-backend/dist/*.zip bundles without rebuilding.
#   --env-suffix <name>  Append <name> to globally-scoped resource names.
#                        Lowercase, digits, hyphens; max 16 chars.
#   -y, --yes            Skip the "about to deploy" confirmation prompt.
#   -h, --help           Show this help.

set -euo pipefail

STACK_NAME="${STACK_NAME:-ace-agent}"
REGION="${AWS_REGION:-us-east-1}"
ENV_SUFFIX="${ENV_SUFFIX:-}"

SKIP_BUILD=false
AUTO_YES=false

# Validate --env-suffix value: lowercase letters, digits, hyphens only,
# max 16 chars, must NOT start or end with a hyphen. Catches the common
# `--env-suffix -dev` typo (leading dash) which silently produces
# "ace-agent--dev" — the doubled dash breaks every "find me by
# canonical name" downstream command.
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
      sed -n '3,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# Mirror the suffix into the stack name when STACK_NAME is still the default.
if [[ -n "${ENV_SUFFIX}" && "${STACK_NAME}" == "ace-agent" ]]; then
  STACK_NAME="ace-agent-${ENV_SUFFIX}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/agent-backend"
CARD_APP_MANIFEST="${REPO_ROOT}/agent-card/src/app/app-hsmeta.json"
CARD_CONFIG_LOCAL="${REPO_ROOT}/agent-card/src/app/cards/config.local.ts"
TEMPLATE="${SCRIPT_DIR}/cloudformation.yaml"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "${REGION}")"
ARTIFACT_BUCKET="ace-agent-deploy-${ACCOUNT_ID}-${REGION}"

echo "=== AWS Partner Central Agent deploy ==="
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

# ---- 1. Build Lambda bundles -------------------------------------------------

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

for name in agent agent-async; do
  if [[ ! -f "${BACKEND_DIR}/dist/${name}.zip" ]]; then
    echo "ERROR: missing ${BACKEND_DIR}/dist/${name}.zip" >&2
    exit 1
  fi
done

# ---- 2. Ensure artifact bucket + upload zips --------------------------------

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

AGENT_KEY=""
AGENT_ASYNC_KEY=""
for name in agent agent-async; do
  zip_path="${BACKEND_DIR}/dist/${name}.zip"
  hash="$(shasum -a 256 "${zip_path}" | awk '{print $1}' | cut -c1-12)"
  s3_key="lambdas/${name}-${hash}.zip"
  aws s3 cp "${zip_path}" "s3://${ARTIFACT_BUCKET}/${s3_key}" --only-show-errors
  if [[ "${name}" == "agent" ]]; then
    AGENT_KEY="${s3_key}"
  else
    AGENT_ASYNC_KEY="${s3_key}"
  fi
  echo "  uploaded ${name} -> s3://${ARTIFACT_BUCKET}/${s3_key}"
done

# ---- 3. Deploy stack --------------------------------------------------------

echo
echo "=== Deploying CloudFormation stack ==="
aws cloudformation deploy \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "AgentCodeS3Bucket=${ARTIFACT_BUCKET}" \
    "AgentCodeS3Key=${AGENT_KEY}" \
    "AgentAsyncCodeS3Key=${AGENT_ASYNC_KEY}" \
    "EnvSuffix=${ENV_SUFFIX}"

# ---- 4. Read outputs + sync card --------------------------------------------

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

if [[ -f "${CARD_CONFIG_LOCAL}" || -f "${CARD_CONFIG_LOCAL}.example" ]]; then
  cat > "${CARD_CONFIG_LOCAL}" <<EOF
/**
 * Auto-generated by agent-infra/deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
 * DO NOT edit by hand — re-running deploy will overwrite. To switch
 * to a different API URL permanently, change the ApiUrl output of
 * the ace-agent stack and re-run \`./agent-infra/deploy.sh\`.
 *
 * Gitignored — never committed upstream. The repo ships
 * \`config.local.ts.example\` as a template for fresh clones.
 */
export const AGENT_API_BASE_URL =
  "${API_URL}";
EOF
  echo "Wrote ${CARD_CONFIG_LOCAL} AGENT_API_BASE_URL=${API_URL}"
fi

echo
echo "Next steps (in this order):"
echo "  1. cd agent-card && hs project upload   # creates + installs the app"
echo "  2. In HubSpot, install the app and copy its Client secret"
echo "     (Development -> Projects -> the app -> Auth tab)"
echo "  3. ./agent-infra/set-secrets.sh --auto-bounce   # paste that secret"
