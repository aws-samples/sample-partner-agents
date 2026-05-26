# Partner Central Agent — Slack Integration

Bring the AWS Partner Central Agent into Slack. Partners manage opportunities, approve writes, and get answers in the same place they already work.

---

## Why this matters

Partner sellers, PAMs, and PDMs spend their day in Slack. The current Partner Central UI forces them to context-switch to check pipeline, update stages, or look up funding eligibility. That friction slows response times and often means updates don't happen at all.

This integration puts the Partner Central Agent directly in Slack. No new tool to learn, no tab-switching. Approvals happen with a button. Sessions carry context across a conversation. Partners stay in flow.

---

## Use cases

**Pipeline review on the go.** A PAM in a customer meeting asks "what's the status of Acme?" from their phone. `/pc-opps` → opportunities list appears in Slack.

**Fast updates from conversation.** Partner says "update O12345 stage to Qualified and add John Doe (CTO) as the contact." The agent proposes the change, partner clicks Approve, done. No form filling, no lost context.

**Funding eligibility checks.** "Am I eligible for MAP funding for O12345?" — answer comes back in seconds without opening a browser.

**Team-wide opportunity triage.** A PDM posts a thread asking about priority deals. The bot lists them, the team discusses in-thread, updates happen by chat.

**Mobile-first partner experience.** Field teams work on phones. Slack works on phones. This bot works on phones.

---

## How it works

```
Slack ──▶ API Gateway ──▶ Lambda (ack) ──▶ Lambda (MCP work, async) ──▶ Partner Central Agent
                                  │                    │
                                  ▼                    ▼
                            DynamoDB session      Slack chat.update
                            + dedupe
```

**Two Lambdas, one function.** The first invocation acknowledges Slack within 3 seconds (Slack's deadline). The second runs the longer MCP call and streams results back.

**Thread = session.** Each Slack thread maps to one Partner Central Agent session, so context carries across follow-ups for up to 48 hours.

**Streaming responses.** The agent's reasoning appears in real time, with activity indicators like "analyzing pipeline..." as it works.

**Human-in-the-loop.** Writes always require a button click. No auto-execution.

---

## Quick start

Prerequisites: AWS CLI 2.32.11+, Node.js 20+, `npm`, `zip`, and an AWS profile with admin access. Windows users, run these commands from Git Bash or WSL. Full prereq and credential setup details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

> First time deploying? Walk through [docs/WORKSHOP.md](docs/WORKSHOP.md) — a 60–90 minute guided lab that covers tooling install, AWS credentials, deployment, Slack app creation, sandbox partner registration, and a working test.

**1. Deploy the stack**

```bash
export AWS_PROFILE=<your-profile>
cd deployment && ./setup.sh
```

The script picks your profile, packages the Lambda, deploys the CloudFormation stack, offers to populate Slack credentials interactively, and prints the Events URL you'll need next. If the script says "No sandbox partner found," see [Register a sandbox partner](#register-a-sandbox-partner) below.

> Sharing an AWS account with another deployment? Set `STACK_NAME_PREFIX=slack-pc-bot-<unique>` before running `setup.sh`. Resources, IAM, secrets, and the stack are fully isolated per prefix.

**2. Create the Slack app**

At [api.slack.com/apps](https://api.slack.com/apps) → **Create an App** → **From a manifest**, paste `deployment/slack-manifest.yaml` with `YOUR_API_GATEWAY_URL` replaced by the Events URL from step 1 (it appears in **5 places** — event subscriptions, interactivity, and each of the 3 slash commands). Install to your workspace. Full walkthrough in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#creating-the-slack-app-detailed).

**3. Populate the Slack credentials secret**

From the Slack app dashboard, copy the **Bot User OAuth Token** (OAuth & Permissions page) and the **Signing Secret** (Basic Information → App Credentials). Then run the command setup.sh printed at the end of step 1 — or this one if you closed the terminal:

```bash
aws secretsmanager put-secret-value \
  --secret-id slack-pc-bot-slack-credentials \
  --secret-string '{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_SIGNING_SECRET":"..."}' \
  --profile <your-profile> --region us-east-1
```

**4. Test**

In Slack: `/invite @Partner Central Bot` into a channel, then `/pc-session`, then `/pc-opps`. DMs work without the invite.

---

## Using the bot

```
/pc <question>         Any Partner Central question
/pc-opps               List open opportunities
/pc-session            Show session info for this thread
```

@mention the bot or DM it directly. Follow-ups in the same thread keep context.

For writes, the bot posts an approval card with three buttons:
- **Approve** — execute
- **Reject** — decline with optional reason
- **Override** — execute with modifications

---

## Register a sandbox partner

The bot runs against `Catalog=Sandbox`. Your AWS account needs a sandbox partner record for `/pc-opps` to return anything.

Check first:

```bash
aws partnercentral-account list-partners \
  --catalog Sandbox --region us-east-1 --profile <your-profile>
```

If empty, register one:

```bash
./deployment/register-sandbox-partner.sh \
  --legal-name "Acme Cloud Sandbox" \
  --first-name "Ada" --last-name "Lovelace" \
  --email "ada@example.com" --business-title "Alliance Lead" \
  --profile <your-profile>
```

`--legal-name` must be unique across all sandbox partners (pick something specific to you). The rest accept env vars (`FIRST_NAME`, `LAST_NAME`, `EMAIL`, `BUSINESS_TITLE`) or flags. Run with `--help` for the full list. Idempotent — re-running reuses the existing partner.

> If the AWS Console prompts to "Register as an AWS Partner," that's production APN registration. Ignore it; sandbox is a separate flow.

---

## Configuration

All knobs are CloudFormation parameters. Override via `setup.sh` env vars.

| Parameter | Purpose | Default |
|---|---|---|
| `StackNamePrefix` | Prefix for every resource (enables parallel deployments) | `slack-pc-bot` |
| `Catalog` | `Sandbox` or `AWS` | `Sandbox` |
| `AcknowledgeProduction` | Required `true` when `Catalog=AWS` | `false` |
| `LambdaTimeoutSeconds` | Lambda timeout | `120` |
| `LambdaMemorySize` | Lambda memory (MB) | `512` |
| `StreamingEnabled` | SSE streaming from the MCP server | `true` |
| `LogRetentionDays` | CloudWatch Logs retention | `30` |
| `AlarmEmail` | Optional — enables error and duration alarms | (unset) |

Always develop against `Sandbox`. The Lambda refuses to start with `CATALOG=AWS` unless `ACKNOWLEDGE_PRODUCTION=true`.

---

## Troubleshooting

**`Invalid choice: 'partnercentral-account'`** — AWS CLI too old. The API landed in 2.32.11. Upgrade:

```bash
brew upgrade awscli                    # macOS
winget upgrade Amazon.AWSCLI           # Windows
sudo /tmp/aws/install --update         # Linux (re-run the installer)
```

**`aws: command not found` after `brew install`** — Homebrew's `bin` isn't on your PATH. Add to `~/.zshrc`:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"  # Apple Silicon
eval "$(/usr/local/bin/brew shellenv)"     # Intel
```

**"Register as an AWS Partner" prompt in the AWS Console** — production APN registration, unrelated to sandbox. Ignore it and run `register-sandbox-partner.sh`.

**Slash command returns `dispatch_unknown_error`** — that command's Request URL in Slack points somewhere unreachable. Either you missed a URL substitution in the manifest, or you redeployed to a new API Gateway. Edit each command at `api.slack.com/apps/<app-id>/slash-commands`.

**Signature verification errors** — Lambda has placeholder/stale credentials. Update the secret and force a cold start:

```bash
aws secretsmanager put-secret-value --secret-id slack-pc-bot-slack-credentials \
  --secret-string '{"SLACK_BOT_TOKEN":"xoxb-...","SLACK_SIGNING_SECRET":"..."}' \
  --profile <your-profile> --region us-east-1
aws lambda update-function-configuration --function-name slack-pc-bot-bot \
  --description "rotated $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --profile <your-profile> --region us-east-1
```

**Tail logs:**
```bash
aws logs tail /aws/lambda/slack-pc-bot-bot --since 15m --follow \
  --profile <your-profile> --region us-east-1
```

(Substitute your prefix if you overrode `slack-pc-bot`.)

**Log prefixes:** `[MCP]`, `[MCP-Stream]`, `[Stream]`, `[JobProcessor]`, `[Events]`, `[Commands]`, `[Actions]`, `[Dedupe]`, `[SessionStore]`, `[Secrets]`

**Rollback Lambda code:**
```bash
aws s3 ls s3://<deploy-bucket>/slack-partner-central/backups/ --profile <your-profile>
aws lambda update-function-code --function-name slack-pc-bot-bot \
  --s3-bucket <deploy-bucket> --s3-key slack-partner-central/backups/<zip> \
  --profile <your-profile> --region us-east-1
```

**Disable streaming without redeploying:**
```bash
aws lambda update-function-configuration --function-name slack-pc-bot-bot \
  --environment "Variables={...,STREAMING_ENABLED=false}" \
  --profile <your-profile> --region us-east-1
```

---

## Security

- Slack Signing Secret verified on every request (Bolt built-in)
- AWS credentials signed at the SigV4 transport layer only
- Slack tokens stored in Secrets Manager
- All writes require explicit human approval
- DynamoDB TTL auto-expires session data at 48 hours
- Production catalog gated by explicit acknowledgment flag

---

## Extending

- **File upload for document analysis** — partners attach PDFs, agent analyzes
- **Home tab dashboard** — pipeline summary when users open the bot
- **`/pc-funding` command** — dedicated shortcut for MAP/POC/WMP eligibility
- **Workflow Builder integration** — trigger bot actions from Slack workflows
- **Per-user AWS identity** — via OAuth + STS AssumeRole for enterprise audit trails

Design rationale and validated scenarios: [`FEATURE_DOC.md`](FEATURE_DOC.md).
