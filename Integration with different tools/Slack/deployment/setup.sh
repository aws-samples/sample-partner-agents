#!/bin/bash
# setup.sh — One-command setup for the Partner Central Agent Slack Bot.
#
# Usage:
#   ./setup.sh                              # Deploy with defaults
#   AWS_PROFILE=myprofile ./setup.sh        # Use a specific AWS profile
#   STACK_NAME_PREFIX=slack-pc-dev ./setup.sh   # Deploy a second copy alongside
#   CATALOG=AWS ./setup.sh                  # Production catalog (prompts for acknowledgment)
#   ALARM_EMAIL=ops@example.com ./setup.sh  # Enable CloudWatch alarm notifications
#
# Steps performed:
#   1. Verify AWS CLI, profile, and region
#   2. Create a deployment S3 bucket if missing
#   3. Package the Lambda with production dependencies
#   4. Deploy the CloudFormation stack (Secrets Manager, DynamoDB, Lambda, API Gateway, alarms)
#   5. Print next steps for Slack app setup

set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME_PREFIX="${STACK_NAME_PREFIX:-slack-pc-bot}"
STACK_NAME="${STACK_NAME:-${STACK_NAME_PREFIX}}"
CATALOG="${CATALOG:-Sandbox}"
ALARM_EMAIL="${ALARM_EMAIL:-}"

# Optional credential inputs for post-deploy secret population.
# Take from env vars if set; CLI flags below will override.
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"

# ----- CLI argument parsing ------------------------------------------------
# Most configuration is env-var driven for backward compatibility, but a few
# things benefit from being flags: credentials (for scripted use) and a flag
# to skip the interactive credential prompt.
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slack-token)          SLACK_BOT_TOKEN="$2"; shift 2 ;;
    --slack-signing-secret) SLACK_SIGNING_SECRET="$2"; shift 2 ;;
    --yes|-y)               ASSUME_YES=1; shift ;;
    -h|--help)
      cat <<'HELP'
Usage: ./setup.sh [--slack-token xoxb-...] [--slack-signing-secret ...] [--yes]

Environment variables (all optional, CLI flags take precedence):
  AWS_PROFILE              AWS CLI profile to use. If unset, script prompts.
  AWS_REGION               AWS region (default us-east-1)
  STACK_NAME_PREFIX        Prefix for every resource name (default slack-pc-bot)
  STACK_NAME               CFN stack name (default = STACK_NAME_PREFIX)
  CATALOG                  Sandbox or AWS (default Sandbox)
  ALARM_EMAIL              Email address for CloudWatch alarms (optional)
  SLACK_BOT_TOKEN          Bot token; if set, populates Secrets Manager automatically
  SLACK_SIGNING_SECRET     Signing secret; same as above

Flags:
  --slack-token            Bot token (xoxb-...). For scripted re-deploys after
                           the Slack app already exists. Skip on first deploy.
  --slack-signing-secret   Slack signing secret. Same as above.
  --yes, -y                Skip the "stack already exists, update it?" prompt.
                           Use this in CI / scripted re-deploys.

Workshop participants doing a first deploy: just run ./setup.sh and follow the
output. The script will tell you exactly what to do after Slack app creation.
HELP
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo "Run with --help for usage." >&2; exit 1 ;;
  esac
done

echo "Partner Central Agent Slack Bot — Setup"
echo ""

# Verify prerequisites
command -v aws >/dev/null 2>&1 || { echo "AWS CLI not found"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found"; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "zip not found"; exit 1; }

# Profile selection:
#   - If 2+ profiles exist and stdin is a TTY, always prompt. AWS_PROFILE (if
#     set) is shown as the pre-selected default; press Enter to accept, or type
#     a number to switch.
#   - If only one profile exists, auto-select it.
#   - If no profiles exist, print a friendly error.
#   - If stdin isn't a TTY (CI / piped), respect AWS_PROFILE if set, otherwise
#     fall back to 'default' without hanging on user input.
PROFILES=()
while IFS= read -r line; do
  [ -n "$line" ] && PROFILES+=("$line")
done < <(aws configure list-profiles 2>/dev/null || true)

if [ "${#PROFILES[@]}" -eq 0 ]; then
  echo "No AWS profiles configured. Run 'aws configure --profile <name>' or" \
       "'aws configure sso --profile <name>' first, then re-run setup."
  exit 1
elif [ "${#PROFILES[@]}" -eq 1 ]; then
  AWS_PROFILE="${PROFILES[0]}"
  echo "Using the only configured AWS profile: ${AWS_PROFILE}"
  echo ""
elif [ ! -t 0 ]; then
  AWS_PROFILE="${AWS_PROFILE:-default}"
  echo "Non-interactive shell — using profile: ${AWS_PROFILE}"
  echo ""
else
  # Figure out which profile (if any) is the default. If AWS_PROFILE is set and
  # matches one of the listed profiles, use it. Otherwise, no pre-selection.
  default_idx=""
  if [ -n "${AWS_PROFILE:-}" ]; then
    for i in "${!PROFILES[@]}"; do
      if [ "${PROFILES[$i]}" = "$AWS_PROFILE" ]; then
        default_idx=$((i + 1))
        break
      fi
    done
  fi

  echo "Available AWS profiles:"
  for i in "${!PROFILES[@]}"; do
    marker=""
    [ "$((i + 1))" = "$default_idx" ] && marker=" (current)"
    printf "  %d) %s%s\n" "$((i + 1))" "${PROFILES[$i]}" "$marker"
  done
  echo ""

  while :; do
    if [ -n "$default_idx" ]; then
      read -rp "Pick a profile [1-${#PROFILES[@]}] (default: ${default_idx}): " choice
      [ -z "$choice" ] && choice="$default_idx"
    else
      read -rp "Pick a profile [1-${#PROFILES[@]}]: " choice
    fi
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#PROFILES[@]}" ]; then
      AWS_PROFILE="${PROFILES[$((choice - 1))]}"
      break
    fi
    echo "  Invalid choice. Enter a number between 1 and ${#PROFILES[@]}."
  done
  echo ""
fi

echo "Verifying AWS identity..."
ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query 'Account' --output text 2>/dev/null) || {
  echo "Could not authenticate with profile '$AWS_PROFILE'."
  echo "If this is an SSO profile, run: aws sso login --profile $AWS_PROFILE"
  exit 1
}
echo "  Account: ${ACCOUNT_ID}"
echo "  Region:  ${AWS_REGION}"
echo "  Profile: ${AWS_PROFILE}"
echo "  Catalog: ${CATALOG}"
echo ""

# Production safety gate
ACKNOWLEDGE_PRODUCTION="false"
if [ "$CATALOG" = "AWS" ]; then
  echo "WARNING: CATALOG=AWS will affect live production partner data."
  read -rp "Type 'I UNDERSTAND' to proceed: " CONFIRM
  if [ "$CONFIRM" != "I UNDERSTAND" ]; then
    echo "Aborted."
    exit 1
  fi
  ACKNOWLEDGE_PRODUCTION="true"
fi

# ----- Stack existence check ----------------------------------------------
# If a CFN stack with this name already exists, ask the user before proceeding.
# Prevents the "I forgot to set STACK_NAME_PREFIX and accidentally updated the
# wrong stack" failure mode. --yes / -y skips the prompt for scripted re-runs.
echo "Checking for an existing stack named: ${STACK_NAME}"
set +e
existing_status=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
describe_rc=$?
set -e

if [ $describe_rc -eq 0 ] && [ -n "$existing_status" ] && [ "$existing_status" != "None" ]; then
  echo "  Found existing stack: ${STACK_NAME} (${existing_status})"
  if [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; then
    echo "  --yes / non-interactive — proceeding with stack update."
  else
    echo ""
    echo "  Continuing will UPDATE this stack with the current code."
    echo "  If you wanted a fresh, parallel deployment, abort and re-run with"
    echo "  a unique prefix, e.g.:"
    echo "    STACK_NAME_PREFIX=${STACK_NAME_PREFIX}-test ./setup.sh"
    echo ""
    read -rp "  Update existing stack ${STACK_NAME}? [y/N]: " confirm
    case "${confirm:-n}" in
      y|Y|yes|YES) ;;
      *) echo "Aborted."; exit 0 ;;
    esac
  fi
else
  echo "  No existing stack — this will be a fresh deployment."
fi
echo ""

# Deployment bucket
S3_BUCKET="${STACK_NAME_PREFIX}-deploy-${ACCOUNT_ID}"
S3_KEY="slack-partner-central/lambda.zip"

echo "Preparing deployment bucket: ${S3_BUCKET}"
if aws s3api head-bucket --bucket "$S3_BUCKET" --profile "$AWS_PROFILE" --region "$AWS_REGION" 2>/dev/null; then
  echo "  Bucket exists"
else
  aws s3 mb "s3://${S3_BUCKET}" --profile "$AWS_PROFILE" --region "$AWS_REGION"
  echo "  Bucket created"
fi
echo ""

# Package Lambda
echo "Packaging Lambda function..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cp -r "$PROJECT_DIR/src" "$TEMP_DIR/src"
cp "$PROJECT_DIR/lambda.js" "$TEMP_DIR/"
cp "$PROJECT_DIR/package.json" "$TEMP_DIR/"

(cd "$TEMP_DIR" && npm install --omit=dev --quiet 2>&1 | tail -2)

ZIP_FILE="$TEMP_DIR/lambda.zip"
(cd "$TEMP_DIR" && zip -r -q "$ZIP_FILE" . -x "*.DS_Store")
echo "  Package size: $(du -h "$ZIP_FILE" | cut -f1)"

# Upload
echo "Uploading to S3..."
aws s3 cp "$ZIP_FILE" "s3://${S3_BUCKET}/${S3_KEY}" \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" --quiet
echo "  Uploaded"
echo ""

# Deploy CloudFormation
echo "Deploying CloudFormation stack: ${STACK_NAME}"
PARAMS=(
  "StackNamePrefix=${STACK_NAME_PREFIX}"
  "Catalog=${CATALOG}"
  "AcknowledgeProduction=${ACKNOWLEDGE_PRODUCTION}"
  "LambdaS3Bucket=${S3_BUCKET}"
  "LambdaS3Key=${S3_KEY}"
)
if [ -n "$ALARM_EMAIL" ]; then
  PARAMS+=("AlarmEmail=${ALARM_EMAIL}")
fi

aws cloudformation deploy \
  --template-file "$SCRIPT_DIR/cloudformation.yaml" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${PARAMS[@]}" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"

echo "  Stack deployed"
echo ""

# Outputs
EVENTS_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`SlackEventsUrl`].OutputValue' --output text)

SECRET_NAME="${STACK_NAME_PREFIX}-slack-credentials"

echo ""
echo "Deployment complete."
echo ""
echo "Events URL: ${EVENTS_URL}"
echo "Secret ID:  ${SECRET_NAME}"
echo ""

# ----- Step 1 reminder: Create the Slack app ------------------------------
# No way to automate this — the manifest has to be pasted into the Slack UI
# and the workspace admin has to approve installation. Remind the user.
cat <<EOF
Step 1 — Create the Slack app (required, manual):

  1. Open https://api.slack.com/apps → "Create an App" → "From a manifest"
  2. Paste deployment/slack-manifest.yaml, replacing all occurrences of
     YOUR_API_GATEWAY_URL with:
         ${EVENTS_URL}
  3. Click Create, then Install to Workspace and approve.

EOF

# ----- Step 2: populate Slack credentials in Secrets Manager --------------
# The Slack tokens come from a Slack app that the user creates manually after
# the AWS deploy (Step 1 above). On first run they don't have tokens yet, so
# we don't prompt — we print the exact aws command they'll need to run after
# Lab 4 step 3 of the workshop. For scripted re-runs, --slack-token and
# --slack-signing-secret skip the print and write directly.
populate_secret() {
  local token="$1" signing="$2"
  local err
  set +e
  err=$(aws secretsmanager put-secret-value \
    --profile "$AWS_PROFILE" --region "$AWS_REGION" \
    --secret-id "$SECRET_NAME" \
    --secret-string "$(printf '{"SLACK_BOT_TOKEN":"%s","SLACK_SIGNING_SECRET":"%s"}' "$token" "$signing")" \
    2>&1 >/dev/null)
  local rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    echo "  Failed to populate secret: $err" >&2
    return 1
  fi
  return 0
}

validate_bot_token()      { [[ "$1" =~ ^xoxb- ]]; }
validate_signing_secret() { [[ "$1" =~ ^[a-fA-F0-9]{32,}$ ]]; }

echo "Step 2 — Populate Slack credentials in Secrets Manager:"
echo ""

if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_SIGNING_SECRET" ]; then
  # Tokens supplied via flags/env — populate directly.
  validate_bot_token      "$SLACK_BOT_TOKEN"      || echo "  Warning: bot token doesn't start with 'xoxb-'."
  validate_signing_secret "$SLACK_SIGNING_SECRET" || echo "  Warning: signing secret isn't 32+ hex chars."
  if populate_secret "$SLACK_BOT_TOKEN" "$SLACK_SIGNING_SECRET"; then
    echo "  Credentials populated from flags/env."
  fi
else
  cat <<EOF
  After you finish creating the Slack app in Step 1, copy the Bot User OAuth
  Token (xoxb-...) and the Signing Secret from the Slack app dashboard, then
  run this command to populate the secret:

    aws secretsmanager put-secret-value \\
      --secret-id ${SECRET_NAME} \\
      --secret-string '{"SLACK_BOT_TOKEN":"xoxb-PASTE","SLACK_SIGNING_SECRET":"PASTE"}' \\
      --profile ${AWS_PROFILE} --region ${AWS_REGION}

  Then force the Lambda to pick up the new values:

    aws lambda update-function-configuration \\
      --function-name ${STACK_NAME_PREFIX}-bot \\
      --description "credentials populated" \\
      --profile ${AWS_PROFILE} --region ${AWS_REGION}
EOF
fi
echo ""

# ----- Step 3: sandbox partner check --------------------------------------
# Check if a sandbox partner already exists. Don't fail the whole script if
# the call errors (e.g., missing IAM perms, old CLI, etc) — the user might
# not need this, and the main deployment already succeeded.
echo "Step 3 — Sandbox partner registration:"
echo ""
set +e
existing_partners=$(aws partnercentral-account list-partners \
  --catalog Sandbox \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'PartnerSummaryList[0].[Id,LegalName]' --output text 2>/dev/null)
list_rc=$?
set -e

if [ $list_rc -ne 0 ]; then
  echo "  Could not check for an existing sandbox partner (partnercentral-account call failed)."
  echo "  This may mean the AWS CLI is too old (needs 2.32.11+) or missing permissions."
  echo "  If /pc-opps returns nothing later, run:"
  echo "    ./deployment/register-sandbox-partner.sh --help"
elif [ -z "$existing_partners" ] || [ "$existing_partners" = "None" ]; then
  echo "  No sandbox partner found on this account."
  echo "  Register one with:"
  echo "    ./deployment/register-sandbox-partner.sh --help"
else
  partner_id=$(echo "$existing_partners" | awk '{print $1}')
  partner_name=$(echo "$existing_partners" | cut -f2-)
  echo "  Sandbox partner already registered: ${partner_id} (${partner_name})"
fi
echo ""

echo "Step 4 — Test in Slack:"
echo "  Invite the bot to a channel: /invite @Partner Central Bot"
echo "  Then try:                    /pc-session"
echo "                               /pc-opps"
echo ""

echo "Deployed resources:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table
