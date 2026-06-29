# infra: AWS backend for the ACE Share / Refresh card

This directory contains everything needed to deploy and operate the AWS backend that powers the HubSpot Custom Card (Share and Refresh buttons on the deal record sidebar). Business logic lives in `../backend/`; this directory is CloudFormation + shell scripts only.

## Architecture (quick recap)

The HubSpot Custom Card calls `hubspot.fetch("<apiBaseUrl>/share")` (or `.../refresh`), which hits an API Gateway HTTP API and runs the Share / Refresh Lambdas directly. Each Lambda verifies HubSpot's v3 HMAC signature inline (REQUEST authorizers can't see the request body, which the v3 signature covers). Credentials (ACE access key, HubSpot private-app token, HubSpot client secret) live in a single Secrets Manager blob. See [`../docs/architecture.md`](../docs/architecture.md) for the full design and request flows.

## One stack per catalog and HubSpot portal

The reverse sync from AWS to HubSpot is driven by an Amazon EventBridge rule that matches `aws.partnercentral-selling` opportunity events and invokes the Pull Lambda, which then creates or refreshes the matching HubSpot deal. That rule filters on the catalog, which in this sample is `Sandbox`.

The important thing to remember is that only one deployed stack should own a given pairing of catalog and HubSpot portal. If you deploy two stacks that filter the same catalog and write into the same HubSpot portal, both Pull Lambdas fire for every opportunity event and each one creates its own HubSpot deal, so you end up with a duplicate deal for every opportunity. The two stacks keep separate lock tables, so they cannot deduplicate against each other.

This is easy to trip over when you run an `--env-suffix dev` stack next to the canonical stack, because both default to the Sandbox catalog. Two Sandbox stacks pointing at the same portal will duplicate everything, so either give each stack its own HubSpot portal or keep to a single stack. A Sandbox stack and a production stack are fine even on the same portal, because they filter different catalogs and therefore see different events.

If you do see duplicate deals, list the rules to find how many are enabled for the same catalog, then disable or remove the extra stack's rule. Disabling the rule is a reversible stop gap, and deleting the redundant stack is the permanent fix.

```bash
aws events list-rules --query "Rules[?contains(Name,'PullEventRule')].{Name:Name,State:State}"
aws events disable-rule --name <the-redundant-rule>
aws cloudformation delete-stack --stack-name <redundant-stack>
```

### Adapting for the production catalog

This sample is wired for the Sandbox catalog, and moving it to the production AWS catalog is a change you make yourself. The catalog is set in three places that all need to change together. First, `backend/lib/config.ts` sets `ACE_CATALOG` to `Sandbox`. Second, `infra/cloudformation.yaml` sets the catalog the Pull rule filters on, in the rule's event pattern. Third, the same template attaches the Lambda IAM role's managed policy, and the Sandbox build uses the Sandbox scoped Partner Central policy. For production you would use a policy without the Sandbox restriction, such as `AWSPartnerCentralOpportunityManagement` or `AWSPartnerCentralFullAccess`.

Once a Sandbox stack and a production stack run on different catalogs their EventBridge rules match different events, so they will not duplicate even if they share a HubSpot portal. Even so, a separate HubSpot portal for production is the cleaner choice. If you want to avoid editing code at all, a reasonable enhancement is to promote the catalog to a CloudFormation parameter and a Lambda environment variable, but until that exists the three edits above are the checklist.

## Prerequisites

- **AWS CLI** 2.15 or newer. Confirm with `aws --version`.
- **AWS credentials** for the account you want to deploy into. Either set `AWS_PROFILE=<your-profile>` or rely on the default profile / environment credentials. The scripts will accept any of:
  ```
  export AWS_PROFILE=my-profile
  ./infra/deploy.sh
  ```
  ```
  ./infra/deploy.sh                # uses default profile / env creds
  ```
  ```
  AWS_PROFILE=my-profile ./infra/deploy.sh
  ```
- **Region**: `us-east-1` by default. Override with `AWS_REGION=...`.
- **Stack name**: `ace-share-refresh` by default. Override with `STACK_NAME=...`.
- **Environment suffix** (optional): pass `--env-suffix dev` (or set `ENV_SUFFIX=dev`) to append a suffix to the stack name and every globally-named resource (Lambdas, IAM role, log groups, Secrets Manager secret, DynamoDB table, HTTP API name, EventBridge rule). The empty default keeps the canonical names, and a suffix lets a dev and a prod stack coexist in one AWS account. Note that a suffixed stack and the canonical stack both default to the Sandbox catalog, so do not point both at the same HubSpot portal or you will get duplicate deals. The section [One stack per catalog and HubSpot portal](#one-stack-per-catalog-and-hubspot-portal) above explains why. See also the Parallel environments section in [`../docs/architecture.md`](../docs/architecture.md).
- **Node.js 22** with `npm` on your `PATH` (for building the Lambda bundles and running the HubSpot CLI).
- **`zip` CLI** (macOS and Linux ship this by default).
- **Python 3** (used by `deploy.sh` and `set-secrets.sh` for JSON merging).

## Files in this directory

| File                  | Purpose                                                            |
|-----------------------|--------------------------------------------------------------------|
| `cloudformation.yaml` | Full stack: API Gateway, 4 Lambdas, IAM role, Secrets Manager      |
| `deploy.sh`           | Build bundles, upload to S3, deploy stack, patch card manifest     |
| `set-secrets.sh`      | Populate (or update) the Secrets Manager blob                      |
| `tail-logs.sh`        | `aws logs tail` wrapper for the four Lambda log groups             |
| `README.md`           | You are here                                                       |

## Standard workflow

### First-time setup

```bash
# Optional. Pick your AWS profile / region / stack name. All have sensible
# defaults so a partner with a single AWS profile can skip these.
export AWS_PROFILE=my-profile
export AWS_REGION=us-east-1
export STACK_NAME=ace-share-refresh

# 1. Build + deploy the stack. Creates the API Gateway, the three Lambdas,
#    the IAM role, the Secrets Manager secret (with a placeholder value),
#    and the three log groups. Also patches the HubSpot card source files
#    with the API URL.
./infra/deploy.sh

# 2. Populate the Secrets Manager blob. Prompts for the required keys with
#    hidden stdin, so tokens never land in scrollback or logs.
./infra/set-secrets.sh

# 3. Provision HubSpot custom properties (one-time).
./scripts/setup-hubspot-properties.sh

# 4. Upload the card.
cd hubspot-card && hs project upload
```

### Redeploy after a code change

```bash
export AWS_PROFILE=my-profile      # only if you don't use the default
./infra/deploy.sh

# Or, when running a separate environment alongside prod:
./infra/deploy.sh --env-suffix dev
```

`deploy.sh` hashes each Lambda zip; if the bundle contents haven't changed, CloudFormation is a no-op at the Lambda level. Safe to run any number of times.

### Tail logs

```bash
./infra/tail-logs.sh share      # just Share
./infra/tail-logs.sh refresh    # just Refresh
./infra/tail-logs.sh submit     # just Submit
./infra/tail-logs.sh pull       # just Pull
./infra/tail-logs.sh all        # all four in parallel (Ctrl-C to stop)
```

### Read structured logs by request ID

Every invocation emits a `<fn>.begin` JSON line with a `reqId` field. To find the full lifecycle of one request:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/ace-share-ShareLambda \
  --region "${AWS_REGION:-us-east-1}" \
  --filter-pattern '{ $.reqId = "a1b2c3d4-..." }'
```

### Rotate a secret

1. **Mint the new value** in its source system.
   - HubSpot private-app token, in HubSpot Settings, Private Apps.
   - AWS ACE IAM access key, in the AWS IAM console, on the IAM user you provisioned for the connector.
2. **Push it**:
   ```bash
   ./infra/set-secrets.sh HUBSPOT_PRIVATE_APP_TOKEN
   # or:
   ./infra/set-secrets.sh AWS_ACE_ACCESS_KEY_ID AWS_ACE_SECRET_ACCESS_KEY
   ```
3. **Force a Lambda cold-start** so warm containers pick up the new value (replace `${AWS_PROFILE}` and `${AWS_REGION}` with your values, or omit `--profile` if you use the default). The `aws lambda wait` between iterations avoids `ResourceConflictException` from bouncing back-to-back:
   ```bash
   STAMP=$(date +%s)
   for fn in ace-share-ShareLambda ace-share-RefreshLambda ace-share-SubmitLambda ace-share-PullLambda; do
     aws lambda update-function-configuration \
       --function-name "$fn" --region "${AWS_REGION:-us-east-1}" \
       --environment "Variables={ACE_SHARE_SECRET_ID=crm-connector/ace-share,LOG_LEVEL=info,FORCE_REFRESH=${STAMP}}" \
       > /dev/null
     aws lambda wait function-updated --function-name "$fn" \
       --region "${AWS_REGION:-us-east-1}"
   done
   ```
4. **Verify** via one Share or Refresh click through the card.
5. **Deactivate the old value** in its source system.

## Operational note: rotating any token that touched a chat or shared log

Treat any token that has ever been pasted into a chat conversation, screenshot, or shared log as compromised, including HubSpot Private App tokens, HubSpot Personal Access Keys, AWS access keys, and HubSpot App UIDs. Mint fresh values and push them via `set-secrets.sh` (which reads from hidden stdin so the new value never lands in scrollback or logs).

The same rule applies to the HubSpot `personalAccessKey` stored in `hubspot-card/hubspot.config.yml`. That file is a local CLI auth artifact used only by `hs project upload` on your workstation. It is gitignored, so it never ships with the repo, but you should still rotate it periodically and never paste its value into a chat or commit message.

## Smoke test (manual, end-to-end)

Run this sequence against the ACE Sandbox catalog after a fresh deploy to confirm the full pipeline works.

1. **Confirm account / credentials**
   ```bash
   aws sts get-caller-identity
   ```
   Expect your own AWS account ID in the output.

2. **Deploy the backend**
   ```bash
   ./infra/deploy.sh
   ```
   Expect `ApiUrl` in the output. The script patches BOTH `hubspot-card/src/app/app-hsmeta.json:config.permittedUrls.fetch` and `hubspot-card/src/app/cards/config.local.ts:ACE_API_BASE_URL` with that URL.

3. **Populate the secret**
   ```bash
   ./infra/set-secrets.sh
   ```
   Enter fresh values for all 7 keys. `ACE_REGION` can be left blank (defaults to `us-east-1`); `STAGE_DISPLAY_NAMES` can be left blank (falls back to stage IDs).

4. **Provision the HubSpot custom properties**
   ```bash
   ./scripts/setup-hubspot-properties.sh
   ```

5. **Upload the card**
   ```bash
   cd hubspot-card && hs project upload
   ```
   Expect no "plan doesn't include serverless functions" error, because this project has no `app.functions` block.

6. **Open a test deal in HubSpot** with:
   - `description` of at least 20 chars (used as `Project.CustomerBusinessProblem`)
   - `closedate` set
   - `amount > 0`
   - An associated company with a country code

   Expect the card to show the "Active" state with the Share button visible.

7. **Click Share**
   ```bash
   ./infra/tail-logs.sh share
   ```
   Expect `share.create.begin` then `share.create.success`. In HubSpot: a success toast with the new opportunity ID, the card transitions to show both Share + Refresh, `ace_opportunity_id` / `ace_sync_status=pending_review` / `ace_last_sync` all populated.

8. **Click Refresh** (same deal, immediately)
   ```bash
   ./infra/tail-logs.sh refresh
   ```
   Expect `refresh.begin` then `refresh.success`. The toast confirms the refreshed stage and status. `ace_sync_status` is updated; `ace_last_sync` is updated.

9. **Edit the deal `amount` and click Share** Expect `share.update.success`. `ace_opportunity_id` is unchanged; `ace_sync_status = Synced`; `ace_last_sync` updated.

10. **MISSING_SECRET path**
    ```bash
    ./infra/set-secrets.sh STAGE_MAPPING    # enter an empty string
    # force-bounce Lambdas (see Rotate a secret above)
    ```
    Click Share. Expect HTTP 500 body with `code: "MISSING_SECRET"`, `details.missingSecrets: ["STAGE_MAPPING"]`. Restore the real value and re-bounce.

11. **AUTH_INVALID path** Rotate `HUBSPOT_CLIENT_SECRET` to any other string via `./infra/set-secrets.sh HUBSPOT_CLIENT_SECRET`, force-bounce both Lambdas, click Share. Expect HTTP 401; the card shows `Authorization failed. Reload the HubSpot page and try again.` Restore the real client secret and re-bounce.

12. **Placeholder state** In HubSpot, clear `description`. Expect the card to show the placeholder state with no buttons.

## Cost

At projected volume (about 300 Share clicks per month), the stack costs about $0.45/month:

- Lambda + API Gateway + Logs + Secrets Manager API calls: well under $0.10/month.
- Secrets Manager secret: $0.40/month flat (the dominant line item).
- CloudWatch Logs storage: negligible at 1 MB/month.

See the Cost model section in [`../docs/architecture.md`](../docs/architecture.md) for the detailed breakdown.

## Troubleshooting

| Symptom                                              | Check                                                                         |
|------------------------------------------------------|-------------------------------------------------------------------------------|
| Card shows "Authorization failed"                    | `./infra/tail-logs.sh share` or `./infra/tail-logs.sh refresh`, then look for `auth.deny` lines with `reason=...` |
| Card shows "Configuration error: missing secrets"    | `aws secretsmanager get-secret-value --secret-id crm-connector/ace-share`     |
| Share / Refresh stalls for 20+ seconds               | `./infra/tail-logs.sh share`, then check for an ACE timeout or a HubSpot timeout |
| `hs project upload` says "plan doesn't include ..."  | The card has an `app.functions` entry it shouldn't, so check `src/app/app.json` |
| Stack update fails with "Authorization header ..."   | The authorizer cache retains an old decision, so wait 60s or redeploy         |
