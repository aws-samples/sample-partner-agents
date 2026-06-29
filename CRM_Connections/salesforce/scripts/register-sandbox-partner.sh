#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# register-sandbox-partner.sh — Ensure a working sandbox partner for MCP testing.
#
# Purpose:
#   Makes sure the caller's AWS account can use the Partner Central *Sandbox*
#   catalog so the chat agent can exercise read and write paths (list, update,
#   submit, etc.) without touching production partner data.
#
#   The script is "ensure" shaped: it confirms first, and only registers if it
#   has to. On every run it:
#     1. Verifies AWS credentials (sts get-caller-identity).
#     2. Looks for an existing sandbox partner (partnercentral-account:ListPartners).
#     3. Registers one if none exists (CreatePartner + StartProfileUpdateTask).
#     4. Verifies real Sandbox access by calling the Selling API
#        (partnercentral-selling:ListOpportunities --catalog Sandbox) and
#        reports the outcome. The script's exit code reflects that check.
#
#   Implements the flow documented at:
#     https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html
#
# Why the Selling-API check matters:
#   Creating a partner and completing its profile is necessary but not always
#   sufficient. The Selling API gates every call (even read-only ones) on the
#   account having an active AWS Partner benefit in the Sandbox catalog. If that
#   benefit state is missing you get AccessDeniedException with reason
#   INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE, which registration alone cannot fix
#   (it is resolved by AWS Partner Central support). This script tells those
#   cases apart instead of reporting a false success.
#
# Prerequisites:
#   - AWS CLI v2 installed and authenticated (profile or default credentials).
#   - The calling IAM identity can reach the Sandbox catalog. Actions used here:
#       partnercentral:ListPartners, CreatePartner, StartProfileUpdateTask,
#       ListOpportunities  — all scoped to Catalog=Sandbox.
#   - Region: Partner Central APIs used here live in us-east-1.
#
# Usage:
#   ./scripts/register-sandbox-partner.sh [options]
#
#   Modes:
#     (default)                       Ensure: confirm, and register only if needed.
#     --check                         Confirm only. Never registers. Exit code
#                                     reflects whether Sandbox access works.
#
#   Required only when registration is actually needed (no partner exists yet):
#     --legal-name         <name>     Unique legal name (1-80 chars)
#     --first-name         <name>     Alliance lead first name
#     --last-name          <name>     Alliance lead last name
#     --email              <addr>     Alliance lead email
#     --business-title     <title>    Alliance lead job title
#
#   Optional:
#     --solution-type      <enum>     PrimarySolutionType, default SOFTWARE_PRODUCTS
#     --verification-code  <6-digit>  Email verification code, default 123456
#                                     (sandbox accepts any six digits)
#     --display-name       <name>     Public display name. Defaults to --legal-name
#     --description        <text>     Partner description (1-600 chars)
#     --website-url        <url>      HTTPS website URL
#     --logo-url           <url>      HTTPS logo URL (must be a downloadable image)
#     --industry-segment   <enum>     Industry segment (repeatable, max 3)
#                                     Default: SOFTWARE_INTERNET
#     --locale             <xx-XX>    TranslationSourceLocale, default en-US
#     --partner-id         <id>       Run the profile update against an existing
#                                     sandbox partner (skips CreatePartner)
#     --force-register                Register even if a partner already exists
#     --profile            <name>     AWS CLI profile
#     --region             <region>   Default us-east-1
#     --skip-profile-update           Skip the StartProfileUpdateTask call
#     --skip-verify                   Skip the Selling-API access check
#     -h | --help                     Print usage
#
#   All required flags can also be supplied via env vars:
#     LEGAL_NAME, FIRST_NAME, LAST_NAME, EMAIL, BUSINESS_TITLE
#
# Examples:
#   # Confirm whether this account can already use the Sandbox catalog:
#   ./scripts/register-sandbox-partner.sh --check
#
#   # Ensure a partner exists, registering with these details if not:
#   ./scripts/register-sandbox-partner.sh \
#     --legal-name "Acme Cloud Sandbox" \
#     --first-name "Ada" --last-name "Lovelace" \
#     --email "ada@example.com" --business-title "Alliance Lead"
#
# Exit codes:
#   0  Sandbox access confirmed (Selling API reachable), or registration done
#      and verified. With --skip-verify, 0 means the registration calls ran.
#   3  Partner exists/created but Sandbox benefit is not active
#      (INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE). Contact AWS Partner Central.
#   4  Access denied for a different reason (likely missing IAM permission).
#   5  Unexpected error during the access check.
#   1  Usage or registration error.
# -----------------------------------------------------------------------------
set -euo pipefail

# -------- defaults ----------------------------------------------------------
SOLUTION_TYPE="${SOLUTION_TYPE:-SOFTWARE_PRODUCTS}"
VERIFICATION_CODE="${VERIFICATION_CODE:-123456}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE=""
SKIP_PROFILE_UPDATE=0
CHECK_ONLY=0
SKIP_VERIFY=0
FORCE_REGISTER=0
LEGAL_NAME="${LEGAL_NAME:-}"
FIRST_NAME="${FIRST_NAME:-}"
LAST_NAME="${LAST_NAME:-}"
EMAIL="${EMAIL:-}"
BUSINESS_TITLE="${BUSINESS_TITLE:-}"

# Profile fields for StartProfileUpdateTask (all required by that API).
DISPLAY_NAME="${DISPLAY_NAME:-}"
DESCRIPTION="${DESCRIPTION:-Sandbox partner created for MCP chat agent integration testing.}"
WEBSITE_URL="${WEBSITE_URL:-https://example.com}"
# StartProfileUpdateTask downloads the logo and rejects unreachable URLs with
# INVALID_LOGO_URL. https://example.com/logo.png returns a 404 page, not an
# image, so the default must point at a real, downloadable PNG. Override with
# --logo-url for a branded logo.
LOGO_URL="${LOGO_URL:-https://placehold.co/400x400.png}"
LOCALE="${LOCALE:-en-US}"
INDUSTRY_SEGMENTS=()        # populated via --industry-segment or defaulted below
PARTNER_ID="${PARTNER_ID:-}"

VALID_SOLUTION_TYPES=(
    SOFTWARE_PRODUCTS
    CONSULTING_SERVICES
    PROFESSIONAL_SERVICES
    MANAGED_SERVICES
    HARDWARE_PRODUCTS
    COMMUNICATION_SERVICES
    VALUE_ADDED_RESALE_AWS_SERVICES
    TRAINING_SERVICES
)

usage() {
    sed -n '2,/^# ----*$/p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# -------- arg parsing -------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --legal-name)        LEGAL_NAME="$2"; shift 2 ;;
        --first-name)        FIRST_NAME="$2"; shift 2 ;;
        --last-name)         LAST_NAME="$2"; shift 2 ;;
        --email)             EMAIL="$2"; shift 2 ;;
        --business-title)    BUSINESS_TITLE="$2"; shift 2 ;;
        --solution-type)     SOLUTION_TYPE="$2"; shift 2 ;;
        --verification-code) VERIFICATION_CODE="$2"; shift 2 ;;
        --display-name)      DISPLAY_NAME="$2"; shift 2 ;;
        --description)       DESCRIPTION="$2"; shift 2 ;;
        --website-url)       WEBSITE_URL="$2"; shift 2 ;;
        --logo-url)          LOGO_URL="$2"; shift 2 ;;
        --industry-segment)  INDUSTRY_SEGMENTS+=("$2"); shift 2 ;;
        --locale)            LOCALE="$2"; shift 2 ;;
        --partner-id)        PARTNER_ID="$2"; shift 2 ;;
        --force-register)    FORCE_REGISTER=1; shift ;;
        --profile)           PROFILE="$2"; shift 2 ;;
        --region)            REGION="$2"; shift 2 ;;
        --skip-profile-update) SKIP_PROFILE_UPDATE=1; shift ;;
        --check)             CHECK_ONLY=1; shift ;;
        --skip-verify)       SKIP_VERIFY=1; shift ;;
        -h|--help)           usage 0 ;;
        *) echo "Unknown option: $1" >&2; usage 1 ;;
    esac
done

# Apply defaults that depend on other flags.
[ "${#INDUSTRY_SEGMENTS[@]}" -eq 0 ] && INDUSTRY_SEGMENTS=("SOFTWARE_INTERNET")
[ -z "${DISPLAY_NAME}" ] && DISPLAY_NAME="${LEGAL_NAME}"

# -------- static validation -------------------------------------------------
# solution type enum
valid=0
for t in "${VALID_SOLUTION_TYPES[@]}"; do
    [ "${t}" = "${SOLUTION_TYPE}" ] && { valid=1; break; }
done
if [ "${valid}" -ne 1 ]; then
    echo "Error: invalid --solution-type '${SOLUTION_TYPE}'." >&2
    echo "Allowed: ${VALID_SOLUTION_TYPES[*]}" >&2
    exit 1
fi

# verification code: sandbox accepts any six digits
if ! [[ "${VERIFICATION_CODE}" =~ ^[0-9]{6}$ ]]; then
    echo "Error: --verification-code must be exactly six digits." >&2
    exit 1
fi

# aws cli presence
if ! command -v aws >/dev/null 2>&1; then
    echo "Error: aws CLI not found on PATH." >&2
    exit 1
fi

# -------- helpers -----------------------------------------------------------
aws_args=(--region "${REGION}" --output json)
[ -n "${PROFILE}" ] && aws_args+=(--profile "${PROFILE}")

log()  { printf '› %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

require_registration_flags() {
    local missing=()
    [ -z "${LEGAL_NAME}" ]     && missing+=("--legal-name")
    [ -z "${FIRST_NAME}" ]     && missing+=("--first-name")
    [ -z "${LAST_NAME}" ]      && missing+=("--last-name")
    [ -z "${EMAIL}" ]          && missing+=("--email")
    [ -z "${BUSINESS_TITLE}" ] && missing+=("--business-title")
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Error: registration is needed but these flags are missing: ${missing[*]}" >&2
        echo "Run with --help for usage, or --check to only confirm access." >&2
        exit 1
    fi
}

# Echo the id of the first existing sandbox partner, or nothing.
detect_partner_id() {
    aws partnercentral-account list-partners "${aws_args[@]}" --catalog Sandbox 2>/dev/null \
        | awk -F'"' '/"Id"/ {print $4; exit}' || true
}

# Confirm the Sandbox Selling API actually works for this caller.
# Returns 0 on success, 3 benefit-state, 4 access-denied, 5 other error.
verify_sandbox_access() {
    local out
    log "Verifying Sandbox access (partnercentral-selling:ListOpportunities)..."
    if out="$(aws partnercentral-selling list-opportunities "${aws_args[@]}" \
                --catalog Sandbox --max-results 1 2>&1)"; then
        ok "Sandbox access confirmed. The Selling API responded for Catalog=Sandbox."
        return 0
    fi
    if printf '%s' "${out}" | grep -q "INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE"; then
        warn "Sandbox partner exists, but the account has no ACTIVE AWS Partner benefit in Sandbox."
        warn "The Selling API rejected the call with INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE."
        warn "Registration cannot clear this. It is a Partner Central benefit-state issue:"
        warn "  - Open a case with AWS Partner Central support to activate the Sandbox benefit, or"
        warn "  - use the AWS (production) catalog if this account is a live partner there"
        warn "    (deploy with: ./scripts/deploy-and-test.sh <org-alias> --catalog aws)."
        return 3
    fi
    if printf '%s' "${out}" | grep -qiE "AccessDenied|not authorized|UnauthorizedException"; then
        warn "Access denied by IAM (no INCOMPATIBLE_BENEFIT reason returned)."
        warn "The signing identity is missing partnercentral:ListOpportunities for Catalog=Sandbox."
        warn "Attach AWSPartnerCentralOpportunityManagement (and the Sandbox access policy) and retry."
        warn "Raw error: ${out}"
        return 4
    fi
    warn "Unexpected error while verifying Sandbox access:"
    warn "${out}"
    return 5
}

# -------- preflight: who am I? ---------------------------------------------
log "Verifying AWS credentials..."
caller_json="$(aws sts get-caller-identity "${aws_args[@]}" 2>&1)" \
    || fail "sts:GetCallerIdentity failed: ${caller_json}"
account_id="$(printf '%s' "${caller_json}" | awk -F'"' '/"Account"/ {print $4}')"
arn="$(printf '%s' "${caller_json}"        | awk -F'"' '/"Arn"/     {print $4}')"
ok "Account ${account_id} — ${arn}"

# -------- check-only mode ---------------------------------------------------
# Confirm whether this account can already use the Sandbox catalog, and stop.
if [ "${CHECK_ONLY}" -eq 1 ]; then
    existing="$(detect_partner_id)"
    if [ -n "${existing}" ]; then
        ok "Sandbox partner registered: ${existing}"
    else
        warn "No sandbox partner is registered for account ${account_id}."
        warn "Run this script without --check (and with --legal-name etc.) to register one."
    fi
    verify_sandbox_access
    exit $?
fi

# -------- decide: register or reuse ----------------------------------------
partner_arn=""
if [ -n "${PARTNER_ID}" ]; then
    log "Using supplied partner id ${PARTNER_ID} (skipping CreatePartner)."
    partner_id="${PARTNER_ID}"
elif [ "${FORCE_REGISTER}" -eq 0 ] && partner_id="$(detect_partner_id)" && [ -n "${partner_id}" ]; then
    ok "Sandbox partner already registered: ${partner_id}. Skipping CreatePartner."
    # Leave the existing profile alone unless the caller forces a refresh.
    SKIP_PROFILE_UPDATE=1
else
    # No partner (or --force-register): we must create one, which needs details.
    require_registration_flags
    client_token="sandbox-$(date +%s)-$RANDOM"
    contact_json=$(cat <<JSON
{"FirstName":"${FIRST_NAME}","LastName":"${LAST_NAME}","Email":"${EMAIL}","BusinessTitle":"${BUSINESS_TITLE}"}
JSON
)

    log "Calling partnercentral-account:CreatePartner (Catalog=Sandbox)..."
    create_out="$(aws partnercentral-account create-partner \
        "${aws_args[@]}" \
        --catalog Sandbox \
        --client-token "${client_token}" \
        --legal-name "${LEGAL_NAME}" \
        --primary-solution-type "${SOLUTION_TYPE}" \
        --alliance-lead-contact "${contact_json}" \
        --email-verification-code "${VERIFICATION_CODE}" 2>&1)" \
        || fail "CreatePartner failed: ${create_out}"

    partner_id="$(printf '%s' "${create_out}" | awk -F'"' '/"Id"/ {print $4; exit}')"
    partner_arn="$(printf '%s' "${create_out}" | awk -F'"' '/"Arn"/ {print $4; exit}')"
    ok "Created sandbox partner ${partner_id}"
    [ -n "${partner_arn}" ] && printf '  ARN: %s\n' "${partner_arn}"
fi

# -------- StartProfileUpdateTask -------------------------------------------
# Required per https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html
# and per https://docs.aws.amazon.com/partner-central/latest/APIReference/working-with-partner-profile.html
# (display name, description, website, logo, industry segments, etc. are all
# required by this API — they complete the public partner profile).
if [ "${SKIP_PROFILE_UPDATE}" -eq 1 ]; then
    log "Skipping StartProfileUpdateTask."
else
    task_client_token="sandbox-profile-$(date +%s)-$RANDOM"

    # Build JSON array of industry segments: ["A","B"]
    segs_json='['
    first=1
    for s in "${INDUSTRY_SEGMENTS[@]}"; do
        [ "${first}" -eq 1 ] || segs_json+=','
        segs_json+="\"${s}\""
        first=0
    done
    segs_json+=']'

    task_details_json=$(cat <<JSON
{"DisplayName":"${DISPLAY_NAME}","Description":"${DESCRIPTION}","WebsiteUrl":"${WEBSITE_URL}","LogoUrl":"${LOGO_URL}","PrimarySolutionType":"${SOLUTION_TYPE}","IndustrySegments":${segs_json},"TranslationSourceLocale":"${LOCALE}"}
JSON
)

    log "Calling partnercentral-account:StartProfileUpdateTask..."
    task_out="$(aws partnercentral-account start-profile-update-task \
        "${aws_args[@]}" \
        --catalog Sandbox \
        --identifier "${partner_id}" \
        --client-token "${task_client_token}" \
        --task-details "${task_details_json}" 2>&1)" \
        || fail "StartProfileUpdateTask failed: ${task_out}"
    task_id="$(printf '%s' "${task_out}" | awk -F'"' '/"TaskId"/ {print $4; exit}')"
    ok "Profile update task started${task_id:+: ${task_id}}"
fi

# -------- summary -----------------------------------------------------------
cat <<EOF

Sandbox partner registration step complete.

  Partner Id:      ${partner_id}
  Catalog:         Sandbox
  Legal Name:      ${LEGAL_NAME:-<unchanged>}
  Alliance Lead:   ${FIRST_NAME:-<unchanged>} ${LAST_NAME:-} <${EMAIL:-unchanged}>
  Solution Type:   ${SOLUTION_TYPE}
  Display Name:    ${DISPLAY_NAME}
  Industry Segs:   ${INDUSTRY_SEGMENTS[*]}
EOF

# -------- verify ------------------------------------------------------------
if [ "${SKIP_VERIFY}" -eq 1 ]; then
    echo
    log "Skipping the Sandbox access check (--skip-verify)."
    log "Confirm later with: ./scripts/register-sandbox-partner.sh --check"
    exit 0
fi

echo
verify_sandbox_access
verify_rc=$?

echo
if [ "${verify_rc}" -eq 0 ]; then
    cat <<EOF
Next steps:
  1. (Connector path) Confirm sandbox mode in Salesforce:
     Setup → Custom Settings → AWS Partner CRM Connector Settings →
     awsapn__PC_API_Sandbox_Enabled__c = true
  2. Run the smoke test against sandbox:
     ./scripts/smoke/smoke-test.sh <org-alias> --live
EOF
fi
exit "${verify_rc}"
