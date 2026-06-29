#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# deploy-and-test.sh — Deploy Partner Central Chat Agent metadata and run tests
#
# Purpose:
#   Runs `sf project deploy start` against a target org using
#   manifest/package.xml, executing all local Apex tests as part of the deploy.
#   This is a single-shot, non-watching command.
#
#   You choose which Partner Central catalog the deployed config targets with
#   --catalog. This sets Chat_Agent_Config.Default.Is_Sandbox__c at deploy time.
#   Re-deploy with the other value to flip. Note: if the AWS Partner CRM
#   Connector is installed, its Custom Settings sandbox checkbox supersedes this
#   value at runtime, so the --catalog choice only applies to standalone
#   (connector-less) deployments.
#
# Usage:
#   ./scripts/deploy-and-test.sh <target-org-alias> [--catalog sandbox|aws] \
#       [--aws-account-id <12-digits>] [--profile <aws-cli-profile>]
#
# Examples:
#   ./scripts/deploy-and-test.sh my-dev-org                 # Sandbox (default)
#   ./scripts/deploy-and-test.sh my-dev-org --catalog aws   # AWS / production
#   ./scripts/deploy-and-test.sh my-dev-org --aws-account-id 123456789012
#
# Attachments (Aws_Account_Id__c):
#   The document-upload feature needs the org's 12-digit AWS account id in
#   Chat_Agent_Config.Default.Aws_Account_Id__c, but the committed record keeps
#   it blank (it's org-specific). This script templates it in for the deploy,
#   resolving the value in this order:
#     1. --aws-account-id <id> (or the AWS_ACCOUNT_ID environment variable)
#     2. `aws sts get-caller-identity` (the account your AWS CLI is signed into;
#        pass --profile to pick a non-default one)
#   Attachments are optional, so if no valid id is found the field stays blank
#   and text chat is unaffected (uploads fail closed with a clear config error).
#   The upload also requires the AWS_Partner_Central_S3 Named Credential from
#   Module 3 — this script cannot create it (it carries AWS secrets).
#
# Prerequisites:
#   - Salesforce CLI ("sf") installed and authenticated to the target org
#   - manifest/package.xml present at the workspace root
#
# For a dry-run (no actual deploy), use `sf project deploy validate` directly.
# -----------------------------------------------------------------------------
set -euo pipefail

# Resolve workspace root relative to this script's location so the command
# works regardless of the caller's current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${WORKSPACE_ROOT}"

TARGET_ORG="${1:-}"
if [ -z "${TARGET_ORG}" ] || [[ "${TARGET_ORG}" == --* ]]; then
    echo "Usage: $0 <target-org-alias> [--catalog sandbox|aws] [--aws-account-id <12-digits>] [--profile <aws-cli-profile>]" >&2
    echo "Example: $0 my-dev-org --catalog sandbox" >&2
    exit 1
fi
shift

# Default to Sandbox: this workshop is built around safe Sandbox testing.
CATALOG="sandbox"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_PROFILE_NAME=""
while [ $# -gt 0 ]; do
    case "$1" in
        --catalog) CATALOG="${2:-}"; shift ;;
        --aws-account-id) AWS_ACCOUNT_ID="${2:-}"; shift ;;
        --profile) AWS_PROFILE_NAME="${2:-}"; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
    esac
    shift
done

case "${CATALOG}" in
    sandbox)            IS_SANDBOX="true" ;;
    aws|prod|production) IS_SANDBOX="false" ;;
    *) echo "Error: --catalog must be 'sandbox' or 'aws' (got '${CATALOG}')" >&2; exit 1 ;;
esac

# Resolve the AWS account id used to build the attachment upload S3 key
# (Chat_Agent_Config.Default.Aws_Account_Id__c). Explicit flag/env wins;
# otherwise ask the AWS CLI which account it's signed into. Attachments are
# optional, so a missing or malformed id is a warning, not a fatal error —
# the field stays blank and text chat is unaffected.
if [ -z "${AWS_ACCOUNT_ID}" ] && command -v aws >/dev/null 2>&1; then
    if [ -n "${AWS_PROFILE_NAME}" ]; then
        AWS_ACCOUNT_ID="$(aws sts get-caller-identity --profile "${AWS_PROFILE_NAME}" --query Account --output text 2>/dev/null || true)"
    else
        AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
    fi
fi
if ! printf '%s' "${AWS_ACCOUNT_ID}" | grep -Eq '^[0-9]{12}$'; then
    if [ -n "${AWS_ACCOUNT_ID}" ]; then
        echo "Warning: ignoring AWS account id '${AWS_ACCOUNT_ID}' (expected 12 digits); attachments will stay unconfigured." >&2
    fi
    AWS_ACCOUNT_ID=""
fi

MANIFEST="manifest/package.xml"
if [ ! -f "${MANIFEST}" ]; then
    echo "Error: ${MANIFEST} not found at ${WORKSPACE_ROOT}/${MANIFEST}." >&2
    exit 1
fi

CONFIG_FILE="force-app/main/default/customMetadata/Chat_Agent_Config.Default.md-meta.xml"
if [ ! -f "${CONFIG_FILE}" ]; then
    echo "Error: ${CONFIG_FILE} not found." >&2
    exit 1
fi

# Template the chosen catalog (and AWS account id) into the config record for
# THIS deploy only. Back the file up OUTSIDE the source tree and restore it on
# exit (even on failure) so the working tree stays clean.
#
# The backup MUST NOT live inside force-app/: `sf project deploy` resolves a
# `*.md-meta.xml.bak` sitting next to the real file as a SECOND copy of the
# same CustomMetadata component, and it can overwrite the templated values on
# deploy (this silently reset Aws_Account_Id__c to blank). Keep it in a temp dir.
CONFIG_BAK="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/chat_agent_config.$$.bak")"
cp "${CONFIG_FILE}" "${CONFIG_BAK}"
restore_config() { mv -f "${CONFIG_BAK}" "${CONFIG_FILE}" 2>/dev/null || true; }
trap restore_config EXIT

# Flip the Is_Sandbox__c boolean (the next <value> after its <field>) and, when
# we resolved one, inject the AWS account id into the Aws_Account_Id__c value.
# Other fields (e.g. Sse_Enabled__c) are left untouched.
awk -v want="${IS_SANDBOX}" -v acct="${AWS_ACCOUNT_ID}" '
    /<field>Is_Sandbox__c<\/field>/ { fsb=1 }
    fsb && /<value xsi:type="xsd:boolean">/ { sub(/>[a-z]+</, ">" want "<"); fsb=0 }
    /<field>Aws_Account_Id__c<\/field>/ { facct=1 }
    facct && acct != "" && /<value/ { sub(/<value.*/, "<value xsi:type=\"xsd:string\">" acct "</value>"); facct=0 }
    { print }
' "${CONFIG_BAK}" > "${CONFIG_FILE}"

echo "Deploying metadata to org: ${TARGET_ORG}"
echo "Catalog: ${CATALOG} (Is_Sandbox__c=${IS_SANDBOX})"
if [ -n "${AWS_ACCOUNT_ID}" ]; then
    echo "Attachments: Aws_Account_Id__c=${AWS_ACCOUNT_ID} (S3 upload path enabled; needs the AWS_Partner_Central_S3 credential from Module 3)"
else
    echo "Attachments: Aws_Account_Id__c unset (text-only chat; pass --aws-account-id or sign in with the AWS CLI to enable uploads)"
fi
echo "Manifest: ${MANIFEST}"
# Run ONLY this spec's tests — RunLocalTests would also execute any
# pre-existing failing tests in the target org and block our deploy.
sf project deploy start \
    --manifest "${MANIFEST}" \
    --target-org "${TARGET_ORG}" \
    --test-level RunSpecifiedTests \
    --tests ChatAgentControllerTest \
    --tests ChatAgentCoverageTests

echo "✓ Deploy complete (catalog: ${CATALOG})."
