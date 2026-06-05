#!/usr/bin/env bash
#
# Populate (or update) the AWS Secrets Manager blob used by the Share /
# Refresh Lambdas.
#
# Usage:
#   ./infra/set-secrets.sh                              # prompt for all keys
#   ./infra/set-secrets.sh HUBSPOT_PRIVATE_APP_TOKEN    # re-prompt for one key
#   ./infra/set-secrets.sh --auto-bounce                # also bounce Lambdas
#   ./infra/set-secrets.sh --profile other-profile      # use a different AWS profile
#   ./infra/set-secrets.sh --env-suffix dev             # target the suffixed stack
#   ./infra/set-secrets.sh -h                           # help
#
# Flags:
#   --auto-bounce  After updating the secret, force-bounce every Lambda
#                  in the stack so warm containers refetch immediately.
#                  Preserves existing Lambda env vars (only bumps the
#                  no-op FORCE_REFRESH timestamp). Without this flag the
#                  script just prints how to bounce manually.
#
# Configuration (env vars, all optional):
#   AWS_PROFILE   AWS CLI profile. Overridden by --profile if both are set.
#                 Defaults to the AWS CLI default profile.
#   AWS_REGION    Target region. Defaults to "us-east-1".
#   STACK_NAME    CloudFormation stack name. Defaults to "ace-share-refresh"
#                 (or "ace-share-refresh-${ENV_SUFFIX}" when ENV_SUFFIX is
#                 set and STACK_NAME wasn't overridden explicitly).
#   ENV_SUFFIX    Environment suffix used at deploy time. Equivalent to
#                 passing --env-suffix. Auto-derives STACK_NAME when set.
#
# Input is read with `read -s` (hidden) so tokens never land in scrollback.
# Values are merged with any existing blob via an in-memory JSON merge;
# fields not prompted for are preserved as-is.
#
# Lambda picks up new values on next cold start. To force a refresh
# immediately, toggle any env var on each Lambda function — see
# infra/README.md for the command.

set -euo pipefail

STACK_NAME_DEFAULT="ace-share-refresh"
STACK_NAME="${STACK_NAME:-${STACK_NAME_DEFAULT}}"
REGION="${AWS_REGION:-us-east-1}"
ENV_SUFFIX="${ENV_SUFFIX:-}"
AUTO_BOUNCE=false

ALL_KEYS=(
  AWS_ACE_ACCESS_KEY_ID
  AWS_ACE_SECRET_ACCESS_KEY
  ACE_REGION
  STAGE_MAPPING
  STAGE_DISPLAY_NAMES
  HUBSPOT_PRIVATE_APP_TOKEN
  HUBSPOT_CLIENT_SECRET
)

# Default mapping for HubSpot's standard 7-stage deal pipeline. Partners
# whose pipeline matches the out-of-the-box HubSpot stages can accept these
# defaults at the prompt; partners with a customised pipeline can paste
# their own value instead. Keys are HubSpot's built-in internal stage IDs.
#
# Reasoning for each pair:
#   appointmentscheduled    → Qualified           (initial outreach / discovery)
#   qualifiedtobuy          → Qualified           (still pre-eval; collapse to one ACE stage)
#   presentationscheduled   → Technical Validation (architecture review territory)
#   decisionmakerboughtin   → Business Validation (commercial review)
#   contractsent            → Committed           (paperwork in flight)
#   closedwon               → Launched            (deal won → solution launched)
#   closedlost              → Closed Lost         (terminal)
DEFAULT_STAGE_MAPPING="appointmentscheduled=Qualified;qualifiedtobuy=Qualified;presentationscheduled=Technical Validation;decisionmakerboughtin=Business Validation;contractsent=Committed;closedwon=Launched;closedlost=Closed Lost"

DEFAULT_STAGE_DISPLAY_NAMES="appointmentscheduled=Appointment Scheduled;qualifiedtobuy=Qualified to Buy;presentationscheduled=Presentation Scheduled;decisionmakerboughtin=Decision Maker Bought-In;contractsent=Contract Sent;closedwon=Closed Won;closedlost=Closed Lost"

# Parse --profile, --env-suffix, --help; everything else is treated as a key name.
PROFILE_OVERRIDE=""
KEY_ARGS=()
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
    --profile)
      PROFILE_OVERRIDE="${2:-}"
      if [[ -z "${PROFILE_OVERRIDE}" ]]; then
        echo "--profile requires a value" >&2
        exit 2
      fi
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
      sed -n '3,38p' "$0"
      exit 0
      ;;
    *)
      KEY_ARGS+=("$1")
      shift
      ;;
  esac
done

# When --env-suffix is set and STACK_NAME wasn't explicitly overridden,
# auto-derive the stack name. Mirrors the deploy-time logic so partners
# don't have to remember to set both vars in sync.
if [[ -n "${ENV_SUFFIX}" && "${STACK_NAME}" == "${STACK_NAME_DEFAULT}" ]]; then
  STACK_NAME="${STACK_NAME_DEFAULT}-${ENV_SUFFIX}"
fi
echo "Using stack: ${STACK_NAME}"

# Resolve effective profile. Empty string ⇒ use the AWS CLI default chain.
PROFILE="${PROFILE_OVERRIDE:-${AWS_PROFILE:-}}"
if [[ -n "${PROFILE}" ]]; then
  echo "Using AWS profile: ${PROFILE}"
else
  echo "Using AWS profile: <default>"
fi

# Build a profile flag once so we can splice it into every aws call without
# emitting an empty `--profile` value when no profile is set.
PROFILE_ARGS=()
if [[ -n "${PROFILE}" ]]; then
  PROFILE_ARGS+=(--profile "${PROFILE}")
fi

# Decide which keys to prompt for.
if [[ ${#KEY_ARGS[@]} -eq 0 ]]; then
  KEYS_TO_PROMPT=("${ALL_KEYS[@]}")
else
  KEYS_TO_PROMPT=("${KEY_ARGS[@]}")
  # Validate each arg against the allow-list.
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

# Resolve the secret ARN from the stack output.
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
  echo "Deploy the stack first: ./infra/deploy.sh" >&2
  exit 1
fi
echo "Secret:    ${SECRET_ARN}"

# Read existing blob so we can merge.
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

# Probe whether the existing blob already has values for the stage keys.
# This drives the prompt copy: on a first run, blank input substitutes the
# default; on a re-run, blank input means "leave the existing value alone".
HAS_EXISTING_STAGE_MAPPING=$(
  EXISTING_BLOB="${existing_json}" python3 -c '
import json, os
b = json.loads(os.environ["EXISTING_BLOB"])
v = b.get("STAGE_MAPPING", "")
print("yes" if isinstance(v, str) and v.strip() else "no")
'
)
HAS_EXISTING_STAGE_DISPLAY_NAMES=$(
  EXISTING_BLOB="${existing_json}" python3 -c '
import json, os
b = json.loads(os.environ["EXISTING_BLOB"])
v = b.get("STAGE_DISPLAY_NAMES", "")
print("yes" if isinstance(v, str) and v.strip() else "no")
'
)

# Collect new values. For each requested key, prompt with hidden stdin.
# Stash values directly in shell vars rather than an associative array
# (macOS bash 3.2 lacks `declare -A`).
collected_env=()
for key in "${KEYS_TO_PROMPT[@]}"; do
  prompt="  ${key}"
  default_value=""
  case "${key}" in
    ACE_REGION)
      prompt+=" [us-east-1]"
      ;;
    STAGE_MAPPING)
      default_value="${DEFAULT_STAGE_MAPPING}"
      echo
      echo "  STAGE_MAPPING — HubSpot stage ID → ACE stage."
      echo "  Default (HubSpot's standard 7-stage pipeline):"
      echo "    ${DEFAULT_STAGE_MAPPING}"
      if [[ "${HAS_EXISTING_STAGE_MAPPING}" == "yes" ]]; then
        echo "  An existing value is already set. Press Enter to keep it, type 'default' to overwrite with the default, or paste a custom mapping."
        prompt="  STAGE_MAPPING [keep|default|custom]"
      else
        echo "  No value is set yet. Press Enter to use the default, or paste a custom mapping."
        prompt="  STAGE_MAPPING [default|custom]"
      fi
      ;;
    STAGE_DISPLAY_NAMES)
      default_value="${DEFAULT_STAGE_DISPLAY_NAMES}"
      echo
      echo "  STAGE_DISPLAY_NAMES — HubSpot stage ID → human label (used in toasts)."
      echo "  Default (HubSpot's standard pipeline labels):"
      echo "    ${DEFAULT_STAGE_DISPLAY_NAMES}"
      if [[ "${HAS_EXISTING_STAGE_DISPLAY_NAMES}" == "yes" ]]; then
        echo "  An existing value is already set. Press Enter to keep it, type 'default' to overwrite with the default, or paste a custom mapping."
        prompt="  STAGE_DISPLAY_NAMES [keep|default|custom]"
      else
        echo "  No value is set yet. Press Enter to use the default, or paste a custom mapping. (This field is optional — type the literal word 'blank' to leave it empty.)"
        prompt="  STAGE_DISPLAY_NAMES [default|custom|blank]"
      fi
      ;;
  esac

  if [[ "${key}" == "ACE_REGION" || "${key}" == "STAGE_MAPPING" || "${key}" == "STAGE_DISPLAY_NAMES" ]]; then
    # Non-secret-ish — visible input is fine and makes mistyping obvious.
    read -r -p "${prompt}: " value || true
  else
    # Secret — hidden stdin.
    read -rs -p "${prompt}: " value || true
    echo
  fi

  # Stage-key handling:
  #   - typed 'default' → substitute the default mapping
  #   - typed 'blank'   → empty string (only meaningful for STAGE_DISPLAY_NAMES)
  #   - blank input + no existing value → substitute the default mapping
  #   - blank input + existing value → leave alone (handled by python merge)
  case "${key}" in
    STAGE_MAPPING)
      if [[ "${value}" == "default" ]]; then
        value="${default_value}"
        echo "  → using default STAGE_MAPPING"
      elif [[ -z "${value}" && "${HAS_EXISTING_STAGE_MAPPING}" == "no" ]]; then
        value="${default_value}"
        echo "  → first run, no existing value: using default STAGE_MAPPING"
      fi
      ;;
    STAGE_DISPLAY_NAMES)
      if [[ "${value}" == "default" ]]; then
        value="${default_value}"
        echo "  → using default STAGE_DISPLAY_NAMES"
      elif [[ "${value}" == "blank" ]]; then
        value=""
        echo "  → leaving STAGE_DISPLAY_NAMES empty"
      elif [[ -z "${value}" && "${HAS_EXISTING_STAGE_DISPLAY_NAMES}" == "no" ]]; then
        value="${default_value}"
        echo "  → first run, no existing value: using default STAGE_DISPLAY_NAMES"
      fi
      ;;
  esac

  collected_env+=("NEWVAL_${key}=${value}")
done

# Merge existing + new in python (cleaner than jq + shell quoting). Pass
# values via environment to avoid embedding them in the heredoc.
merged_json="$(
  env "${collected_env[@]}" EXISTING_BLOB="${existing_json}" python3 - <<'PY'
import json
import os
existing = json.loads(os.environ["EXISTING_BLOB"])
for env_name, val in os.environ.items():
    if not env_name.startswith("NEWVAL_"):
        continue
    secret_key = env_name[len("NEWVAL_"):]
    if val == "" and secret_key != "STAGE_DISPLAY_NAMES":
        # Empty input means "don't touch this key" (except for optional
        # fields where blank is meaningful).
        continue
    existing[secret_key] = val
print(json.dumps(existing))
PY
)"

# Push the merged blob.
aws secretsmanager put-secret-value \
  --secret-id "${SECRET_ARN}" \
  ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
  --region "${REGION}" \
  --secret-string "${merged_json}" > /dev/null

echo
echo "Secret updated."
echo

# Discover the deployed Lambda function names from the stack — works
# regardless of --env-suffix / custom STACK_NAME.
LAMBDA_NAMES_RAW="$(
  aws cloudformation list-stack-resources \
    --stack-name "${STACK_NAME}" \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" \
    --output text 2>/dev/null
)"
# Convert tab-separated to space-separated for shell expansion.
LAMBDA_NAMES="$(echo "${LAMBDA_NAMES_RAW}" | tr '\t' ' ')"
PROFILE_FOR_PRINT="${PROFILE:-<your-profile>}"

# Merge-bounce a single Lambda: read its existing env vars, set
# FORCE_REFRESH=<stamp> while preserving everything else, push,
# wait. This avoids the "REPLACES env var map" bug that drops
# Lambda-specific vars like PULL_LOCK_TABLE / AGENT_JOB_TABLE.
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
# Render as Variables={k=v,k=v,...} for AWS CLI shorthand.
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
echo "Re-run with --auto-bounce to bounce them automatically, or run"
echo "this snippet manually (preserves any custom Lambda env vars):"
echo
echo "  ./infra/set-secrets.sh --auto-bounce ${PROFILE:+--profile ${PROFILE}}${ENV_SUFFIX:+ --env-suffix ${ENV_SUFFIX}}"
echo
