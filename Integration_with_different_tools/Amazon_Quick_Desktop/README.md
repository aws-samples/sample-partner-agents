# Amazon Quick Desktop — Quick Setup Guide

You can follow the steps below to set up your local environment before connecting Partner Central agents to Amazon Quick Desktop. You can also use the scripts in this folder to help check your setup before connecting. 

helper.ps1 for Windows & helper.sh for MAC/Linux

Installs prerequisites, checks Partner Central access, and verifies connectivity.

**Usage:**
```bash
bash setup.sh [--profile PROFILE] [--sandbox]
```

---

## Prerequisites

| # | Check | Requirement | Install |
|---|-------|-------------|---------|
| 1 | Python | 3.10+ | [python.org](https://python.org) |
| 2 | AWS CLI | Latest | `brew install awscli` or [AWS docs](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) |
| 3 | uv | Latest | `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

---

## Amazon Quick Desktop Configuration

After all checks pass, configure your IDE:

**Go to:** Settings → Capabilities → MCP → + Add MCP → Local

| Setting | Value |
|---------|-------|
| **Name** | Partner Central |
| **Command** | `uvx` |
| **Arguments** | `mcp-proxy-for-aws@latest https://partnercentral-agents-mcp.us-east-1.api.aws/mcp --service partnercentral-agents-mcp` |
| **Timeout** | 300 |

**Environment variables:**

| Variable | Value |
|----------|-------|
| `AWS_PROFILE` | `<YOUR_PROFILE>` |
| `AWS_REGION` | `us-east-1` |

---

## Verify Setup

After configuring, test with:

> "List my open opportunities"

For Sandbox, include in your prompts:

> "Use the Sandbox catalog"

---

## Setup Steps from command line

### Step 1: Check Python

```bash
python3 --version
```

Requires Python 3.10 or higher.

---

### Step 2: Check AWS CLI

```bash
aws --version
```

If not installed:
- **macOS (Homebrew):** `brew install awscli`
- **Other:** [AWS CLI Install Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)

---

### Step 3: Check/Install uv

```bash
uv --version
```

If not installed:
- **macOS (Homebrew):** `brew install uv`
- **Other:** `curl -LsSf https://astral.sh/uv/install.sh | sh`

---

### Step 4: Check AWS Credentials

```bash
aws sts get-caller-identity --profile <YOUR_PROFILE>
```

If credentials are not valid:
- Run `aws configure --profile <YOUR_PROFILE>`
- Or `aws sso login --profile <YOUR_PROFILE>`

---

### Step 5: Check Partner Central Access

```bash
aws partnercentral-selling list-opportunities \
  --catalog AWS \
  --region us-east-1 \
  --max-results 1 \
  --profile <YOUR_PROFILE>
```

**Possible outcomes:**

| Result | Meaning | Fix |
|--------|---------|-----|
| ✅ Returns opportunities | Access confirmed | None needed |
| ❌ AccessDeniedException | Missing permissions | Attach `AWSMcpServiceActionsFullAccess` managed policy |
| ❌ UnrecognizedClientException | Account not linked | Ensure account is linked to AWS Partner Central |
| ⚠️ EndpointConnectionError | Network issue | Check connectivity to us-east-1 |

#### Sandbox Registration (if using `--sandbox`)

If you get AccessDenied in Sandbox, you may need to register as a partner:

```bash
aws partnercentral-account create-partner \
  --catalog Sandbox \
  --region us-east-1 \
  --legal-name "<COMPANY_NAME>" \
  --primary-solution-type "TechnologyAndSolutions" \
  --alliance-lead-contact '{"FirstName":"<FIRST>","LastName":"<LAST>","BusinessTitle":"Partner Manager","Email":"<EMAIL>"}' \
  --email-verification-code "123456" \
  --client-token "$(uuidgen)"
```

After registration, complete the profile:

```bash
aws partnercentral-account start-profile-update-task \
  --catalog Sandbox \
  --region us-east-1 \
  --partner-id <PARTNER_ID>
```

For manual registration, see: [Sandbox Account Setup](https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html)

---

### Step 6: Check MCP Proxy Package

```bash
uvx mcp-proxy-for-aws@latest --help
```

This verifies the MCP proxy is available and runnable.

---



## Troubleshooting

| Issue | Solution |
|-------|----------|
| Python not found or < 3.10 | Install Python 3.10+ from [python.org](https://python.org) |
| AWS CLI not found | Install via Homebrew or AWS docs |
| Credentials invalid | Run `aws configure` or `aws sso login` |
| Access denied to Partner Central | Attach `AWSMcpServiceActionsFullAccess` policy |
| Cannot reach endpoint | Check network/VPN connectivity to us-east-1 |
| mcp-proxy-for-aws fails | Reinstall uv or check PATH |
