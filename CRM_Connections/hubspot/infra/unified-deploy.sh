#!/usr/bin/env bash
#
# Unified deploy script — wraps `infra/deploy.sh` (CRM stack) and
# `agent-infra/deploy.sh` (Agent stack) so partners can pick a
# deployment mode with a single flag instead of running two scripts.
#
# Modes:
#   crm          deploy ONLY the bidirectional CRM sync (Share /
#                Submit / Refresh / Pull lambdas + the AceShareCard).
#   agent        deploy ONLY the conversational AI agent (Agent
#                lambda + the AgentCard).
#   crm-and-agent  deploy BOTH stacks in the same AWS account /
#                  region. Each stack remains independent — separate
#                  CloudFormation stacks, separate Secrets Manager
#                  blobs, separate IAM roles.
#
# Usage:
#   ./infra/unified-deploy.sh --mode crm
#   ./infra/unified-deploy.sh --mode agent --profile my-aws-profile
#   ./infra/unified-deploy.sh --mode crm-and-agent --skip-build -y
#   ./infra/unified-deploy.sh --mode crm-and-agent --env-suffix dev
#   AWS_PROFILE=foo AWS_REGION=us-east-1 ./infra/unified-deploy.sh --mode crm
#
# Environment variables (all optional):
#   AWS_PROFILE   AWS CLI profile (default: AWS CLI default).
#                 Equivalent to passing --profile.
#   AWS_REGION    Target region (default: us-east-1).
#                 Equivalent to passing --region.
#   STACK_NAME_CRM    CRM stack name (default: ace-share-refresh).
#                     Forwarded to the underlying script as STACK_NAME.
#   STACK_NAME_AGENT  Agent stack name (default: ace-agent).
#                     Forwarded to the underlying script as STACK_NAME.
#
# Flags:
#   --mode <crm|agent|crm-and-agent>  Required. Selects the deploy
#                                     mode.
#   --profile <name>  AWS CLI profile to use. Sets AWS_PROFILE in the
#                     environment for both this script and the
#                     underlying deploy scripts.
#   --region <name>   AWS region to deploy to. Sets AWS_REGION.
#                     Defaults to us-east-1.
#   --env-suffix <name>  Append <name> to globally-scoped resource
#                        names (Lambdas, IAM roles, DynamoDB tables,
#                        log groups, Secrets Manager secrets, stack
#                        names) so dev and prod can coexist in one
#                        AWS account. Lowercase, digits, hyphens; max
#                        16 chars.
#   --skip-build  Use existing dist/*.zip bundles in each backend.
#                 Forwarded to both underlying scripts.
#   -y, --yes     Skip the per-stack confirmation prompt.
#                 Forwarded to both underlying scripts.
#   -h, --help    Show this help.

set -euo pipefail

MODE=""
SKIP_BUILD=false
AUTO_YES=false

# Validate --env-suffix value: lowercase letters, digits, hyphens only,
# max 16 chars, must NOT start or end with a hyphen. Catches the common
# `--env-suffix -dev` typo (leading dash) which silently produces
# "ace-share-refresh--dev" / "ace-agent--dev" — the doubled dash
# breaks every "find me by canonical name" downstream command.
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
    --mode)
      MODE="${2:-}"
      if [[ -z "${MODE}" ]]; then
        echo "ERROR: --mode requires a value" >&2
        exit 2
      fi
      shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      shift
      ;;
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
    --region|--region=*)
      if [[ "$1" == --region=* ]]; then
        export AWS_REGION="${1#--region=}"
        shift
      else
        if [[ -z "${2:-}" ]]; then
          echo "ERROR: --region requires a value" >&2
          exit 2
        fi
        export AWS_REGION="$2"
        shift 2
      fi
      ;;
    --env-suffix)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --env-suffix requires a value" >&2
        exit 2
      fi
      export ENV_SUFFIX="$2"
      validate_env_suffix "${ENV_SUFFIX}"
      shift 2
      ;;
    --env-suffix=*)
      export ENV_SUFFIX="${1#--env-suffix=}"
      validate_env_suffix "${ENV_SUFFIX}"
      shift
      ;;
    --skip-build)  SKIP_BUILD=true; shift ;;
    -y|--yes)      AUTO_YES=true; shift ;;
    -h|--help)
      sed -n '3,53p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

case "${MODE}" in
  crm|agent|crm-and-agent) ;;
  "")
    echo "ERROR: --mode is required (one of: crm, agent, crm-and-agent)" >&2
    exit 2
    ;;
  *)
    echo "ERROR: unknown mode '${MODE}'. Pick one of: crm, agent, crm-and-agent" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Translate optional --flags into env / per-script flags so the
# downstream invocations behave the same.
PER_SCRIPT_ARGS=()
if "${AUTO_YES}"; then
  PER_SCRIPT_ARGS+=("-y")
fi
if "${SKIP_BUILD}"; then
  PER_SCRIPT_ARGS+=("--skip-build")
fi

echo "=== Unified deploy ==="
echo "Mode:        ${MODE}"
echo "AWS profile: ${AWS_PROFILE:-<default>}"
echo "AWS region:  ${AWS_REGION:-us-east-1}"
echo "Env suffix:  ${ENV_SUFFIX:-<none>}"
echo

deploy_crm() {
  echo
  echo "=== Deploying CRM stack ==="
  STACK_NAME="${STACK_NAME_CRM:-ace-share-refresh}" \
    "${REPO_ROOT}/infra/deploy.sh" "${PER_SCRIPT_ARGS[@]+"${PER_SCRIPT_ARGS[@]}"}"
}

deploy_agent() {
  echo
  echo "=== Deploying Agent stack ==="
  STACK_NAME="${STACK_NAME_AGENT:-ace-agent}" \
    "${REPO_ROOT}/agent-infra/deploy.sh" "${PER_SCRIPT_ARGS[@]+"${PER_SCRIPT_ARGS[@]}"}"
}

case "${MODE}" in
  crm)             deploy_crm ;;
  agent)           deploy_agent ;;
  crm-and-agent)
    deploy_crm
    deploy_agent
    ;;
esac

echo
echo "=== Unified deploy complete (${MODE}) ==="
echo

# Build flag suffixes so next-steps hints are copy-paste correct.
_PROFILE_HINT="${AWS_PROFILE:+ --profile ${AWS_PROFILE}}"
_SUFFIX_HINT="${ENV_SUFFIX:+ --env-suffix ${ENV_SUFFIX}}"

case "${MODE}" in
  crm|crm-and-agent)
    echo "CRM next steps (in this order):"
    echo "  1. cd hubspot-card && hs project upload   # creates + installs the app"
    echo "  2. In HubSpot: install the app, capture its Access token + Client secret"
    echo "  3. ./infra/set-secrets.sh --auto-bounce${_PROFILE_HINT}${_SUFFIX_HINT}   # paste those + the ACE keys"
    echo "  4. ./scripts/setup-hubspot-properties.sh  # provision deal properties"
    echo
    ;;
esac
case "${MODE}" in
  agent|crm-and-agent)
    echo "Agent next steps (in this order):"
    echo "  1. cd agent-card && hs project upload     # creates + installs the app"
    echo "  2. In HubSpot: install the app, copy its Client secret (Auth tab)"
    echo "  3. ./agent-infra/set-secrets.sh --auto-bounce${_PROFILE_HINT}${_SUFFIX_HINT}   # paste that secret"
    echo
    ;;
esac
