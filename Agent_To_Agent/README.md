# Agent-to-Agent: CRM Integration with AWS Partner Central Agent

An AI orchestrator agent that communicates with the **AWS Partner Central Agent** to automate opportunity management, and integrates with CRM systems (HubSpot, Salesforce, Pipedrive) to create ACE opportunities from deals.

## Why Agent-to-Agent?

This application demonstrates **agent-to-agent communication** — a pattern where one AI agent delegates specialized tasks to another AI agent rather than calling APIs directly.

```
┌─────────────────────────────────────────────────────────────────┐
│                YOUR ORCHESTRATOR AGENT                          │
│  (Custom agent you build and control)                           │
│                                                                 │
│  • Connects to CRM systems (HubSpot, Salesforce, Pipedrive)    │
│  • Gathers context from YOUR sources (Slack, files, uploads)    │
│  • Uses Amazon Bedrock to analyze and generate content          │
│  • Maps CRM data to Partner Central format                      │
│  • Decides WHAT to create or update                             │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          │ Agent-to-Agent Communication
                          │ (MCP Protocol)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              AWS PARTNER CENTRAL MCP AGENT                      │
│  (AWS-hosted agent with Partner Central expertise)              │
│                                                                 │
│  • Understands Partner Central domain & business rules          │
│  • Validates updates against PC requirements                    │
│  • Handles human-in-the-loop approval workflow                  │
│  • Executes the actual API calls to Partner Central             │
└─────────────────────────────────────────────────────────────────┘
```

**Key Difference from Direct API Calls:**
- Direct API: Your code → Partner Central API
- Agent-to-Agent: Your Agent → PC Agent → Partner Central API

**Benefits of Agent-to-Agent:**
1. **Domain Expertise**: The PC Agent understands business rules, validation requirements, and best practices
2. **Natural Language**: Communicate intent ("update next steps") rather than constructing API payloads
3. **Built-in Guardrails**: Human approval workflow, validation checks, error handling
4. **Reduced Complexity**: Your agent focuses on gathering context; the PC Agent handles PC-specific logic

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ORCHESTRATOR AGENT                                 │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Context Sources                                 │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │   │
│  │  │  Slack   │  │  Files   │  │ Uploads  │  │   CRM Systems    │    │   │
│  │  │ Channels │  │ Folders  │  │          │  │ (HubSpot/SFDC/   │    │   │
│  │  │          │  │          │  │          │  │  Pipedrive)      │    │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘    │   │
│  └───────┼─────────────┼─────────────┼─────────────────┼──────────────┘   │
│          │             │             │                 │                   │
│          └─────────────┴──────┬──────┴─────────────────┘                   │
│                               ▼                                            │
│                    ┌─────────────────────┐                                 │
│                    │   Context Merger    │                                 │
│                    │   & Data Mapper     │                                 │
│                    └──────────┬──────────┘                                 │
│                               ▼                                            │
│                    ┌─────────────────────┐                                 │
│                    │  Amazon Bedrock     │                                 │
│                    │  (Claude AI Model)  │                                 │
│                    │  via Strands SDK    │                                 │
│                    │  - Next Steps Gen   │                                 │
│                    │  - Content Analysis │                                 │
│                    └──────────┬──────────┘                                 │
│                               ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Partner Central Integration                       │   │
│  │  ┌─────────────────────┐         ┌─────────────────────────────┐   │   │
│  │  │  PC Selling API     │         │  Partner Central MCP Agent  │   │   │
│  │  │  (CreateOpportunity)│         │  (Update, Q&A, Approvals)   │   │   │
│  │  └─────────────────────┘         └─────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Web UI** (Flask): Interactive demo for creating/updating opportunities, chat with the PC Agent
- **CLI**: Full command-line interface for scripting and automation
- **REST API** (FastAPI): Headless integration for services and CI/CD
- **CRM Integrations**: HubSpot, Salesforce, Pipedrive
- **Bi-directional Sync**: Push ACE status back to your CRM (Demo UI supports HubSpot; CLI supports all CRMs)
- **Slack Integration**: Read messages from channels as context (optional)
- **AI-Powered Generation**: Use Claude (via Amazon Bedrock, orchestrated with the Strands Agents SDK) to create actionable next steps
- **AWS Marketplace Catalog**: Query offers and products
- **MCP Integration**: Update Partner Central opportunities via the Partner Central Agent
- **Process Call (Demo UI)**: Turn raw call/meeting notes into a co-sell opportunity end-to-end — extract fields, create a HubSpot deal + contact, have the Partner Central Agent create the ACE opportunity, and optionally submit it for co-sell. Disabled by default (it creates real CRM and ACE records)

## Prerequisites

1. **Python 3.10+**
2. **AWS CLI v2** installed and configured
   - macOS: download [AWSCLIV2.pkg](https://awscli.amazonaws.com/AWSCLIV2.pkg) or `brew install awscli`
   - Linux/Windows: see [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
   - Verify: `aws --version` should report `aws-cli/2.x.x`
3. **AWS credentials configured** — run `aws configure` (or SSO). Verify with `aws sts get-caller-identity`.
4. **Amazon Bedrock Claude access in `us-east-1`** — Anthropic models are auto-enabled the first time you invoke them in a commercial region. First-time users may need to submit a one-time use-case form via the Bedrock console **Model catalog** (the legacy "Model access" page has been retired).
5. **IAM permissions** — the [`AWSPartnerCentralSandboxFullAccess`](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSPartnerCentralSandboxFullAccess.html) managed policy (or equivalent) covering Partner Central + MCP session management
6. **Sandbox partner registration** — your AWS account registered as a partner in the Sandbox catalog
7. **boto3 1.35.0+** — required for the `partnercentral-selling` client

> ⚠️ **Don't `curl` the Partner Central API directly.** All Partner Central endpoints require AWS SigV4-signed requests. A plain `curl` call returns `{"message":"Missing Authentication Token"}`. Use the AWS CLI (`aws partnercentral-...`) or boto3 — both sign for you automatically.

## AWS Account Setup

Before running the application, you need a configured AWS environment with:

1. **An IAM user** with credentials configured locally (`aws configure` done, verified by `aws sts get-caller-identity`)
2. **Bedrock Claude access in `us-east-1`** — auto-enabled on first invoke; first-time users may need a one-time use-case form via the Bedrock console **Model catalog**
3. **Partner Central permissions** — the `AWSPartnerCentralSandboxFullAccess` managed policy (or equivalent)
4. **Sandbox partner registration** — your AWS account registered as a partner in the Sandbox catalog

<details>
<summary><strong>Self-service setup (IAM user + policies + access key)</strong></summary>

If you don't already have an IAM user and access keys, your cloud admin (or you, if you admin your own account) can set them up:

```bash
# 1. Create the IAM user
aws iam create-user --user-name pcmcp-workshop-user

# 2. Attach Partner Central access (covers MCP session + all Sandbox PC actions)
aws iam attach-user-policy \
  --user-name pcmcp-workshop-user \
  --policy-arn arn:aws:iam::aws:policy/AWSPartnerCentralSandboxFullAccess

# 3. Attach inline Bedrock policy
aws iam put-user-policy \
  --user-name pcmcp-workshop-user \
  --policy-name BedrockInvokeClaude \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "InvokeClaude",
        "Effect": "Allow",
        "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:*:inference-profile/*"]
      }
    ]
  }'

# 4. Create an access key — copy AccessKeyId and SecretAccessKey from output
#    (the secret is shown only once)
aws iam create-access-key --user-name pcmcp-workshop-user

# 5. Configure the CLI locally
aws configure
# AWS Access Key ID:     <paste AccessKeyId>
# AWS Secret Access Key: <paste SecretAccessKey>
# Default region name:   us-east-1
# Default output format: json

# 6. Verify
aws sts get-caller-identity
```

> ⚠️ **Never commit access keys to git.** Treat the secret key like a password. If it leaks, rotate immediately with `aws iam delete-access-key --user-name pcmcp-workshop-user --access-key-id AKIA...` and create a new one.

> Use an IAM **user** only for this local workshop. For production or shared-account use, prefer IAM Identity Center (SSO) or an assumable IAM role.

</details>

<details>
<summary><strong>Register as an AWS Partner in Sandbox</strong></summary>

Before you can call any Partner Central API in Sandbox (including `list-opportunities`, `get-opportunity`, or the MCP `sendMessage` tool), your AWS account must be registered as a partner in the **Sandbox catalog**. Skipping this step causes `AccessDeniedException ... INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE` on every Partner Central call.

**One-time setup per AWS account** — subsequent users in the same account can skip this.

**Check if registration already exists:**

```bash
aws partnercentral-selling list-opportunities \
  --catalog Sandbox \
  --region us-east-1
```

- Get `INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE` → proceed below
- Get an opportunity list (even an empty `{"OpportunitySummaries": []}`) → you're done

**Create the partner registration:**

```bash
aws partnercentral-account create-partner \
  --region us-east-1 \
  --catalog Sandbox \
  --client-token "$(uuidgen || echo pcmcp-$(date +%s))" \
  --legal-name "YourCompanyName" \
  --primary-solution-type CONSULTING_SERVICES \
  --alliance-lead-contact '{
    "FirstName": "Your",
    "LastName": "Name",
    "Email": "your-email@example.com",
    "BusinessTitle": "Your Title"
  }' \
  --email-verification-code "123456"
```

Notes:
- For Sandbox, **no actual email verification is required** — any 6-digit value works (e.g., `123456`).
- `--client-token` must be unique per call. `uuidgen` or a timestamp works.
- These are test-only records in the Sandbox — they don't affect production Partner Central data.

**Verify registration:**

```bash
aws partnercentral-selling list-opportunities \
  --catalog Sandbox \
  --region us-east-1
```

An empty list is fine — what matters is no `INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE` error.

</details>

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Verify boto3 version (needs 1.35.0+ for partnercentral-selling)
python -c "import boto3; print(f'boto3 version: {boto3.__version__}')"

# Verify full setup (AWS creds + Bedrock + Partner Central + MCP)
python verify_setup.py

# Option 1: Run Demo UI (recommended for demos)
python demo_ui.py
# Open http://localhost:8002 in your browser

# Option 2: CLI - Update opportunity next steps
python orchestrator_agent.py \
  --opportunity-id O15081741 \
  --upload sample_meeting_notes/demo_meeting_notes.txt \
  --prompt "Generate next steps based on meeting notes"

# Option 3: CLI - Create ACE opportunity from HubSpot deal
export HUBSPOT_BEARER_TOKEN="pat-na2-xxxxx"
python orchestrator_agent.py hubspot-create -d 12345678901

# Option 4: Run as API server
python server.py
# API available at http://localhost:8001
```

> **Finding a valid opportunity ID:** Run `aws partnercentral-selling list-opportunities --catalog Sandbox --region us-east-1 --life-cycle-review-status '["Approved"]'` and copy an `Id` value from the response.

## CLI Usage

### Update Opportunity Next Steps

```bash
# Basic usage with uploaded file
python orchestrator_agent.py -o O15081741 -u meeting_notes.txt -p "What are the next steps?"

# With Slack channel (requires SLACK_BOT_TOKEN env var)
python orchestrator_agent.py -o O15081741 -s partner-deals -p "Summarize recent discussions"

# With local folder
python orchestrator_agent.py -o O15081741 -f ./deal-notes -p "Generate action items"

# Dry run (generate but don't update the opportunity)
python orchestrator_agent.py -o O15081741 -u notes.txt --dry-run

# Auto-approve (for headless scripts/CI — skips y/n prompt)
python orchestrator_agent.py -o O15081741 -u notes.txt --auto-approve

# Multiple sources
python orchestrator_agent.py -o O15081741 \
  -s partner-deals \
  -f ./notes \
  -u meeting.txt \
  -p "Create comprehensive next steps"

# Or use the explicit 'update' subcommand
python orchestrator_agent.py update -o O15081741 -u notes.txt
```

### HubSpot Integration

```bash
# Set your HubSpot bearer token
export HUBSPOT_BEARER_TOKEN="pat-na2-xxxxx-xxxxx"

# List recent HubSpot deals
python orchestrator_agent.py hubspot-list

# Create ACE opportunity from a HubSpot deal
python orchestrator_agent.py hubspot-create -d 12345678901

# With custom project title
python orchestrator_agent.py hubspot-create -d 12345678901 -t "Custom Project Title"

# Sync PC opportunity status back to HubSpot deal
python orchestrator_agent.py hubspot-sync -o O15081741 -d 12345678901
```

### Salesforce Integration

```bash
export SALESFORCE_ACCESS_TOKEN="00D..."
export SALESFORCE_INSTANCE_URL="https://yourcompany.my.salesforce.com"

# List recent Salesforce opportunities
python orchestrator_agent.py salesforce-list

# Create ACE opportunity from Salesforce
python orchestrator_agent.py salesforce-create -o 006xxxxxxxxxxxxx

# Sync PC opportunity status back to Salesforce
python orchestrator_agent.py salesforce-sync -o O15081741 -s 006xxxxxxxxxxxxx
```

### Pipedrive Integration

```bash
export PIPEDRIVE_API_TOKEN="your-api-token"
export PIPEDRIVE_INSTANCE_URL="https://yourco.pipedrive.com"

# Sync PC opportunity status back to Pipedrive
python orchestrator_agent.py pipedrive-sync -o O15081741 -d 12345
```

### AWS Marketplace Catalog

```bash
# List offers (including private offers)
python orchestrator_agent.py marketplace-list -e Offer

# List SaaS products
python orchestrator_agent.py marketplace-list -e SaaSProduct

# Describe a specific entity
python orchestrator_agent.py marketplace-describe -e offer-abcdef123456
```

## API Usage

Start the server:
```bash
python server.py
```

### Endpoints

#### POST /api/generate
Generate next steps from inline notes.

```bash
curl -X POST http://localhost:8001/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "opportunity_id": "O15081741",
    "prompt": "Generate next steps",
    "notes": "Met with customer today. They want to migrate to AWS by Q3.",
    "update_opportunity": true
  }'
```

#### POST /api/generate-with-files
Generate with file uploads.

```bash
curl -X POST http://localhost:8001/api/generate-with-files \
  -F "opportunity_id=O15081741" \
  -F "prompt=Generate next steps from meeting notes" \
  -F "files=@sample_meeting_notes/demo_meeting_notes.txt" \
  -F "update_opportunity=true"
```

#### GET /api/opportunity/{id}
Fetch opportunity data.

```bash
curl http://localhost:8001/api/opportunity/O15081741
```

## Python API

```python
from orchestrator_agent import OrchestratorAgent

agent = OrchestratorAgent()

# Update next steps
result = agent.run(
    opportunity_id="O15081741",
    prompt="What should be our next steps?",
    slack_channels=["partner-deals"],
    local_folders=["./notes"],
    uploaded_files=["meeting.txt"],
    update_opportunity=True
)

print(f"Success: {result.success}")
print(f"Next Steps:\n{result.next_steps}")

# Create from HubSpot
agent = OrchestratorAgent(hubspot_token="pat-na2-xxxxx")
result = agent.create_opportunity_from_hubspot(deal_id="12345678901")

# Bi-directional sync
result = agent.sync_to_hubspot(
    opportunity_id="O15081741",
    hubspot_deal_id="12345678901"
)
```

## Configuration

### Config File

Uses `config.json` in the same directory, or specify with `--config`:

```json
{
  "catalog": "Sandbox",
  "region": "us-east-1",
  "endpoints": {
    "partnercentral_selling": "https://partnercentral-selling.us-east-1.api.aws",
    "partnercentral_mcp": "https://partnercentral-agents.us-east-1.api.aws/mcp"
  }
}
```

Set `catalog` to `"AWS"` for production or `"Sandbox"` for testing.

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `AWS_PROFILE` | AWS profile for Bedrock and Partner Central | If using named profiles |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) for channel access | Only for Slack |
| `HUBSPOT_BEARER_TOKEN` | HubSpot Personal Access Token | For HubSpot |
| `SALESFORCE_ACCESS_TOKEN` | Salesforce access token | For Salesforce |
| `SALESFORCE_INSTANCE_URL` | Salesforce instance URL | For Salesforce |
| `PIPEDRIVE_API_TOKEN` | Pipedrive API token | For Pipedrive |
| `PIPEDRIVE_INSTANCE_URL` | Pipedrive instance URL | For Pipedrive |
| `BEDROCK_MODEL_ID` | Pin a specific Bedrock Claude model ID; otherwise the first working model from a built-in candidate list is used | Optional |
| `PROCESS_CALL_ENABLED` | Enable the Demo UI "Process Call" flow (`true`/`1`/`yes`). Creates real CRM + ACE records, so it's off by default | Optional |

### Optional: Demo UI Authentication

The Demo UI (`demo_ui.py`) includes optional HTTP Basic Auth to password-protect the interface during workshops. It is controlled by the `demo_auth_enabled` field in `config.json`:

- `false` (default in this repo) — no login required
- `true` — prompts for username/password

Default credentials when enabled:
- **Username:** `pcagentday`
- **Password:** `pcagentday`

Override via environment variables:

```bash
export DEMO_AUTH_ENABLED=true
export DEMO_AUTH_USERNAME=myuser
export DEMO_AUTH_PASSWORD=mypass
```

### Optional: Process Call (Demo UI)

The **Process Call** tab in the Demo UI turns raw call/meeting notes into a co-sell opportunity in one flow. Because it creates **real** CRM deals and ACE opportunities, it is **disabled by default** and gated by the `process_call_enabled` field in `config.json`:

- `false` (default) — the tab returns `403` and no records are created
- `true` — the flow is active

Override via environment variable (takes precedence over `config.json`):

```bash
export PROCESS_CALL_ENABLED=true
python demo_ui.py
```

Requires `HUBSPOT_BEARER_TOKEN` (for the CRM deal step). Endpoint: `POST /api/process-call` on the Demo UI (port 8002), accepting call notes as text or an uploaded file, with an optional `submit_to_aws` flag.

### Optional: Slack Integration

Slack is an **optional context source**. The agent can read recent messages from a public Slack channel and feed them into the next-steps generator alongside (or instead of) uploaded files. Skip this if you're only using file uploads or CRM data.

> Enterprise workspaces (e.g., `amazon-slack`) typically require admin approval for app installation. Create a free [personal Slack workspace](https://slack.com/get-started) where you're the admin, or just skip Slack.

**Create a Slack bot token:**

1. Go to https://api.slack.com/apps → **Create New App → From scratch**. Pick a name and a workspace where you're an admin.
2. Go to **OAuth & Permissions** → under **Scopes → Bot Token Scopes**, add:
   - `channels:read` — list public channels and resolve names to IDs
   - `channels:history` — read messages in public channels
3. Click **Install to Workspace** and approve.
4. Copy the **Bot User OAuth Token** — **it must start with `xoxb-`**.
5. Invite the bot to target channels: `/invite @your-bot-name`

```bash
export SLACK_BOT_TOKEN="xoxb-YOUR-BOT-TOKEN-HERE"
python orchestrator_agent.py -o O15081741 -s partner-deals -p "Summarize recent discussions"
```

## Project Structure

```
├── config.json              # Configuration (catalog, endpoints)
├── orchestrator_agent.py    # Orchestrator coordination + CLI (re-exports the modules below)
├── context_sources.py       # Data models + Slack/file context readers
├── next_steps.py            # Next-steps generation via the Strands Agents SDK (Bedrock)
├── partner_central.py       # Partner Central MCP client + Marketplace Catalog client
├── server.py                # FastAPI REST server
├── demo_ui.py               # Flask web UI for demos
├── verify_setup.py          # Setup verification script
├── requirements.txt         # Python dependencies
├── crm/                     # CRM clients, adapters, and field mappers
│   ├── hubspot_client.py    # HubSpot REST client
│   ├── hubspot_adapter.py
│   ├── hubspot_mapper.py
│   ├── salesforce_client.py # Salesforce REST client
│   ├── salesforce_adapter.py
│   ├── salesforce_mapper.py
│   ├── pipedrive_client.py  # Pipedrive REST client
│   ├── pipedrive_adapter.py
│   ├── pipedrive_mapper.py
│   └── crm_registry.py
├── sample_meeting_notes/    # Sample context files for testing
├── static/                  # Web UI assets (CSS, JS)
├── templates/               # Web UI HTML templates
├── TESTING_GUIDE.md         # Step-by-step testing walkthrough
└── README.md                # This file
```

## How It Works

### Update Next Steps Flow
1. **Context Gathering**: Agent reads from specified sources (Slack, files, folders)
2. **Opportunity Fetch**: Gets current opportunity data from Partner Central
3. **AI Generation**: Claude (via the Strands Agents SDK on Amazon Bedrock) analyzes context and generates actionable next steps
4. **MCP Update**: Sends update request to Partner Central MCP Agent
5. **Approval Flow**: PC Agent requests human approval before writing
6. **Execution**: PC Agent calls Partner Central API to set NextSteps field

### MCP Communication Flow

```
1. Your Agent → PC Agent: "Update opportunity O123 with these next steps"
2. PC Agent → Your Agent: "Approval required" + tool_use_id
3. Your Agent → User: "Approve this update? [y/n]"
4. User → Your Agent: "y"
5. Your Agent → PC Agent: {decision: "approve", toolUseId: "..."}
6. PC Agent → Partner Central API: UpdateOpportunity(...)
7. PC Agent → Your Agent: "Update complete"
```

### CRM → ACE Flow
1. **Fetch Deal/Opportunity**: Gets data from CRM API (deal, company, contact)
2. **Map Fields**: Converts CRM fields to Partner Central opportunity format
3. **Create Opportunity**: Calls Partner Central Selling API to create the ACE opportunity

### Process Call Flow (Demo UI)
Turns raw call notes into a co-sell opportunity, agent-first:
1. **Extract Fields**: Claude (via Strands/Bedrock) pulls structured opportunity fields from the notes
2. **Create CRM Deal**: Creates a HubSpot deal + contact via API (the one step the PC Agent can't do)
3. **Agent Creates Opportunity**: The Partner Central Agent creates the ACE opportunity directly from the notes (create-only). A unique customer-name suffix is added per run to avoid AWS duplicate-opportunity rejection on repeat demos
4. **Optional Co-Sell Submit**: The agent submits that exact opportunity for co-sell; if the agent submit isn't reflected, it falls back to the Selling API `StartEngagementFromOpportunityTask`
5. **Verify**: Polls the opportunity's `ReviewStatus` until it leaves "Pending Submission"

> Gated by `process_call_enabled` / `PROCESS_CALL_ENABLED` (off by default) since it creates real records.

### Bi-directional Sync (ACE → CRM)
1. **Fetch PC Status**: Gets opportunity review status and stage from Partner Central
2. **Map Status**: Converts PC status to CRM stage/field values
3. **Update CRM**: Writes updated fields back to the CRM deal/opportunity

> **Note:** The Demo UI's "Sync from ACE" and "Reset Demo" buttons are available for HubSpot only. Salesforce and Pipedrive sync is available via the CLI (`salesforce-sync`, `pipedrive-sync` commands).

## HubSpot → ACE Field Mapping

| HubSpot Field | ACE Opportunity Field |
|---------------|----------------------|
| Deal Name | Project.Title |
| Amount | Project.ExpectedCustomerSpend.Amount |
| Close Date | LifeCycle.TargetCloseDate |
| Contact First Name | Customer.Contacts[0].FirstName |
| Contact Last Name | Customer.Contacts[0].LastName |
| Contact Email | Customer.Contacts[0].Email |
| Contact Phone | Customer.Contacts[0].Phone |
| Contact Job Title | Customer.Contacts[0].BusinessTitle |
| Deal ID | PartnerOpportunityIdentifier |

### Customizing the Data Mapper

The field mapping is defined in `crm/hubspot_mapper.py` (and equivalents for other CRMs). Key customization points:
- **Default values**: Modify `DEFAULT_*` class attributes for your organization
- **Field mappings**: Override `_map_*` methods to change how fields are transformed
- **Stage mapping**: Customize `_map_stage()` to match your CRM deal stages

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `{"message":"Missing Authentication Token"}` | SigV4-signed requests required. | Use `aws partnercentral-selling ...` or boto3. |
| `AccessDeniedException ... INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE` | Account not registered as partner in Sandbox. | Run `aws partnercentral-account create-partner ...` (see above). |
| `zsh: command not found: aws` | AWS CLI v2 not installed. | See [Prerequisites](#prerequisites). |
| `Unknown service: 'partnercentral-selling'` | boto3 version too old. | `pip install --upgrade boto3 botocore` (need 1.35.0+). |
| `AUTHENTICATION_FAILURE` from Partner Central | SigV4 creds expired or misconfigured. | Run `aws sts get-caller-identity`. Refresh creds. |
| Bedrock `AccessDeniedException` | IAM doesn't grant `bedrock:InvokeModel`, OR (for first-time Anthropic users) the one-time use-case form hasn't been submitted. | Confirm the IAM policy includes `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream` on the Claude ARNs. If it's a first-time use, open the Bedrock console **Model catalog** → an Anthropic Claude model → invoke once (or submit the use-case form when prompted). |
| Rate limit (`-32004`) from Partner Central | Too many requests. | `sendMessage` allows 2 req/min sustained. Add backoff logic. |
| NextSteps exceeds 255 chars | Field limit in Partner Central. | Ensure AI generates concise content under 255 characters. |
| `401 INVALID_SESSION_ID` from Salesforce | Access token expired (default 2h). | Refresh the Salesforce token. |

## Cleanup

```bash
# 1. Deactivate and remove the virtual environment
deactivate
rm -rf .venv

# 2. If you created an IAM user specifically for this project:
aws iam list-access-keys --user-name pcmcp-workshop-user
aws iam delete-access-key --user-name pcmcp-workshop-user --access-key-id AKIA_YOUR_KEY_ID

aws iam detach-user-policy \
  --user-name pcmcp-workshop-user \
  --policy-arn arn:aws:iam::aws:policy/AWSPartnerCentralSandboxFullAccess

aws iam delete-user-policy \
  --user-name pcmcp-workshop-user \
  --policy-name BedrockInvokeClaude

aws iam delete-user --user-name pcmcp-workshop-user
```

> The Sandbox partner registration can stay — it doesn't incur cost and is reusable.

## Additional Resources

- [Partner Central MCP Server — Overview](https://docs.aws.amazon.com/partner-central/latest/APIReference/partner-central-mcp-server.html)
- [Getting Started with Partner Central MCP](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)
- [Configuration Reference](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-configuration-reference.html)
- [Tools Reference](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-tools-reference.html)
- [AWSPartnerCentralSandboxFullAccess managed policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSPartnerCentralSandboxFullAccess.html)
- [Partner Central Sandbox testing guide](https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html)
- [Amazon Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) — Step-by-step testing instructions with expected outputs
