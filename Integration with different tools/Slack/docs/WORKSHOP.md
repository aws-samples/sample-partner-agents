# Workshop — Deploy the Partner Central Agent Slack bot

A self-paced workshop. Plan for 60–90 minutes. By the end you'll have a working Slack bot in your own workspace that talks to the AWS Partner Central Agent in your own AWS account.

---

<!--
LLM-CONTEXT-BLOCK (read this if you're an AI assistant helping a workshop participant)

Project: Slack bot that bridges Slack → AWS Partner Central Agent (MCP) for partner managers to query opportunities, request updates, and approve writes from chat.

Architecture (high level):
  Slack → API Gateway → Lambda (3s ack) → self-invokes Lambda async → Partner Central MCP server
  - DynamoDB: thread session map + dedupe (TTL 48h)
  - Secrets Manager: Slack bot token + signing secret
  - All resource names derive from STACK_NAME_PREFIX (default slack-pc-bot)
  - Catalog is hardcoded to Sandbox unless explicitly opted into AWS production

Key files participants might ask about:
  README.md                              — operational reference
  docs/DEPLOYMENT.md                     — verbose install + Slack walkthrough
  docs/WORKSHOP.md                       — this guide
  deployment/setup.sh                    — main deploy script (AWS profile picker, CFN deploy, secret prompt, partner check)
  deployment/cloudformation.yaml         — CFN template (parameterized via StackNamePrefix)
  deployment/slack-manifest.yaml         — Slack app definition (5 places need YOUR_API_GATEWAY_URL substituted)
  deployment/register-sandbox-partner.sh — creates a Partner Central sandbox partner record (Account API)
  src/handlers/{commands,events,actions}.js — Bolt handlers
  src/services/jobProcessor.js           — main MCP request flow
  src/services/streamProcessor.js        — SSE streaming to Slack
  src/services/secretsLoader.js          — pulls bot token + signing secret on cold start

Common workshop failures and the fix:
  "Invalid choice: 'partnercentral-account'"          → AWS CLI < 2.32.11. Upgrade.
  "aws: command not found" after brew install         → Homebrew bin not on PATH (see Lab 1 macOS).
  Slack /pc-opps stays on "Fetching opportunities..." → bot not in channel. Run /invite @Partner Central Bot.
  Slack returns dispatch_unknown_error                → manifest URL substitution missed; check all 5 places.
  Slash command does nothing (no logs)                → signature verification failed; secret has placeholders. Run Lab 4 step 3.
  /pc-opps returns empty list                         → no sandbox opportunities exist. See Lab 6 step B.
  CFN says CATALOG=AWS requires acknowledgment         → don't use Catalog=AWS for the workshop. Stick with Sandbox.

Calling conventions to know:
  - All AWS CLI commands take --profile <name> --region us-east-1 unless AWS_PROFILE is exported.
  - The bot's Lambda function is named ${STACK_NAME_PREFIX}-bot. Default: slack-pc-bot-bot.
  - Logs: aws logs tail /aws/lambda/${STACK_NAME_PREFIX}-bot --since 15m --follow
  - Sandbox partner registration is a one-time per-AWS-account action. Re-running is idempotent.

When helping a participant:
  - First ask them which lab they're stuck on and what command they ran.
  - Match their error against the table above before guessing.
  - Don't tell them to use Catalog=AWS — the workshop is sandbox-only.
  - Don't suggest editing the CFN template directly; STACK_NAME_PREFIX is the right knob.
END LLM-CONTEXT-BLOCK
-->

## What you'll build

A Slack bot that:
- Lists open opportunities with `/pc-opps`
- Answers freeform Partner Central questions with `/pc <question>`
- Proposes opportunity updates with an Approve / Reject / Override card

You'll deploy it to your own AWS account, install it in a Slack workspace you control, and exercise the full flow end-to-end.

## Prerequisites checklist

Tick these off before starting. Each is covered in detail in the Labs below.

- [ ] An AWS account where you have admin access (your work account or a personal AWS account is fine)
- [ ] A Slack workspace where you're a workspace admin
- [ ] AWS CLI v2.32.11 or newer installed
- [ ] Node.js 20+ installed
- [ ] Git installed
- [ ] About 1 GB of free disk for npm dependencies and the deployment package

If you don't have a Slack workspace, create a free one at https://slack.com/get-started — the free tier is enough for the workshop. Create a fresh workspace dedicated to this workshop so you don't pollute a real one.

> **Watch out for the paid-plan upsell.** Slack's signup flow ends with a "Choose your plan" screen that defaults to a paid trial. Look for the link at the bottom — usually phrased *"Not ready for a paid subscription? Try the limited version of Slack for free"* — and click it. The free plan is enough for this workshop.

---

## Lab 0 — Get AWS credentials on your laptop

**Goal:** Be able to run `aws sts get-caller-identity` from your terminal and see your account ID.

If `aws sts get-caller-identity --profile <yours>` already prints your account ID, skip to Lab 1.

### Option A — your own AWS account (personal or company-managed)

1. AWS Console → IAM → Users → your user → **Security credentials** → **Create access key** → choose "Command Line Interface (CLI)"
2. Copy the Access Key ID and Secret Access Key (the secret is shown once)
3. Configure the profile:
   ```bash
   aws configure --profile pc-workshop
   ```
   Paste the keys when prompted. Region: `us-east-1`. Output: `json`.

### Option B — AWS IAM Identity Center (SSO)

```bash
aws configure sso --profile pc-workshop
```
Follow the browser prompts. Pick `us-east-1` as the region.

### Verify

```bash
aws sts get-caller-identity --profile pc-workshop
```
You should see something like:
```json
{
  "UserId": "AIDA...",
  "Account": "123456789012",
  "Arn": "arn:aws:iam::123456789012:user/your-name"
}
```

**Make this profile the session default** for the remaining labs (saves you from typing `--profile` everywhere):
```bash
export AWS_PROFILE=pc-workshop
```

---

## Lab 1 — Install tooling

**Goal:** `aws --version` reports 2.32.11+, `node --version` reports 20+, `git --version` works.

### macOS

```bash
brew install awscli node git
```

If `aws --version` still shows an old version after install:
```bash
# Apple Silicon
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
# Intel
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zshrc
```
Then **open a new terminal** for the change to take effect.

### Windows

> The deploy scripts are bash. Run them from **Git Bash** (bundled with Git for Windows) or from WSL. Native PowerShell isn't supported.

In an Administrator PowerShell:
```powershell
winget install Amazon.AWSCLI
winget install OpenJS.NodeJS
winget install Git.Git
```
After install, **open a new Git Bash terminal**. From here the rest of the workshop uses Git Bash.

### Verify

```bash
aws --version    # need 2.32.11+
node --version   # need v20+
git --version    # any recent version
```

If `aws --version` is below 2.32.11, upgrade:
```bash
brew upgrade awscli              # macOS
winget upgrade Amazon.AWSCLI     # Windows
```

The Partner Central API the bot uses landed in 2.32.11. Older CLIs will fail later with `Invalid choice: 'partnercentral-account'`.

---

## Lab 2 — Get the code

```bash
git clone git@github.com:aws-samples/sample-partner-agents.git
cd "sample-partner-agents/Integration with different tools/Slack"
```

If you don't have SSH set up for GitHub, use HTTPS instead:
```bash
git clone https://github.com/aws-samples/sample-partner-agents.git
cd "sample-partner-agents/Integration with different tools/Slack"
```

Take 2 minutes to skim the top of `README.md` so you know what's in the repo.

---

## Lab 3 — Deploy the AWS stack

**Goal:** A working Lambda + API Gateway + DynamoDB + Secrets Manager stack in your AWS account.

> **Sharing an account with someone else?** All resources are named `slack-pc-bot-*` by default. If a teammate has already deployed in the same AWS account, set a unique prefix before running setup.sh:
> ```bash
> export STACK_NAME_PREFIX=slack-pc-bot-<your-name>
> ```
> Each prefix produces a fully isolated stack — separate Lambda, DynamoDB, Secret, API Gateway, and IAM role. Use the same prefix everywhere in the workshop.

```bash
cd deployment
./setup.sh
```

What the script does:
1. Lets you pick the AWS profile (if you didn't `export AWS_PROFILE`)
2. If a stack with the same name already exists, asks whether to update it
3. Packages `lambda.js` and `src/` into a zip with production dependencies
4. Creates an S3 bucket for the deploy artifact
5. Deploys the CloudFormation stack `slack-pc-bot`
6. Prints the exact command you'll run in Lab 4 to populate Slack credentials
7. Checks whether you have a sandbox partner registered (Lab 5)

When the script finishes, you'll see something like:

```
Step 1 — Create the Slack app (required, manual):
  ...
  YOUR_API_GATEWAY_URL with:
    https://abc123def4.execute-api.us-east-1.amazonaws.com/prod/slack/events
  ...

Step 2 — Populate Slack credentials in Secrets Manager:

  After you finish creating the Slack app in Step 1, copy the Bot User OAuth
  Token (xoxb-...) and the Signing Secret from the Slack app dashboard, then
  run this command to populate the secret:

    aws secretsmanager put-secret-value ...
```

**Don't run that command yet** — you don't have the tokens. You'll come back to it after Lab 4. Copy the Events URL though; you'll need it next.

**If the script fails:** see the Troubleshooting section at the bottom of this doc.


---

## Lab 4 — Create and install the Slack app

**Goal:** A bot user named "Partner Central Bot" installed in your Slack workspace, with credentials populated in Secrets Manager.

### Step 1: Create the app from the manifest

#### 1a. Get your Events URL

You need the Slack Events URL from your CloudFormation stack. It looks like `https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/slack/events`. Two ways to find it:

**Easy — from the terminal:** It was printed at the end of `setup.sh` output in Lab 3. Scroll up in your terminal for "Events URL: ..." or look at the table at the bottom under `SlackEventsUrl`.

**If you closed the terminal — from the CloudFormation console:**
1. AWS Console → CloudFormation → Stacks → click your stack (default name `slack-pc-bot`, or whatever you set `STACK_NAME_PREFIX` to)
2. **Outputs** tab → copy the value next to `SlackEventsUrl`

**Or from the CLI:**
```bash
aws cloudformation describe-stacks \
  --stack-name slack-pc-bot \
  --query 'Stacks[0].Outputs[?OutputKey==`SlackEventsUrl`].OutputValue' \
  --output text \
  --profile <your-profile> --region us-east-1
```

(Use your prefix instead of `slack-pc-bot` if you set one.) Copy this URL — you'll paste it into the manifest in the next step.

#### 1b. Create the app from the manifest

You'll paste the manifest YAML into Slack's web form, then **edit it in place** to substitute your URL. No need to modify the file on disk.

1. Go to https://api.slack.com/apps and click **Create an App** → **From a manifest**

2. **Pick your workshop Slack workspace** in the dropdown. (Make sure it's the new test workspace, not an existing one.)

3. Switch the format toggle from **JSON** to **YAML**.

4. **Open `deployment/slack-manifest.yaml` in your editor**, copy the entire contents, and paste them into the Slack form. The form has a YAML text editor — keep this tab open, you'll edit here.

5. **In the Slack form's text area** (not on disk), use Cmd-F / Ctrl-F (or the editor's find tool) to find every occurrence of `YOUR_API_GATEWAY_URL`. Replace each one with your Events URL from step 1a. There should be **5 occurrences**:
   - `event_subscriptions.request_url`
   - `interactivity.request_url`
   - `slash_commands` for `/pc` → `url`
   - `slash_commands` for `/pc-opps` → `url`
   - `slash_commands` for `/pc-session` → `url`

   Sanity-check: search the form for `YOUR_API_GATEWAY_URL` after replacing — there should be zero matches left. If even one remains, that command will fail with `dispatch_unknown_error` in Slack later.

6. Click **Next** at the bottom of the form. Slack will show a summary of permissions, scopes, and slash commands. Click **Create**.

### Step 2: Install the app to your workspace

In the app settings page, sidebar → **Settings → Install App** → click **Install to &lt;your-workspace&gt;** → **Allow**.

### Step 3: Copy the Slack credentials

You need two values:

**Bot User OAuth Token** (`xoxb-...`)
- Sidebar → **Features → OAuth & Permissions**
- Top of page, under "OAuth Tokens" → copy the **Bot User OAuth Token**

**Signing Secret**
- Sidebar → **Settings → Basic Information**
- Scroll to "App Credentials" → next to "Signing Secret" click **Show** → copy the value

### Step 4: Populate the Secrets Manager secret

Copy the below command — substitute your prefix if you set one, and your profile name:

```bash
aws secretsmanager put-secret-value \
  --secret-id slack-pc-bot-slack-credentials \
  --secret-string '{"SLACK_BOT_TOKEN":"xoxb-PASTE","SLACK_SIGNING_SECRET":"PASTE"}' \
  --profile <your-profile> --region us-east-1
```

> **If you set `STACK_NAME_PREFIX`**, replace `slack-pc-bot-slack-credentials` with `<your-prefix>-slack-credentials`. You can confirm the exact secret name from the CloudFormation **Outputs** tab (look for `SlackSecretName`).

### Step 5: Force the Lambda to pick up the new secret

The Lambda caches the secret on cold start. Touch the function so the next invocation reads the new values:
```bash
aws lambda update-function-configuration \
  --function-name slack-pc-bot-bot \
  --description "credentials populated $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --profile <your-profile> --region us-east-1
```

> Same prefix substitution as Step 4: if you used a custom `STACK_NAME_PREFIX`, the function name is `<your-prefix>-bot` (it's in the CFN output `LambdaFunctionName`).

### Verify

```bash
aws lambda invoke \
  --function-name slack-pc-bot-bot \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' /tmp/out.json --log-type Tail \
  --query LogResult --output text \
  --profile <your-profile> --region us-east-1 | base64 --decode | grep '\[Secrets\]'
```

You should see:
```
[Secrets] Loaded Slack credentials from arn:aws:secretsmanager:...
```

If you see `Secret slack-pc-bot-slack-credentials is missing SLACK_BOT_TOKEN` instead, your secret value isn't valid JSON or has placeholder values. Re-run step 4.

---

## Lab 5 — Register a sandbox partner

**Goal:** Your AWS account is registered as a partner in the Partner Central **Sandbox** catalog so the bot has data to query.

> Background: AWS Partner Central separates Sandbox and Production catalogs. The bot is hardcoded to Sandbox. Your AWS account is not auto-enrolled — you have to call CreatePartner once. See the [AWS doc on sandbox testing](https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html) for the underlying API contract.

### Step 1: Check if you already have one

```bash
aws partnercentral-account list-partners \
  --catalog Sandbox --region us-east-1 \
  --profile <your-profile>
```

- Empty `PartnerSummaryList` → continue to Step 2
- Has an entry → skip Step 2, you're already registered

### Step 2: Register a sandbox partner

```bash
./deployment/register-sandbox-partner.sh \
  --legal-name "Workshop Sandbox <your-name>" \
  --first-name "Your" --last-name "Name" \
  --email "you@example.com" \
  --business-title "Alliance Lead" \
  --profile <your-profile>
```

Replace the values with your details. **`--legal-name` must be unique across all sandbox partners**, so include something distinctive like your name or your team.

The script:
1. Calls `partnercentral-account create-partner` with `Catalog=Sandbox`
2. Calls `start-profile-update-task` to round out the partner profile
3. Prints the new `partner-xxxxxxxxxxxx` ID and a summary

### Verify

```bash
aws partnercentral-account list-partners --catalog Sandbox --region us-east-1 --profile <your-profile>
```
Should now return a `PartnerSummaryList` with one entry matching your legal name.

> If the AWS Console nags you to "Register as an AWS Partner" when you open Partner Central, that's the **production** APN registration flow. Ignore it. The sandbox flow is the script you just ran.

---

## Lab 6 — Test the bot in Slack

**Goal:** Send a Slack message and see a real response from the Partner Central Agent.

### Invite the bot to a channel

In your Slack workspace, pick or create a channel for the workshop. Invite the bot:
```
/invite @Partner Central Bot
```

(DMs to the bot work without an invite. But channel testing exercises the full path.)

### A) Quick smoke test

```
/pc-session
```
Expected reply: an ephemeral message saying "No active session for this thread." That confirms the slash command path is working end-to-end.

```
/pc-opps
```
On a freshly-registered sandbox partner this returns an empty list. That's expected. Now create some data.

### B) Create your first opportunity through the bot

In the same channel, paste this prompt to the bot. It's deliberately rich — the agent extracts most fields directly and only needs minor clarification on enum values.

```
@Partner Central Bot create a new opportunity:

Customer: Acme Cloud 01 Solutions, located in US, California, zip 94016, website https://acme-cloud.example.com, in the Software & Internet industry.

Project: "Acme data warehouse migration" — Acme is running a 12-year-old on-prem data warehouse that fails monthly and blocks quarterly reporting. They want to migrate to AWS analytics services for reliability and scale.

Solution: S-0066098
Opportunity type: Net New Business
Sales activities: submitted partner registration form, conducted technical workshop
Delivery model: SaaS or PaaS
Use case: Migration
Expected value: $17,000
Target close date: 2026-09-30
Marketing development funds (MDF): No
Co-sell with AWS: yes, Full
```

What you'll see, in order:

1. **`Asking Partner Central...`** ephemeral reply — your slash ack
2. The bot **thinks for ~5–15 seconds** (real MCP call streaming)
3. The bot may **ask a clarification question**, e.g. mapping "technical workshop" to one of the predefined Sales Activity enums (`Conducted POC / Demo`, `Initialized discussions with customer`, etc.). Reply in-thread with `yes` or pick one.
4. An **Approval card** appears with a JSON payload showing all extracted fields. Review it.
5. Click **Approve**.
6. The agent calls CreateOpportunity. If validation fails on a field format, the agent retries automatically with a corrected payload (you'll see another approval card — approve it too).
7. Final confirmation: `Opportunity ID: O##########` with a console link.

Now retry `/pc-opps` — your new opportunity should appear in the list.

> **Heads up:** the agent infers some defaults (e.g. "Monthly" frequency on the spend amount). If you want a one-time spend, say "$17,000 one-time" or "$17,000 total contract value" in the prompt.

### B fallback — manually create an opportunity via the CLI

If the agent gets stuck or you want to seed data deterministically:

If the agent gets confused or you want to seed data deterministically:
```bash
aws partnercentral-selling create-opportunity \
  --catalog Sandbox \
  --client-token "workshop-$(date +%s)" \
  --primary-needs-from-aws "Co-Sell-with-AWS" \
  --opportunity-type "New Opportunity" \
  --lifecycle '{"Stage":"Prospect","ReviewStatus":"Pending Submission"}' \
  --customer '{"Account":{"CompanyName":"Acme Corp","Industry":"Software & Internet"}}' \
  --project '{"Title":"Workshop Demo","CustomerBusinessProblem":"Migrating to cloud"}' \
  --profile <your-profile> --region us-east-1
```
This creates a partner-originated opportunity in your sandbox. `/pc-opps` will pick it up immediately.

### C) Try the agent's reasoning capability

```
/pc what's the next step on the Acme data warehouse migration opportunity?
```

The agent will look up the opportunity, reason about lifecycle stages, and suggest a next action.

```
/pc update the Acme data warehouse migration opportunity to stage Qualified and add a contact named Jane Smith, CTO
```

You'll get another approval card. Approve it. Run `/pc-opps` to confirm the change landed.

### Success criteria

You're done if you can:
- ✅ See the bot reply to `/pc-session`
- ✅ See `/pc-opps` return at least one opportunity
- ✅ Trigger an approval card by asking the bot to update an opportunity
- ✅ See the update reflected after clicking Approve

---

## Cleanup

When you're done, tear down the stack so you don't accumulate AWS costs:

```bash
# 1. Empty the S3 deploy bucket
aws s3 rb s3://slack-pc-bot-deploy-$(aws sts get-caller-identity --query Account --output text --profile <your-profile>) --force --profile <your-profile>

# 2. Delete the CloudFormation stack
aws cloudformation delete-stack --stack-name slack-pc-bot --profile <your-profile> --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name slack-pc-bot --profile <your-profile> --region us-east-1

# 3. (Optional) Delete the Slack app
# Go to https://api.slack.com/apps → your app → "Delete App" at the bottom of Basic Information

# 4. (Optional) Delete the sandbox partner
# Sandbox partners persist by design for testing; you typically don't need to delete them.
# If you really want to: there's no aws CLI command for this; raise a Partner Central support case.
```

---

## Troubleshooting

Match your error against this list before guessing.

**`Invalid choice: 'partnercentral-account'`**
AWS CLI is too old. Need 2.32.11+. Run `aws --version`. Upgrade with `brew upgrade awscli` (macOS) or `winget upgrade Amazon.AWSCLI` (Windows).

**`aws: command not found` after installing**
Homebrew's `bin` isn't on PATH. `eval "$(/opt/homebrew/bin/brew shellenv)"` (Apple Silicon) or `eval "$(/usr/local/bin/brew shellenv)"` (Intel), open a new terminal.

**`./setup.sh: command not found` or `Permission denied`**
You're not in the `deployment/` directory or the script lost its executable bit. Run `chmod +x deployment/setup.sh` and `cd deployment` first.

**Stack create fails with `User is not authorized to perform iam:CreateRole`**
Your AWS credentials don't have permission to create IAM roles. The script can't deploy without that. Get an admin role or have someone with admin run it for you.

**Slack `/pc-opps` stays on "Fetching your opportunities..."**
The bot isn't in the channel. Run `/invite @Partner Central Bot` in that channel. The bot also sends an ephemeral "invite me" hint — check for it.

**Slack returns `dispatch_unknown_error`**
The slash command's Request URL doesn't match your deployed API Gateway. You probably missed one of the four URL substitutions in the manifest. Open https://api.slack.com/apps → your app → **Slash Commands**, edit each of `/pc`, `/pc-opps`, `/pc-session`, and confirm the URL matches your Events URL from Lab 3.

**Slash command produces no Slack reply, no Lambda log activity**
Slack's signature verification is rejecting the request. Likely causes:
- Secret has placeholder values (`xoxb-REPLACE-ME`). Re-run Lab 4 step 4.
- You regenerated the signing secret in the Slack dashboard but didn't update Secrets Manager.

**`/pc-opps` returns an empty list**
Your sandbox partner has no opportunities. Run Lab 6 step B to create one (via the bot or via CLI).

**Sandbox partner creation says "LegalName already exists"**
Sandbox partner legal names are globally unique per AWS account. If you re-ran the script you may already be registered — check with `aws partnercentral-account list-partners --catalog Sandbox`. Otherwise pick a different name.

**Logs are empty / I want to see what the bot is doing**
```bash
aws logs tail /aws/lambda/slack-pc-bot-bot --since 15m --follow \
  --profile <your-profile> --region us-east-1
```
Filter by prefix to focus on a subsystem: `[MCP-Stream]`, `[JobProcessor]`, `[Commands]`, `[Secrets]`.

**Something else / nothing in this list works**
- Run `aws sts get-caller-identity` and confirm you're in the right account
- Run `aws cloudformation describe-stacks --stack-name slack-pc-bot --query 'Stacks[0].StackStatus' --output text` and confirm it says `CREATE_COMPLETE` or `UPDATE_COMPLETE`
- Tail the logs: `aws logs tail /aws/lambda/slack-pc-bot-bot --since 30m`
- File a question with the workshop facilitator and include the exact command you ran and the full error output

---

## What to read next

- [`README.md`](../README.md) — operational reference for after the workshop
- [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) — detailed deployment notes including credential rotation and parallel deployments
- [`FEATURE_DOC.md`](../FEATURE_DOC.md) — design rationale, validated scenarios, known limitations
- [Partner Central Agent MCP getting started](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)
- [Partner Central sandbox testing](https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox.html)
