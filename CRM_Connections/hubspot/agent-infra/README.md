# agent-infra/ — AWS backend for the Partner Central Agent card

CloudFormation + bash scripts that deploy `agent-backend/` into AWS. Independent of `../infra/` (Share/Refresh deploy) — partners can run either, both, or neither.

## Architecture (quick recap)

The Agent card calls `hubspot.fetch("<apiBaseUrl>/agent/start")`, which kicks off an asynchronous backend job and returns `{ ok: true, jobId }` in <100 ms. The card then polls `hubspot.fetch("<apiBaseUrl>/agent/poll?jobId=<uuid>")` every 1.5 s until the job lands. Both routes hit the same API Gateway HTTP API, both backed by the async Lambda.

Inside the Lambda:

1. `POST /agent/start` writes a pending row to DynamoDB (`ace-agent-jobs`) and async-invokes itself with the worker payload via `lambda:Invoke` (`InvocationType: "Event"`).
2. The worker invocation runs untethered from API Gateway with the full 5-minute Lambda timeout. It loads config from Secrets Manager, optionally fetches the HubSpot deal context, and forwards the message to the Partner Central Agent MCP Server via SigV4.
3. The worker writes the resulting `AgentResponse` to DynamoDB.
4. `GET /agent/poll` reads the DDB row and returns the current state.

Every write the agent proposes returns a `requires_approval` payload embedded in the poll response — the card surfaces it as an inline Approve / Reject / Override panel, and the user's choice round-trips back through the same `/agent/start` + poll cycle.

The original `POST /agent` synchronous route is still deployed (same template, separate Lambda function `ace-agent-AgentLambda`) but the card no longer routes traffic through it. It exists as a fallback for partners who want a direct synchronous interaction surface or who need to debug the orchestration layer without DynamoDB in the path.

## Prerequisites

- **AWS CLI** 2.15 or newer.
- **AWS credentials** configured. Either set `AWS_PROFILE=<your-profile>` or rely on the default profile / environment credentials.
- **Region**: `us-east-1` by default. Override with `AWS_REGION=...`. The MCP server is `us-east-1` only — staying in `us-east-1` keeps signing and routing simple.
- **Stack name**: `ace-agent` by default. Override with `STACK_NAME=...`.
- **Environment suffix** (optional): pass `--env-suffix dev` (or set `ENV_SUFFIX=dev`) to append a suffix to the stack name and every globally-named resource (Lambdas, IAM roles, log groups, Secrets Manager secret, DynamoDB job table, HTTP API name). Empty default preserves canonical names. Lets dev and prod coexist in one AWS account. See `../docs/architecture.md` § Parallel environments.
- **Node.js 20** with `npm` on your `PATH`.
- **`zip` and `shasum` CLIs**.
- **Python 3** (used for manifest patching).
- **An AWS Partner Network account** migrated to the AWS console, with IAM permission to attach `AWSMcpServiceActionsFullAccess` and `AWSPartnerCentralSandboxFullAccess` to a role.

## Files in this directory

| File                  | Purpose                                                            |
|-----------------------|--------------------------------------------------------------------|
| `cloudformation.yaml` | Full stack: API Gateway, 2 Lambdas, IAM roles, Secrets Manager, DynamoDB job table |
| `deploy.sh`           | Build bundles, upload to S3, deploy stack, patch card source       |
| `set-secrets.sh`      | Populate (or update) the Secrets Manager blob                      |
| `tail-logs.sh`        | `aws logs tail` wrapper for the Lambda log groups                  |
| `smoke-agent.sh`      | End-to-end curl-based smoke test against the deployed API          |
| `README.md`           | You are here                                                       |

## Standard workflow

### First-time setup

```bash
# Optional — pick your AWS profile / region / stack name.
export AWS_PROFILE=my-profile
export AWS_REGION=us-east-1
export STACK_NAME=ace-agent

# 1. Build + deploy. Creates the API Gateway, two Lambdas
#    (synchronous + async), the IAM roles, the DynamoDB job table,
#    the Secrets Manager secret, and the log groups. Also patches
#    the agent card source files with the API URL.
./agent-infra/deploy.sh

# 2. Populate the Secrets Manager blob (hidden stdin).
./agent-infra/set-secrets.sh

# 3. Upload the card.
cd agent-card && hs project upload
```

### Redeploy after a code change

```bash
export AWS_PROFILE=my-profile
./agent-infra/deploy.sh

# Or, when running a separate environment alongside prod:
./agent-infra/deploy.sh --env-suffix dev
```

`deploy.sh` hashes each Lambda zip; if the bundle contents haven't changed, CloudFormation is a no-op at the Lambda level.

### Tail logs

```bash
./agent-infra/tail-logs.sh sync       # synchronous Lambda (legacy /agent route)
./agent-infra/tail-logs.sh async      # async Lambda (start/poll/worker — primary)
./agent-infra/tail-logs.sh all        # both in parallel (Ctrl-C to stop)
```

### Smoke test

After `deploy.sh` and `set-secrets.sh`, run an end-to-end check that includes a valid HubSpot HMAC signature:

```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME:-ace-agent}" \
  --region "${AWS_REGION:-us-east-1}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)

# Use the same client secret you pushed via set-secrets.sh
HUBSPOT_CLIENT_SECRET=... \
API_URL="${API_URL}" \
  ./agent-infra/smoke-agent.sh
```

The script prints `PASS` (exit 0) or `FAIL` (exit 1).

### Rotate a secret

```bash
./agent-infra/set-secrets.sh HUBSPOT_PRIVATE_APP_TOKEN
```

Force-bounce **both** Lambdas so warm containers refetch. The `aws lambda wait` between iterations avoids `ResourceConflictException` when bouncing back-to-back:

```bash
STAMP=$(date +%s)
for fn in ace-agent-AgentLambda ace-agent-AgentAsyncLambda; do
  aws lambda update-function-configuration \
    --function-name "$fn" --region "${AWS_REGION:-us-east-1}" \
    --environment "Variables={ACE_AGENT_SECRET_ID=crm-connector/ace-agent,LOG_LEVEL=info,FORCE_REFRESH=${STAMP}}" \
    > /dev/null
  aws lambda wait function-updated --function-name "$fn" \
    --region "${AWS_REGION:-us-east-1}"
done
```

> **Note**: the async Lambda also reads `AGENT_JOB_TABLE` from its environment (defaults to `ace-agent-jobs`). If you customised it, include `AGENT_JOB_TABLE=<your-name>` in the variables block. Read the existing values first via `aws lambda get-function-configuration`.

## Configuring the catalog (Sandbox → production `AWS`)

This sample uses the `Sandbox` catalog. To adapt it for the production (`AWS`) catalog:

1. **Update IAM.** Edit `cloudformation.yaml` and replace `AWSPartnerCentralSandboxFullAccess` with `AWSPartnerCentralFullAccess`, then redeploy via `./agent-infra/deploy.sh`.
2. **Update the catalog flag.** Push the new value:
   ```bash
   ./agent-infra/set-secrets.sh ACE_AGENT_CATALOG
   # enter: AWS
   ```
3. **Force-bounce the Lambdas** (see Rotate a secret above).

## Cost

At projected volume (~300 chats/month):
- Lambda + API Gateway + DynamoDB job table + Logs + MCP traffic: well under $0.10/month
- Secrets Manager secret: $0.40/month flat
- **Total: ~$0.45/month**, identical to the Share/Refresh stack.

If you deploy both stacks in the same account, total is ~$0.90/month.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Card shows "Authorization failed" | `./agent-infra/tail-logs.sh async` — look for `auth.deny` lines |
| Card shows "Configuration error: missing secrets" | `aws secretsmanager get-secret-value --secret-id crm-connector/ace-agent` |
| Card shows "AWS rate-limited the request" | Expected after ~2 messages/min. Wait 60s. |
| Card shows "role doesn't allow this action" | Check the Lambda role's managed policies. May need `AWSPartnerCentralFullAccess` for production. |
| Card shows "Session expired or resource not found" | Click **New conversation** below the chat composer to reset, then send the message again. The card auto-clears the dead sessionId on this error. |
| Bulk import shows "Batch N failed" | `./agent-infra/tail-logs.sh async` — find the line containing the failing `jobId` for the verbatim MCP error. |
| MCP returns -32001 in logs | SigV4 signing failed. Usually means the role lost its trust relationship — check IAM. |
