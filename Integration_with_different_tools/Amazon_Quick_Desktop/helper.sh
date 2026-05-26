#!/usr/bin/env bash
# Partner Central MCP — Quick Setup
# Installs prerequisites, checks Partner Central access, and verifies connectivity.
# Usage: bash setup.sh [--profile PROFILE] [--sandbox]

set -euo pipefail

PROFILE=""
SANDBOX=false
REGION="us-east-1"
ENDPOINT="https://partnercentral-agents-mcp.us-east-1.api.aws/mcp"
SERVICE="partnercentral-agents-mcp"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --profile) PROFILE="$2"; shift 2 ;;
    --sandbox) SANDBOX=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# If no profile specified, list available profiles and let user choose
if [[ -z "$PROFILE" ]]; then
  PROFILES=()
  while IFS= read -r p; do
    [[ -n "$p" ]] && PROFILES+=("$p")
  done < <(aws configure list-profiles 2>/dev/null)

  if [[ ${#PROFILES[@]} -eq 0 ]]; then
    echo "❌ No AWS CLI profiles found. Run: aws configure"
    exit 1
  elif [[ ${#PROFILES[@]} -eq 1 ]]; then
    PROFILE="${PROFILES[0]}"
    echo "Using the only available AWS profile: $PROFILE"
  else
    echo "Available AWS CLI profiles:"
    echo ""
    for i in "${!PROFILES[@]}"; do
      echo "  $((i+1))) ${PROFILES[$i]}"
    done
    echo ""
    read -p "Select profile [1-${#PROFILES[@]}]: " CHOICE
    if [[ "$CHOICE" =~ ^[0-9]+$ ]] && [[ "$CHOICE" -ge 1 ]] && [[ "$CHOICE" -le ${#PROFILES[@]} ]]; then
      PROFILE="${PROFILES[$((CHOICE-1))]}"
    else
      echo "❌ Invalid selection."
      exit 1
    fi
  fi
fi

echo ""
echo "=== Partner Central MCP Setup ==="
echo "AWS Profile: $PROFILE"
echo "Sandbox:     $SANDBOX"
echo ""

# 1. Check Python
echo "[1/6] Checking Python..."
if command -v python3 &>/dev/null; then
  PY_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
  PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
  PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
  if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 10 ]]; then
    echo "  ✅ Python $PY_VERSION"
  else
    echo "  ❌ Python $PY_VERSION found — need 3.10+. Install from https://python.org"
    exit 1
  fi
else
  echo "  ❌ Python not found. Install Python 3.10+ from https://python.org"
  exit 1
fi

# 2. Check AWS CLI
echo "[2/6] Checking AWS CLI..."
if command -v aws &>/dev/null; then
  AWS_VERSION=$(aws --version 2>&1 | awk '{print $1}')
  echo "  ✅ $AWS_VERSION"
else
  echo "  ❌ AWS CLI not found."
  if command -v brew &>/dev/null; then
    echo "     Install with: brew install awscli"
  else
    echo "     Install from: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi
  exit 1
fi

# 3. Check/install uv
echo "[3/6] Checking uv..."
if command -v uv &>/dev/null; then
  echo "  ✅ uv $(uv --version 2>&1 | head -1)"
else
  echo "  Installing uv..."
  if command -v brew &>/dev/null; then
    brew install uv
  else
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  echo "  ✅ uv installed"
fi

# 4. Check AWS credentials
echo "[4/6] Checking AWS credentials (profile: $PROFILE)..."
if AWS_PROFILE="$PROFILE" aws sts get-caller-identity &>/dev/null; then
  IDENTITY=$(AWS_PROFILE="$PROFILE" aws sts get-caller-identity --output text --query 'Arn' 2>/dev/null)
  echo "  ✅ Authenticated as: $IDENTITY"
else
  echo "  ❌ AWS credentials not valid for profile '$PROFILE'."
  echo "     Run: aws configure --profile $PROFILE"
  echo "     Or:  aws sso login --profile $PROFILE"
  exit 1
fi

# 5. Check Partner Central access
echo "[5/6] Checking Partner Central access..."
CATALOG="AWS"
if [[ "$SANDBOX" == "true" ]]; then
  CATALOG="Sandbox"
fi

# Try listing partners to verify access
PC_RESULT=$(AWS_PROFILE="$PROFILE" aws partnercentral-selling list-opportunities \
  --catalog "$CATALOG" \
  --region "$REGION" \
  --max-results 1 2>&1) || true

if echo "$PC_RESULT" | grep -q "OpportunitySummaries\|Results"; then
  echo "  ✅ Partner Central access confirmed ($CATALOG catalog)"
elif echo "$PC_RESULT" | grep -q "AccessDeniedException"; then
  echo "  ⚠️  Access denied to Partner Central ($CATALOG catalog)."
  echo ""
  echo "     Your IAM identity needs Partner Central permissions."
  echo "     Quickest fix: attach the AWSMcpServiceActionsFullAccess managed policy."
  echo ""
  if [[ "$SANDBOX" == "true" ]]; then
    echo "     For Sandbox, your account may also need to be registered as a partner."
    echo ""
    read -p "     Would you like to register in the Sandbox now? (y/N) " REGISTER
    if [[ "$REGISTER" =~ ^[Yy]$ ]]; then
      echo ""
      read -p "     Company legal name: " LEGAL_NAME
      read -p "     Contact first name: " FIRST_NAME
      read -p "     Contact last name: " LAST_NAME
      read -p "     Contact email: " CONTACT_EMAIL
      read -p "     Contact title [Partner Manager]: " BIZ_TITLE
      BIZ_TITLE="${BIZ_TITLE:-Partner Manager}"

      CLIENT_TOKEN=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())")

      echo ""
      echo "     Registering in Sandbox..."
      CREATE_RESULT=$(AWS_PROFILE="$PROFILE" aws partnercentral-account create-partner \
        --catalog Sandbox \
        --region "$REGION" \
        --legal-name "$LEGAL_NAME" \
        --primary-solution-type "TechnologyAndSolutions" \
        --alliance-lead-contact "{\"FirstName\":\"$FIRST_NAME\",\"LastName\":\"$LAST_NAME\",\"BusinessTitle\":\"$BIZ_TITLE\",\"Email\":\"$CONTACT_EMAIL\"}" \
        --email-verification-code "123456" \
        --client-token "$CLIENT_TOKEN" 2>&1) || true

      if echo "$CREATE_RESULT" | grep -q "PartnerId\|partnerId"; then
        PARTNER_ID=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('PartnerId',''))" 2>/dev/null || echo "")
        echo "  ✅ Partner created in Sandbox (ID: $PARTNER_ID)"

        echo "     Completing profile setup..."
        PROFILE_RESULT=$(AWS_PROFILE="$PROFILE" aws partnercentral-account start-profile-update-task \
          --catalog Sandbox \
          --region "$REGION" \
          --partner-id "$PARTNER_ID" 2>&1) || true

        if echo "$PROFILE_RESULT" | grep -q "TaskId\|taskId"; then
          echo "  ✅ Profile update started"
        else
          echo "  ⚠️  Profile update may need manual completion."
          echo "     $PROFILE_RESULT"
        fi
      elif echo "$CREATE_RESULT" | grep -q "ConflictException\|already exists"; then
        echo "  ℹ️  Partner already registered in Sandbox. The issue is IAM permissions."
        echo "     Attach AWSMcpServiceActionsFullAccess and re-run."
      elif echo "$CREATE_RESULT" | grep -q "AccessDeniedException"; then
        echo "  ❌ Cannot register — missing partnercentral:CreatePartner permission."
        echo "     Attach the Sandbox IAM policy first:"
        echo "     https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html"
      else
        echo "  ❌ Registration failed: $(echo "$CREATE_RESULT" | head -3)"
      fi
      echo ""
      echo "     Re-run this script to verify access."
      exit 0
    else
      echo ""
      echo "     To register manually, see:"
      echo "     https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html"
    fi
  fi
  echo ""
  echo "     After fixing permissions, re-run this script."
  exit 1
elif echo "$PC_RESULT" | grep -q "UnrecognizedClientException\|InvalidSignatureException"; then
  echo "  ❌ AWS credentials are valid but cannot sign Partner Central requests."
  echo "     Ensure your account is linked to AWS Partner Central."
  exit 1
elif echo "$PC_RESULT" | grep -q "Could not connect\|EndpointConnectionError"; then
  echo "  ⚠️  Cannot reach Partner Central endpoint. Check network connectivity to us-east-1."
  exit 1
else
  echo "  ⚠️  Unexpected response from Partner Central. May still work in Quick."
  echo "     Response: $(echo "$PC_RESULT" | head -3)"
fi

# 6. Check MCP proxy package
echo "[6/6] Checking MCP proxy package..."
if uvx mcp-proxy-for-aws@latest --help &>/dev/null; then
  echo "  ✅ mcp-proxy-for-aws is available"
else
  echo "  ❌ Could not run mcp-proxy-for-aws. Check uv installation."
  exit 1
fi

# Print Quick configuration
echo ""
echo "=== Amazon Quick Configuration ==="
echo ""
echo "Go to: Settings → Capabilities → MCP → + Add MCP → Local"
echo ""
echo "  Name:        Partner Central"
echo "  Command:     uvx"
echo "  Arguments:   mcp-proxy-for-aws@latest $ENDPOINT --service $SERVICE"
echo "  Timeout:     300"
echo ""
echo "  Environment variables:"
echo "    AWS_PROFILE = $PROFILE"
echo "    AWS_REGION  = $REGION"
echo ""
echo "=== Setup Complete ==="
echo ""
echo "After configuring in Quick, test with: \"List my open opportunities\""
if [[ "$SANDBOX" == "true" ]]; then
  echo "For Sandbox, include 'use the Sandbox catalog' in your prompts."
fi
