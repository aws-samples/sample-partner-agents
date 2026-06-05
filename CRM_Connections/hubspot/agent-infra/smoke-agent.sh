#!/usr/bin/env bash
#
# End-to-end smoke test for the Agent Lambda + MCP integration.
#
# Exercises a single text → response round-trip against the deployed
# Agent API Gateway URL. Useful as a post-deploy gate before testing
# through the HubSpot card.
#
# What this does NOT cover:
#   - HubSpot v3 signature verification (this script bypasses signing
#     by going through the API directly with a fixed timestamp; for
#     true end-to-end auth, click the card in HubSpot).
#   - Approval round-trip (text → requires_approval → approve → complete).
#     The agent server's behaviour for that flow depends on having a
#     real Sandbox opportunity to act on.
#
# Configuration (env vars):
#   API_URL              Required. The deployed `ApiUrl` from the stack.
#                        e.g. https://abc123.execute-api.us-east-1.amazonaws.com
#   HUBSPOT_CLIENT_SECRET Required. Same value pushed via set-secrets.sh.
#                        Used to compute a valid v3 HMAC signature.
#
# Usage:
#   API_URL=https://...amazonaws.com \
#   HUBSPOT_CLIENT_SECRET=... \
#     ./agent-infra/smoke-agent.sh
#
# Exits 0 on PASS, 1 on FAIL.

set -euo pipefail

if [[ -z "${API_URL:-}" ]]; then
  echo "ERROR: API_URL not set." >&2
  exit 2
fi
if [[ -z "${HUBSPOT_CLIENT_SECRET:-}" ]]; then
  echo "ERROR: HUBSPOT_CLIENT_SECRET not set." >&2
  exit 2
fi

URL_PATH="/agent"
FULL_URL="${API_URL}${URL_PATH}"
HOST="${API_URL#https://}"
TIMESTAMP="$(($(date +%s) * 1000))"
BODY='{"dealId":1,"message":{"type":"text","text":"Smoke test — list one open opportunity."}}'

# Compute the v3 signature: HMAC-SHA256(clientSecret) over (method + url + body + timestamp), base64.
SIG="$(
  printf '%s' "POST${FULL_URL}${BODY}${TIMESTAMP}" \
    | openssl dgst -sha256 -hmac "${HUBSPOT_CLIENT_SECRET}" -binary \
    | base64
)"

echo "POST ${FULL_URL}"
echo "Body: ${BODY}"
echo

HTTP_RESP="$(
  curl -sS -X POST "${FULL_URL}" \
    -H "content-type: application/json" \
    -H "x-hubspot-signature-v3: ${SIG}" \
    -H "x-hubspot-request-timestamp: ${TIMESTAMP}" \
    -d "${BODY}" \
    -w "\nHTTP_STATUS:%{http_code}"
)"

STATUS="${HTTP_RESP##*HTTP_STATUS:}"
BODY_RESP="${HTTP_RESP%HTTP_STATUS:*}"

echo "Response status: ${STATUS}"
echo "Response body:"
echo "${BODY_RESP}" | python3 -m json.tool 2>/dev/null || echo "${BODY_RESP}"
echo

if [[ "${STATUS}" == "200" ]]; then
  echo "PASS — agent responded successfully."
  exit 0
fi

echo "FAIL — expected 200, got ${STATUS}." >&2
exit 1
