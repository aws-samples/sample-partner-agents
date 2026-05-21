# Agent-to-Agent Demo: CRM Integration with AWS Partner Central Agent

An AI orchestrator agent that communicates with the **AWS Partner Central Agent** to automate opportunity management, and integrates with CRM systems (HubSpot, Salesforce) to create ACE opportunities from deals.

## Why Agent-to-Agent?

This application demonstrates **agent-to-agent communication** - a pattern where one AI agent delegates specialized tasks to another AI agent rather than calling APIs directly.

```
┌─────────────────────────────────────────────────────────────────┐
│                YOUR ORCHESTRATOR AGENT                          │
│  (Custom agent you build and control)                           │
│                                                                 │
│  • Connects to CRM systems (HubSpot, Salesforce)                │
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
│  │  │ Channels │  │ Folders  │  │          │  │ (HubSpot/SFDC)   │    │   │
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

                              Data Flow
                              ─────────
    ┌──────────┐      ┌──────────────┐      ┌─────────────────────┐
    │  HubSpot │ ───► │ Data Mapper  │ ───► │ Partner Central API │
    │   Deal   │      │ (Field Map)  │      │ CreateOpportunity   │
    └──────────┘      └──────────────┘      └─────────────────────┘
                                                      │
                                                      ▼
    ┌──────────┐      ┌──────────────┐      ┌─────────────────────┐
    │ Meeting  │ ───► │ Bedrock AI   │ ───► │ PC MCP Agent        │
    │  Notes   │      │ (Analysis)   │      │ UpdateOpportunity   │
    └──────────┘      └──────────────┘      └─────────────────────┘
```

## Features

- **Slack Integration**: Read messages from specified channels
- **Local File Reader**: Scan folders for relevant documents  
- **File Upload**: Accept uploaded files for context
- **AI-Powered Generation**: Use Claude (Bedrock or API) to create actionable next steps
- **MCP Integration**: Update Partner Central opportunities automatically
- **HubSpot Integration**: Create ACE opportunities from HubSpot deals

## Prerequisites

1. **Python 3.10+**
2. **AWS CLI v2** — required for running the setup commands below.
   - macOS: download [AWSCLIV2.pkg](https://awscli.amazonaws.com/AWSCLIV2.pkg) and install, or `brew install awscli` if you have Homebrew
   - Linux: see [AWS CLI install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
   - Verify: `aws --version` should report `aws-cli/2.x.x`
3. **AWS credentials configured** — run `aws configure` or set up SSO. Verify with `aws sts get-caller-identity`.

   <details>
   <summary>First time? Click here for IAM user + access key setup</summary>

   If you don't already have an IAM user and access keys, your cloud admin (or you, if you admin your own account) can set them up with the commands below. **Use an IAM user only for this local workshop** — for production or shared accounts, prefer IAM Identity Center (SSO) or an assumable role.

   ```bash
   # 1. Create the IAM user
   aws iam create-user --user-name pcmcp-workshop-user

   # 2. Attach Partner Central access (covers CreateOpportunity + MCP session)
   aws iam attach-user-policy \
     --user-name pcmcp-workshop-user \
     --policy-arn arn:aws:iam::aws:policy/AWSPartnerCentralSandboxFullAccess

   # 3. Attach inline Bedrock policy
   aws iam put-user-policy \
     --user-name pcmcp-workshop-user \
     --policy-name BedrockInvokeClaude \
     --policy-document '{
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:*:inference-profile/*"]
       }]
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

   > ⚠️ **Never commit access keys to git.** If one leaks, rotate immediately with `aws iam delete-access-key --user-name pcmcp-workshop-user --access-key-id AKIA...` and create a new one.

   For the Console-based walkthrough and more detail, see the workshop's [Step 1c: Create an IAM User and Configure Credentials](./Agent_to_Agent_Partner_Central_Workshop.md#1c-create-an-iam-user-and-configure-credentials).

   </details>
4. **Amazon Bedrock model access** enabled in `us-east-1` for Claude models
5. **boto3 1.35.0+** — required for the `partnercentral-selling` client
6. **IAM policy** — attach `AWSPartnerCentralSandboxFullAccess` to your IAM identity (covers both `CreateOpportunity` and MCP session management). See the workshop's [Step 1b](./Agent_to_Agent_Partner_Central_Workshop.md#1b-partner-central-access) for alternatives.

> ⚠️ **Don't try to `curl` the Partner Central API directly.** All Partner Central and Partner Central Account endpoints require AWS SigV4–signed requests. A plain `curl` call returns `{"message":"Missing Authentication Token"}`. Use the AWS CLI or the Python SDK (boto3), both of which sign for you.

## Quick Start

```bash
cd agent-to-agent

# Install dependencies
pip install -r requirements.txt

# Option 1: Run Demo UI (recommended for demos)
python demo_ui.py
# Open http://localhost:8002 in your browser

# Option 2: CLI - Update opportunity next steps
python orchestrator_agent.py \
  --opportunity-id O15081741 \
  --upload ../notes/meeting.txt \
  --prompt "Generate next steps based on meeting notes"

# Option 3: CLI - Create ACE opportunity from HubSpot deal
export HUBSPOT_BEARER_TOKEN="pat-na2-xxxxx"
python orchestrator_agent.py hubspot-create -d 12345678901

# Option 4: Run as API server
python server.py
# API available at http://localhost:8001
```

## CLI Usage

### Update Opportunity Next Steps

```bash
# Basic usage with uploaded file
python orchestrator_agent.py -o O15081741 -u meeting_notes.txt -p "What are the next steps?"

# With Slack channel
python orchestrator_agent.py -o O15081741 -s partner-deals -p "Summarize recent discussions"

# With local folder
python orchestrator_agent.py -o O15081741 -f ./deal-notes -p "Generate action items"

# Dry run (don't update opportunity)
python orchestrator_agent.py -o O15081741 -u notes.txt --dry-run

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

Create ACE opportunities directly from HubSpot deals:

```bash
# Set your HubSpot bearer token
export HUBSPOT_BEARER_TOKEN="pat-na2-xxxxx-xxxxx"

# List recent HubSpot deals
python orchestrator_agent.py hubspot-list
python orchestrator_agent.py hubspot-list --limit 20

# Create ACE opportunity from a HubSpot deal
python orchestrator_agent.py hubspot-create -d 12345678901

# With custom project title
python orchestrator_agent.py hubspot-create -d 12345678901 -t "Custom Project Title"

# Pass token directly (instead of env var)
python orchestrator_agent.py hubspot-create -d 12345678901 --hubspot-token "pat-na2-xxxxx"
```

#### HubSpot → ACE Field Mapping

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

Note: Company name is auto-generated as `ValidAWSCreate-{timestamp}` to ensure uniqueness in Partner Central.

#### Customizing the Data Mapper

The HubSpot to Partner Central field mapping is defined in `hubspot_mapper.py`. This file is designed to be customized for your specific HubSpot field structure and business requirements.

Key customization points:
- **Default values**: Modify `DEFAULT_*` class attributes for your organization
- **Field mappings**: Override `_map_*` methods to change how fields are transformed
- **Stage mapping**: Customize `_map_stage()` to match your HubSpot deal stages
- **Business problem**: Customize `_map_business_problem()` to extract from your custom fields

Example customization:
```python
from hubspot_mapper import HubSpotToPartnerCentralMapper

class MyCustomMapper(HubSpotToPartnerCentralMapper):
    DEFAULT_INDUSTRY = "Financial Services"
    DEFAULT_COUNTRY_CODE = "GB"
    
    def _map_business_problem(self, deal):
        # Use custom HubSpot field
        return deal.properties.get('custom_problem_field', 'Default problem')
```

### Bi-directional Sync: Partner Central → HubSpot

When a Partner Central opportunity is updated (e.g., new next steps from the agent), you can sync the latest values back to the corresponding HubSpot deal:

```bash
# Sync PC opportunity to HubSpot deal
python orchestrator_agent.py hubspot-sync -o O15081741 -d 12345678901

# With explicit token
python orchestrator_agent.py hubspot-sync -o O15081741 -d 12345678901 --hubspot-token "pat-na2-xxxxx"
```

#### What Gets Synced

By default, **only the `hs_next_step` field** (HubSpot's built-in Next Step property) is synced from the Partner Central `LifeCycle.NextSteps` field. This minimal sync is intentional:

- `hs_next_step` is a built-in HubSpot Deal property available on every portal
- It accepts free-form text up to 500 characters
- Avoids 400 errors from portals that use custom pipelines, validation rules, or non-default stage IDs

#### Optional: Sync HubSpot Deal Stage

If you want to also sync the deal stage (off by default), call `map_opportunity_to_deal_update(opportunity, sync_stage=True)`. The mapping logic uses Partner Central `ReviewStatus` and `Stage` to derive a HubSpot stage ID from the **default sales pipeline** — customize `_map_to_hubspot_stage()` if your portal uses different stage IDs.

| PC Review Status | HubSpot Deal Stage |
|------------------|-------------------|
| Pending Submission | appointmentscheduled |
| Submitted | qualifiedtobuy |
| In Review | qualifiedtobuy |
| Action Required | qualifiedtobuy |
| Approved | presentationscheduled |
| Rejected | closedlost |

| PC Stage (when Approved) | HubSpot Deal Stage |
|--------------------------|-------------------|
| Prospect | appointmentscheduled |
| Qualified | qualifiedtobuy |
| Technical Validation | presentationscheduled |
| Business Validation | decisionmakerboughtin |
| Committed | contractsent |
| Launched | closedwon |
| Closed Lost | closedlost |

#### Programmatic Sync

```python
from orchestrator_agent import OrchestratorAgent

agent = OrchestratorAgent(hubspot_token="pat-na2-xxxxx")

# Sync next steps to HubSpot
result = agent.sync_to_hubspot(
    opportunity_id="O15081741",
    hubspot_deal_id="12345678901"
)

if result["success"]:
    print(f"Synced! Next steps written to hs_next_step field")
```

### AWS Marketplace Catalog Queries

The orchestrator includes read-only access to the AWS Marketplace Catalog API, allowing you to query offers (including private offers), products, and other Marketplace entities.

**Required IAM permissions:**
```json
{
    "Effect": "Allow",
    "Action": [
        "aws-marketplace:DescribeEntity",
        "aws-marketplace:ListEntities"
    ],
    "Resource": "*"
}
```

Or attach the managed policy: `AWSMarketplaceSellerProductsReadOnly`

**CLI usage:**
```bash
# List offers (including private offers)
python orchestrator_agent.py marketplace-list -e Offer

# List SaaS products
python orchestrator_agent.py marketplace-list -e SaaSProduct

# List AMI products
python orchestrator_agent.py marketplace-list -e AmiProduct --limit 20

# Describe a specific entity (offer, product, etc.)
python orchestrator_agent.py marketplace-describe -e offer-abcdef123456
```

**Programmatic usage:**
```python
from orchestrator_agent import OrchestratorAgent

agent = OrchestratorAgent()

# List all offers
offers = agent.list_marketplace_offers(max_results=10)
for offer in offers['entities']:
    print(f"{offer['Name']} ({offer['EntityId']})")

# Describe a specific private offer
details = agent.describe_marketplace_entity("offer-abcdef123456")
print(details['details'])
```

## API Usage

Start the server:
```bash
python server.py
```

### Endpoints

#### POST /api/generate
Generate next steps from context sources.

```bash
curl -X POST http://localhost:8001/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "opportunity_id": "O15081741",
    "prompt": "Generate next steps",
    "slack_channels": ["partner-deals"],
    "update_opportunity": true
  }'
```

#### POST /api/generate-with-files
Generate with file uploads.

```bash
curl -X POST http://localhost:8001/api/generate-with-files \
  -F "opportunity_id=O15081741" \
  -F "prompt=Generate next steps from meeting notes" \
  -F "files=@meeting_notes.txt" \
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
print(f"MCP Response: {result.mcp_response}")
```

## Configuration

### Register as an AWS Partner in Sandbox

Before you can call any Partner Central API (including `list-opportunities`, `get-opportunity`, `CreateOpportunity`, or the MCP `sendMessage` tool), your AWS account must be registered as a partner in the **Sandbox catalog**. Skipping this step causes `AccessDeniedException ... INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE` on every Partner Central call.

> 🔑 **Required permission: `partnercentral:CreatePartner`** (Account API, not Selling API). The managed policy `AWSPartnerCentralSandboxFullAccess` recommended in [Prerequisites](#prerequisites) covers it. If you built a custom policy, also add `partnercentral:CreatePartner`, `partnercentral:GetPartner`, and `partnercentral:SendEmailVerificationCode`.

Use the AWS CLI (v2) so the request is automatically SigV4-signed:

```bash
aws partnercentral-account create-partner \
  --region us-east-1 \
  --catalog Sandbox \
  --client-token "unique-token-12345" \
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
- For the Sandbox catalog, **no actual email verification is required** — any 6-digit value for `--email-verification-code` will work (e.g. `123456`).
- `--client-token` must be unique per call. If you re-run, change the value.
- If you prefer to call the API with `curl`, you must manually sign the request with AWS SigV4 (service: `partnercentral-account`, region: `us-east-1`). The CLI above does this for you.

#### Verify registration

After `create-partner` succeeds, confirm your account is registered by listing opportunities:

```bash
aws partnercentral-selling list-opportunities \
  --catalog Sandbox \
  --region us-east-1
```

An empty list is a valid response — it just means no opportunities exist yet. What matters is that you **don't** get `INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE`.

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SLACK_BOT_TOKEN` | Slack API token for channel access | For Slack |
| `AWS_PROFILE` | AWS profile for Bedrock and Partner Central | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key (if not using Bedrock) | Alternative |
| `HUBSPOT_BEARER_TOKEN` | HubSpot Personal Access Token | For HubSpot |

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

### Optional: Slack Integration

Slack is an **optional context source**. The agent can read recent messages from a public Slack channel and feed them into the next-steps generator alongside (or instead of) uploaded files.

**When to set this up:** only if you want to try the `--slack-channel` CLI flag. Skip it otherwise — the core workflow works fine with just uploaded files or CRM data.

> 🏢 **Heads up for enterprise workspaces:** the `amazon-slack` workspace (and most enterprise Slack workspaces) require admin approval to install apps. If you see *"Request to workspace install submitted"*, you're stuck waiting on an admin. Create a free [personal Slack workspace](https://slack.com/get-started) where you're the admin — installs go through immediately. Or just skip Slack; it's optional.

**Create a Slack bot token:**

Slack's official docs are the authoritative reference but have been reshuffled to push their CLI tooling. The dashboard-based flow below matches [Basic app setup](https://api.slack.com/authentication/basics) and [Bot Token Scopes in Classic vs. Modern Apps](https://api.slack.com/authentication/quickstart). If any step drifts from Slack's current UI, defer to their docs.

1. Go to https://api.slack.com/apps and click **Create New App → From scratch**. Pick a name and a workspace where you're an admin.
2. In your app, go to **OAuth & Permissions** → under **Scopes → Bot Token Scopes**, add:
   - `channels:read` — list public channels and resolve names to IDs
   - `channels:history` — read messages in public channels
3. On the same page, click **Install to Workspace** and approve.
4. Copy the **Bot User OAuth Token** that appears — **it must start with `xoxb-`**.
5. Invite the bot to the channel(s) you want it to read: `/invite @your-bot-name` inside the target channel.

> 🔑 **Token format matters.** You need a **`xoxb-...`** bot token. These won't work:
> - `xapp-...` (App-Level Token, Socket Mode only)
> - `xoxp-...` (User OAuth Token)
> - `xoxe.xoxp-...` (Slack CLI session, from `~/.slack/credentials.json`)
>
> See [Slack's token-types reference](https://api.slack.com/concepts/token-types) for the full breakdown.
>
> If asked for a **Redirect URL**, leave it blank or use `https://localhost` — it's not used by this integration.

**Use it:**

```bash
export SLACK_BOT_TOKEN="xoxb-YOUR-BOT-TOKEN-HERE"

python orchestrator_agent.py \
  --opportunity-id O15081741 \
  --slack-channel partner-deals \
  --prompt "Summarize recent discussions"
```

If `slack_sdk` isn't installed (it's listed as optional in `requirements.txt`), the agent logs a warning and continues without Slack context.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `{"message":"Missing Authentication Token"}` from a raw `curl` to Partner Central | Partner Central APIs require SigV4-signed requests. Plain `curl` doesn't sign. | Use `aws partnercentral-selling ...` / `aws partnercentral-account ...` CLI, or boto3. Both sign automatically. |
| `AccessDeniedException ... INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE` from any Partner Central call | Your AWS account isn't registered as a partner in the Sandbox catalog yet. | Run `aws partnercentral-account create-partner ...` from the [Register as an AWS Partner in Sandbox](#register-as-an-aws-partner-in-sandbox) section. |
| `AccessDeniedException` on `CreateOpportunity` from HubSpot/Salesforce flow | IAM policy is missing `partnercentral:CreateOpportunity`. | Attach `AWSPartnerCentralSandboxFullAccess` (recommended). See [Prerequisites](#prerequisites). |
| `zsh: command not found: aws` | AWS CLI v2 not installed. | Install from https://awscli.amazonaws.com/AWSCLIV2.pkg (macOS) or see [Prerequisites](#prerequisites). |
| `Invalid choice: 'get-email-verification-code'. Maybe you meant: send-email-verification-code` | Outdated command name. | Use `send-email-verification-code` (or skip it entirely for Sandbox — any 6-digit code works). |
| `zsh: command not found: --catalog` | Missing line-continuation backslash (`\`) on the previous CLI line. | Make sure every line except the last ends with a trailing `\ `. |
| `Unknown service: 'partnercentral-selling'` | boto3 version too old. | `pip install --upgrade boto3 botocore` (need 1.35.0+). |
| Bedrock `AccessDeniedException` | Claude model not enabled in `us-east-1`. | Enable model access in the Bedrock console for your region. |
| `401 INVALID_SESSION_ID` from Salesforce | Salesforce access token expired (default 2h). | Rerun `sf org display --target-org mydev` and paste the new token. |

## How It Works

### Update Next Steps Flow
1. **Context Gathering**: Agent reads from specified sources (Slack, files, folders)
2. **Opportunity Fetch**: Gets current opportunity data from Partner Central
3. **AI Generation**: Claude analyzes context and generates actionable next steps
4. **MCP Update**: Sends update request to Partner Central MCP to set NextSteps field

### HubSpot → ACE Flow
1. **Fetch Deal**: Gets deal data from HubSpot API (deal, company, contact)
2. **Map Fields**: Converts HubSpot deal fields to Partner Central opportunity format
3. **Create Opportunity**: Calls Partner Central Selling API to create the ACE opportunity

## Supported File Types

- `.txt` - Plain text
- `.md` - Markdown
- `.json` - JSON data
- `.csv` - CSV data
- `.log` - Log files
- `.yaml/.yml` - YAML config
