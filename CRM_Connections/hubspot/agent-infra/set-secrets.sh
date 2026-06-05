#!/usr/bin/env bash
#
# Populate (or update) the AWS Secrets Manager blob used by the Agent Lambda.
#
# Usage:
#   ./agent-infra/set-secrets.sh                          # prompt for all keys
#   ./agent-infra/set-secrets.sh HUBSPOT_CLIENT_SECRET    # re-prompt for one key
#   ./agent-infra/set-secrets.sh --auto-bounce            # also bounce Lambdas
#   ./agent-infra/set-secrets.sh --profile other-profile  # use a different profile
#   ./agent-infra/set-secrets.sh --env-suffix dev         # target the suffixed stack
#   ./agent-infra/set-secrets.sh -h                       # help
#
# Flags:
#   --auto-bounce  After updating the secret, force-bounce every Lambda
#                  in the stack so warm containers refetch immediately.
#                  Preserves existing Lambda env vars.
#
# Configuration (env vars, all optional):
#   AWS_PROFILE   AWS CLI profile. Overridden by --profile if both are set.
#   AWS_REGION    Target region. Defaults to "us-east-1".
#   STACK_NAME    CloudFormation stack name. Defaults to "ace-agent" (or
#                 "ace-agent-${ENV_SUFFIX}" when ENV_SUFFIX is set and
#                 STACK_NAME wasn't overridden).
#   ENV_SUFFIX    Environment suffix used at deploy time. Equivalent to
#                 passing --env-suffix.
#
# Secrets prompted for:
#   HUBSPOT_CLIENT_SECRET       — required (HubSpot v3 HMAC verification key)
#   HUBSPOT_PRIVATE_APP_TOKEN   — optional (enables deal-context preamble)
#   ACE_AGENT_CATALOG           — Sandbox (default) or AWS

set -euo pipefail

STACK_NAME_DEFAULT="ace-agent"
STACK_NAME="${STACK_NAME:-${STACK_NAME_DEFAULT}}"
REGION="${AWS_REGION:-us-east-1}"
ENV_SUFFIX="${ENV_SUFFIX:-}"
AUTO_BOUNCE=false

ALL_KEYS=(
  HUBSPOT_CLIENT_SECRET
  HUBSPOT_PRIVATE_APP_TOKEN
  ACE_AGENT_CATALOG
)

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

PROFILE_OVERRIDE=""
KEY_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE_OVERRIDE="${2:-}"
      shift 2
      ;;
    --profile=*)
      PROFILE_OVERRIDE="${1#--profile=}"
      shift
      ;;
    --env-suffix)
      if [[ -z "${2:-}" ]]; then
        echo "--env-suffix requires a value" >&2
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
    --auto-bounce)
      AUTO_BOUNCE=true
      shift
      ;;
    -h|--help)
      sed -n '3,32p' "$0"
      exit 0
      ;;
    *)
      KEY_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -n "${ENV_SUFFIX}" && "${STACK_NAME}" == "${STACK_NAME_DEFAULT}" ]]; then
  STACK_NAME="${STACK_NAME_DEFAULT}-${ENV_SUFFIX}"
fi
echo "Using stack: ${STACK_NAME}"

PROFILE="${PROFILE_OVERRIDE:-${AWS_PROFILE:-}}"
PROFILE_ARGS=()
if [[ -n "${PROFILE}" ]]; then
  PROFILE_ARGS+=(--profile "${PROFILE}")
  echo "Using AWS profile: ${PROFILE}"
else
  echo "Using AWS profile: <default>"
fi

if [[ ${#KEY_ARGS[@]} -eq 0 ]]; then
  KEYS_TO_PROMPT=("${ALL_KEYS[@]}")
else
  KEYS_TO_PROMPT=("${KEY_ARGS[@]}")
  for key in "${KEYS_TO_PROMPT[@]}"; do
    found=false
    for allowed in "${ALL_KEYS[@]}"; do
      [[ "${key}" == "${allowed}" ]] && found=true && break
    done
    if ! "${found}"; then
      echo "Unknown secret key: ${key}" >&2
      echo "Known keys: ${ALL_KEYS[*]}" >&2
      exit 2
    fi
  done
fi

SECRET_ARN="$(
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" \
    --output text 2>/dev/null || true
)"
if [[ -z "${SECRET_ARN}" || "${SECRET_ARN}" == "None" ]]; then
  echo "Could not read SecretArn from stack '${STACK_NAME}' in ${REGION}." >&2
  echo "Deploy the stack first: ./agent-infra/deploy.sh" >&2
  exit 1
fi
echo "Secret:    ${SECRET_ARN}"

existing_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "${SECRET_ARN}" \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}" \
    --query SecretString \
    --output text 2>/dev/null || echo '{}'
)"
if [[ "${existing_json}" == "None" || -z "${existing_json}" ]]; then
  existing_json='{}'
fi

collected_env=()
for key in "${KEYS_TO_PROMPT[@]}"; do
  prompt="  ${key}"
  case "${key}" in
    HUBSPOT_PRIVATE_APP_TOKEN)
      echo
      echo "  HUBSPOT_PRIVATE_APP_TOKEN — optional. When set, the agent fetches"
      echo "  basic deal properties (name, ace_opportunity_id, etc.) and"
      echo "  prepends a context preamble to every user message so 'this deal'"
      echo "  / 'this opportunity' resolves correctly. Leave blank to skip."
      ;;
    ACE_AGENT_CATALOG)
      echo
      echo "  ACE_AGENT_CATALOG — Sandbox (default) or AWS."
      echo "  Press Enter to accept the default. Type 'AWS' for production."
      prompt="  ACE_AGENT_CATALOG [Sandbox]"
      ;;
  esac

  if [[ "${key}" == "ACE_AGENT_CATALOG" ]]; then
    read -r -p "${prompt}: " value || true
    if [[ -z "${value}" ]]; then
      value="Sandbox"
      echo "  → using default Sandbox"
    fi
  elif [[ "${key}" == "HUBSPOT_PRIVATE_APP_TOKEN" ]]; then
    read -rs -p "${prompt} (optional): " value || true
    echo
  else
    read -rs -p "${prompt}: " value || true
    echo
  fi

  collected_env+=("NEWVAL_${key}=${value}")
done

merged_json="$(
  env "${collected_env[@]}" EXISTING_BLOB="${existing_json}" python3 - <<'PY'
import json, os
existing = json.loads(os.environ["EXISTING_BLOB"])
for env_name, val in os.environ.items():
    if not env_name.startswith("NEWVAL_"):
        continue
    secret_key = env_name[len("NEWVAL_"):]
    # Empty input means "don't touch this key" — preserves existing values
    # on a re-run. Set HUBSPOT_PRIVATE_APP_TOKEN to a literal "DELETE" to
    # actually clear it.
    if val == "":
        continue
    if val == "DELETE":
        existing.pop(secret_key, None)
        continue
    existing[secret_key] = val
print(json.dumps(existing))
PY
)"

aws secretsmanager put-secret-value \
  --secret-id "${SECRET_ARN}" \
  ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
  --region "${REGION}" \
  --secret-string "${merged_json}" > /dev/null

echo
echo "Secret updated."
echo

# Discover deployed Lambda function names from the stack — works
# regardless of --env-suffix / custom STACK_NAME.
LAMBDA_NAMES_RAW="$(
  aws cloudformation list-stack-resources \
    --stack-name "${STACK_NAME}" \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" \
    --output text 2>/dev/null
)"
LAMBDA_NAMES="$(echo "${LAMBDA_NAMES_RAW}" | tr '\t' ' ')"
PROFILE_FOR_PRINT="${PROFILE:-<your-profile>}"

# Merge-bounce: read existing env vars, bump FORCE_REFRESH, push.
# Preserves AGENT_JOB_TABLE and any other Lambda-specific config.
bounce_lambda() {
  local fn="$1"
  local stamp="$2"
  local merged
  merged="$(
    aws lambda get-function-configuration \
      --function-name "${fn}" \
      ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
      --region "${REGION}" \
      --query "Environment.Variables" \
      --output json 2>/dev/null \
    | STAMP="${stamp}" python3 -c '
import json, os, sys
v = json.loads(sys.stdin.read() or "{}") or {}
v["FORCE_REFRESH"] = os.environ["STAMP"]
pairs = [f"{k}={val}" for k, val in v.items()]
print("Variables={" + ",".join(pairs) + "}")
'
  )"
  aws lambda update-function-configuration \
    --function-name "${fn}" \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}" \
    --environment "${merged}" > /dev/null
  aws lambda wait function-updated \
    --function-name "${fn}" \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}"
  echo "  bounced ${fn}"
}

if "${AUTO_BOUNCE}"; then
  if [[ -z "${LAMBDA_NAMES}" ]]; then
    echo "WARN: could not discover Lambda functions from stack ${STACK_NAME}; skipping auto-bounce." >&2
    exit 0
  fi
  echo "Auto-bouncing Lambda functions so they refetch the secret immediately:"
  STAMP="$(date +%s)"
  for fn in ${LAMBDA_NAMES}; do
    bounce_lambda "${fn}" "${STAMP}"
  done
  echo
  echo "All ${LAMBDA_NAMES// /, } updated."
  echo
  exit 0
fi

echo "IMPORTANT: warm Lambda containers still hold the old values."
echo "Re-run with --auto-bounce to bounce them automatically:"
echo
echo "  ./agent-infra/set-secrets.sh --auto-bounce ${PROFILE:+--profile ${PROFILE}}${ENV_SUFFIX:+ --env-suffix ${ENV_SUFFIX}}"
echo
