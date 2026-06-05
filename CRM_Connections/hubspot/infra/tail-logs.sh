#!/usr/bin/env bash
#
# Tail one or all of the ACE Share / Refresh Lambda log groups.
#
# Usage:
#   ./infra/tail-logs.sh share                        # only Share
#   ./infra/tail-logs.sh refresh                      # only Refresh
#   ./infra/tail-logs.sh submit                       # only Submit
#   ./infra/tail-logs.sh pull                         # only Pull (EventBridge)
#   ./infra/tail-logs.sh all                          # all four in parallel
#   ./infra/tail-logs.sh share --profile other-prof   # use a different profile
#   ./infra/tail-logs.sh share --env-suffix dev       # target the suffixed stack
#
# Configuration (env vars, all optional):
#   AWS_PROFILE   AWS CLI profile. Overridden by --profile if both are set.
#   AWS_REGION    Target region. Defaults to "us-east-1".
#   ENV_SUFFIX    Environment suffix used at deploy time. Equivalent to
#                 passing --env-suffix. Log group names are suffixed by
#                 the deploy when ENV_SUFFIX is set; this script honors
#                 the same convention.

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

# Parse args.
TARGET=""
PROFILE_OVERRIDE=""
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
    share|refresh|submit|pull|all)
      TARGET="$1"
      shift
      ;;
    -h|--help)
      sed -n '3,21p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "usage: $0 {share|refresh|submit|pull|all} [--profile <name>] [--env-suffix <name>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${TARGET}" ]]; then
  echo "usage: $0 {share|refresh|submit|pull|all} [--profile <name>] [--env-suffix <name>]" >&2
  exit 2
fi

PROFILE="${PROFILE_OVERRIDE:-${AWS_PROFILE:-}}"
PROFILE_ARGS=()
if [[ -n "${PROFILE}" ]]; then
  PROFILE_ARGS+=(--profile "${PROFILE}")
fi

# Apply suffix to the canonical log group base names.
suffix=""
if [[ -n "${ENV_SUFFIX}" ]]; then
  suffix="-${ENV_SUFFIX}"
fi

case "${TARGET}" in
  share)    groups=("/aws/lambda/ace-share-ShareLambda${suffix}") ;;
  refresh)  groups=("/aws/lambda/ace-share-RefreshLambda${suffix}") ;;
  submit)   groups=("/aws/lambda/ace-share-SubmitLambda${suffix}") ;;
  pull)     groups=("/aws/lambda/ace-share-PullLambda${suffix}") ;;
  all)
    groups=(
      "/aws/lambda/ace-share-ShareLambda${suffix}"
      "/aws/lambda/ace-share-RefreshLambda${suffix}"
      "/aws/lambda/ace-share-SubmitLambda${suffix}"
      "/aws/lambda/ace-share-PullLambda${suffix}"
    )
    ;;
esac

# Tail each log group in the background so "all" works. The parent process
# waits for SIGINT; Ctrl-C cleans up the children via the trap.
pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for lg in "${groups[@]}"; do
  aws logs tail "${lg}" --follow --format short \
    ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} \
    --region "${REGION}" &
  pids+=($!)
done

wait
