#!/usr/bin/env bash
#
# Tail Agent stack Lambda log groups.
#
# Usage:
#   ./agent-infra/tail-logs.sh                              # async lambda (primary path)
#   ./agent-infra/tail-logs.sh sync                         # synchronous lambda (legacy /agent route)
#   ./agent-infra/tail-logs.sh async                        # async lambda (start/poll/worker)
#   ./agent-infra/tail-logs.sh all                          # both in parallel (Ctrl-C to stop)
#   ./agent-infra/tail-logs.sh async --profile other-prof   # any subcommand accepts --profile
#   ./agent-infra/tail-logs.sh async --env-suffix dev       # target the suffixed stack
#
# Configuration (env vars, all optional):
#   AWS_PROFILE   AWS CLI profile. Overridden by --profile if both are set.
#   AWS_REGION    Target region. Defaults to "us-east-1".
#   ENV_SUFFIX    Environment suffix used at deploy time. Equivalent to
#                 passing --env-suffix.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ENV_SUFFIX="${ENV_SUFFIX:-}"

validate_env_suffix() {
  local s="$1"
  if [[ ! "${s}" =~ ^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$ ]]; then
    echo "ERROR: --env-suffix '${s}' is invalid." >&2
    echo "Allowed: lowercase letters/digits/hyphens, max 16 chars," >&2
    echo "must start and end with a letter or digit (e.g. dev, prod-1)." >&2
    exit 2
  fi
}

# First positional arg is the subcommand. Default to `async` because
# that's the path the card actually uses for every Send / Approve /
# bulk-import action.
TARGET="async"
PROFILE_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    sync|async|all)
      TARGET="$1"
      shift
      ;;
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
    -h|--help)
      sed -n '3,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "usage: $0 [sync|async|all] [--profile <name>] [--env-suffix <name>]" >&2
      exit 2
      ;;
  esac
done

PROFILE="${PROFILE_OVERRIDE:-${AWS_PROFILE:-}}"
PROFILE_ARGS=()
if [[ -n "${PROFILE}" ]]; then
  PROFILE_ARGS+=(--profile "${PROFILE}")
fi

suffix=""
if [[ -n "${ENV_SUFFIX}" ]]; then
  suffix="-${ENV_SUFFIX}"
fi

SYNC_GROUP="/aws/lambda/ace-agent-AgentLambda${suffix}"
ASYNC_GROUP="/aws/lambda/ace-agent-AgentAsyncLambda${suffix}"

tail_one() {
  local group="$1"
  aws logs tail "${group}" \
    --follow --format short \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}"
}

case "${TARGET}" in
  sync)
    tail_one "${SYNC_GROUP}"
    ;;
  async)
    tail_one "${ASYNC_GROUP}"
    ;;
  all)
    # Trap so Ctrl-C kills both child processes cleanly.
    trap 'kill 0' SIGINT SIGTERM EXIT
    tail_one "${SYNC_GROUP}" &
    tail_one "${ASYNC_GROUP}" &
    wait
    ;;
esac
