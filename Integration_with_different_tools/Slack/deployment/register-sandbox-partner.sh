#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# register-sandbox-partner.sh — Create a sandbox partner for the bot to query.
#
# Purpose:
#   Registers the caller's AWS account as a partner in the Partner Central
#   *Sandbox* catalog. The bot's /pc-opps and related commands need a sandbox
#   partner to exist before they'll return meaningful data. Run this once per
#   AWS account, after `./setup.sh` has deployed the bot.
#
#   Implements the flow documented at:
#     https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html
#
#   Steps performed:
#     1. Verify AWS credentials are reachable.
#     2. Check whether a sandbox partner already exists for this account
#        (idempotent: if one is found, reuse it for the profile update).
#     3. POST partnercentral-account:CreatePartner with Catalog=Sandbox.
#     4. POST partnercentral-account:StartProfileUpdateTask so the sandbox
#        partner has a complete profile and is eligible for connection testing.
#
# Prerequisites:
#   - AWS CLI v2 installed and authenticated (profile or default credentials).
#   - The calling IAM identity needs these actions scoped to Catalog=Sandbox:
#       partnercentral:ListPartners
#       partnercentral:CreatePartner
#       partnercentral:StartProfileUpdateTask
#     (Full sandbox policy statement at the doc link above.)
#   - Region: Partner Central Account API lives in us-east-1.
#
# Usage:
#   ./deployment/register-sandbox-partner.sh [options]
#
#   Required (or via env / prompt):
#     --legal-name         <name>     Unique legal name (1–80 chars)
#     --first-name         <name>     Alliance lead first name
#     --last-name          <name>     Alliance lead last name
#     --email              <addr>     Alliance lead email
#     --business-title     <title>    Alliance lead job title
#
#   Optional:
#     --solution-type      <enum>     PrimarySolutionType, default SOFTWARE_PRODUCTS
#     --verification-code  <6-digit>  Email verification code, default 123456
#                                     (sandbox accepts any six digits)
#     --display-name       <name>     Public display name, defaults to --legal-name
#     --description        <text>     Partner description (1–600 chars)
#     --website-url        <url>      HTTPS website URL
#     --logo-url           <url>      HTTPS logo URL
#     --industry-segment   <enum>     Industry segment (repeatable, max 3)
#                                     Default: SOFTWARE_INTERNET
#     --locale             <xx-XX>    TranslationSourceLocale, default en-US
#     --partner-id         <id>       Skip CreatePartner and only run the
#                                     profile update against an existing partner
#     --profile            <name>     AWS CLI profile
#     --region             <region>   Default us-east-1
#     --skip-profile-update           Skip the StartProfileUpdateTask call
#     -h | --help                     Print usage
#
#   All required flags can also be supplied via env vars:
#     LEGAL_NAME, FIRST_NAME, LAST_NAME, EMAIL, BUSINESS_TITLE
#
# Example:
#   ./deployment/register-sandbox-partner.sh \
#     --legal-name "Acme Cloud Sandbox" \
#     --first-name "Ada" --last-name "Lovelace" \
#     --email "ada@example.com" --business-title "Alliance Lead" \
#     --profile my-aws-profile
# -----------------------------------------------------------------------------

set -euo pipefail

# -------- defaults ----------------------------------------------------------
SOLUTION_TYPE="${SOLUTION_TYPE:-SOFTWARE_PRODUCTS}"
VERIFICATION_CODE="${VERIFICATION_CODE:-123456}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-}"
SKIP_PROFILE_UPDATE=0

LEGAL_NAME="${LEGAL_NAME:-}"
FIRST_NAME="${FIRST_NAME:-}"
LAST_NAME="${LAST_NAME:-}"
EMAIL="${EMAIL:-}"
BUSINESS_TITLE="${BUSINESS_TITLE:-}"

# Profile fields for StartProfileUpdateTask (all required by that API).
DISPLAY_NAME="${DISPLAY_NAME:-}"
DESCRIPTION="${DESCRIPTION:-Sandbox partner for the Partner Central Slack bot integration tests.}"
WEBSITE_URL="${WEBSITE_URL:-https://example.com}"
LOGO_URL="${LOGO_URL:-https://example.com/logo.png}"
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
    --profile)           PROFILE="$2"; shift 2 ;;
    --region)            REGION="$2"; shift 2 ;;
    --skip-profile-update) SKIP_PROFILE_UPDATE=1; shift ;;
    -h|--help)           usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
done

# Apply defaults that depend on other flags.
[ "${#INDUSTRY_SEGMENTS[@]}" -eq 0 ] && INDUSTRY_SEGMENTS=("SOFTWARE_INTERNET")
[ -z "${DISPLAY_NAME}" ] && DISPLAY_NAME="${LEGAL_NAME}"

# -------- validation --------------------------------------------------------
# In resume mode (--partner-id provided) we only need to rerun the profile
# update, so CreatePartner inputs are optional. Otherwise all are required.
if [ -z "${PARTNER_ID}" ]; then
  missing=()
  [ -z "${LEGAL_NAME}" ]     && missing+=("--legal-name")
  [ -z "${FIRST_NAME}" ]     && missing+=("--first-name")
  [ -z "${LAST_NAME}" ]      && missing+=("--last-name")
  [ -z "${EMAIL}" ]          && missing+=("--email")
  [ -z "${BUSINESS_TITLE}" ] && missing+=("--business-title")
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Error: missing required flags: ${missing[*]}" >&2
    echo "Run with --help for usage." >&2
    exit 1
  fi
fi

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

# aws cli version — partnercentral-account API landed in 2.32.11
cli_version="$(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)"
min_version="2.32.11"
if [ -n "${cli_version}" ] && \
   [ "$(printf '%s\n%s\n' "${min_version}" "${cli_version}" | sort -V | head -1)" != "${min_version}" ]; then
  echo "Error: AWS CLI ${cli_version} is too old — partnercentral-account requires ${min_version}+." >&2
  echo "  macOS:   brew upgrade awscli" >&2
  echo "  Windows: winget upgrade Amazon.AWSCLI" >&2
  echo "  Linux:   re-run the official installer with --update" >&2
  exit 1
fi

# -------- helpers -----------------------------------------------------------
aws_args=(--region "${REGION}" --output json)
[ -n "${PROFILE}" ] && aws_args+=(--profile "${PROFILE}")

log()  { printf '› %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# -------- preflight: who am I? ---------------------------------------------
log "Verifying AWS credentials..."
caller_json="$(aws sts get-caller-identity "${aws_args[@]}" 2>&1)" \
  || fail "sts:GetCallerIdentity failed: ${caller_json}"
account_id="$(printf '%s' "${caller_json}" | awk -F'"' '/"Account"/ {print $4}')"
arn="$(printf '%s'        "${caller_json}" | awk -F'"' '/"Arn"/     {print $4}')"
ok "Account ${account_id} — ${arn}"

# -------- idempotency check: does a sandbox partner already exist? ---------
if [ -z "${PARTNER_ID}" ]; then
  log "Checking for an existing sandbox partner on this account..."
  existing_json="$(aws partnercentral-account list-partners "${aws_args[@]}" \
    --catalog Sandbox 2>&1)" \
    || fail "ListPartners failed: ${existing_json}"
  existing_id="$(printf '%s' "${existing_json}" | awk -F'"' '/"Id"/ {print $4; exit}')"
  existing_name="$(printf '%s' "${existing_json}" | awk -F'"' '/"LegalName"/ {print $4; exit}')"
  if [ -n "${existing_id}" ]; then
    ok "Sandbox partner already exists: ${existing_id} (${existing_name})"
    log "Reusing it and running StartProfileUpdateTask to refresh the profile."
    PARTNER_ID="${existing_id}"
    # Leave LEGAL_NAME intact for the summary block; don't recreate.
  fi
fi

# -------- CreatePartner -----------------------------------------------------
if [ -n "${PARTNER_ID}" ]; then
  partner_id="${PARTNER_ID}"
  partner_arn=""
else
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
# Required per the sandbox testing doc:
#   https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html
# Completes the public partner profile (display name, description, website,
# logo, industry segments, locale) so downstream connection testing works.
if [ "${SKIP_PROFILE_UPDATE}" -eq 1 ]; then
  log "Skipping StartProfileUpdateTask (--skip-profile-update set)."
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

Sandbox partner registration complete.

  Partner Id:      ${partner_id}
  Catalog:         Sandbox
  Legal Name:      ${LEGAL_NAME:-<unchanged>}
  Alliance Lead:   ${FIRST_NAME:-<unchanged>} ${LAST_NAME:-} <${EMAIL:-unchanged}>
  Solution Type:   ${SOLUTION_TYPE}
  Display Name:    ${DISPLAY_NAME:-<unchanged>}
  Industry Segs:   ${INDUSTRY_SEGMENTS[*]}

Next steps:
  1. Make sure your Slack app is installed and the bot is invited to a channel
     (or DM the bot directly).
  2. Try the bot from Slack:
       /pc-opps          # list sandbox opportunities for this partner
       /pc-session       # show the MCP session details

  See docs/WORKSHOP.md for the full test flow and troubleshooting.
EOF
