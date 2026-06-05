#!/usr/bin/env bash
#
# Print the HubSpot Private App access token from the CRM stack's
# Secrets Manager blob to stdout. Used by other scripts (e.g. the
# AWS Products picklist seeder) to avoid hardcoding the token in
# command lines or environment variables that might land in shell
# history.
#
# Usage:
#   HUBSPOT_PRIVATE_APP_TOKEN="$(./scripts/get-hubspot-token.sh)" \
#     python3 scripts/seed-aws-products-picklist.py
#
# Configuration (env vars, all optional):
#   AWS_PROFILE   AWS CLI profile (default: AWS CLI default).
#   AWS_REGION    Target region (default: us-east-1).
#   STACK_NAME    CRM stack name (default: ace-share-refresh, or
#                 "ace-share-refresh-${ENV_SUFFIX}" when ENV_SUFFIX
#                 is set and STACK_NAME wasn't overridden explicitly).
#   ENV_SUFFIX    Environment suffix used at deploy time.
#   SECRET_ID     Override the resolved secret ID (default: looked up
#                 from the stack's SecretArn output).
#
# Exit codes:
#   0 — success; token printed to stdout.
#   1 — stack output / secret not found.
#   2 — token key absent from secret blob.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME_DEFAULT="ace-share-refresh"
STACK_NAME="${STACK_NAME:-${STACK_NAME_DEFAULT}}"
ENV_SUFFIX="${ENV_SUFFIX:-}"

if [[ -n "${ENV_SUFFIX}" && "${STACK_NAME}" == "${STACK_NAME_DEFAULT}" ]]; then
  STACK_NAME="${STACK_NAME_DEFAULT}-${ENV_SUFFIX}"
fi

SECRET_ID="${SECRET_ID:-}"
if [[ -z "${SECRET_ID}" ]]; then
  SECRET_ID="$(
    aws cloudformation describe-stacks \
      --stack-name "${STACK_NAME}" \
      --region "${REGION}" \
      --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" \
      --output text 2>/dev/null
  )"
  if [[ -z "${SECRET_ID}" || "${SECRET_ID}" == "None" ]]; then
    echo "ERROR: could not resolve SecretArn from stack '${STACK_NAME}' in ${REGION}" >&2
    echo "Set SECRET_ID env var to override, or check the stack name." >&2
    exit 1
  fi
fi

# Pull the secret value, parse JSON, extract the token without
# echoing it through any intermediate file.
TOKEN="$(
  aws secretsmanager get-secret-value \
    --secret-id "${SECRET_ID}" \
    --region "${REGION}" \
    --query SecretString \
    --output text \
  | python3 -c "
import json, sys
b = json.loads(sys.stdin.read())
v = b.get('HUBSPOT_PRIVATE_APP_TOKEN', '').strip()
if not v:
    sys.exit(2)
print(v)
"
)"
status=$?
if [[ "${status}" -ne 0 ]]; then
  echo "ERROR: HUBSPOT_PRIVATE_APP_TOKEN missing from secret blob ${SECRET_ID}" >&2
  echo "Run ./infra/set-secrets.sh HUBSPOT_PRIVATE_APP_TOKEN to populate it." >&2
  exit 2
fi

printf '%s' "${TOKEN}"
