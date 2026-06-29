# smoke-test

End-to-end smoke test for the `partner-central-chat-agent` spec. Runs
against a real Salesforce org and exercises the server-side code paths
without requiring the LWC to be loaded in a browser.

## Tiers

The script is split into three opt-in tiers so destructive paths stay
behind explicit flags.

| Tier           | Flag          | What it does                                                                                 | MCP quota | Writes Partner Central? |
| -------------- | ------------- | -------------------------------------------------------------------------------------------- | :-------: | :---------------------: |
| 1 — plumbing   | *(default)*   | Config + connector detect + record context + catalog-aware session lookup. No HTTP callouts. | none      | no                      |
| 2 — live read  | `--live`      | Tier 1 + one live `sendMessage` turn against the MCP server (read-only prompt).              | small     | no                      |
| 3 — approval   | `--approve`   | Tier 2 + submit a write request, then **reject** it via `decideOperation`.                   | medium    | no (auto-rejected)      |
| attachment     | `--attach`    | Tier 2 + a real S3 `PutObject` of a small document and a read-only `sendMessage` that references it. Implies `--live`. | small | no |

Tier 3 is split across two Apex anon transactions (`tier3a`, `tier3b`)
because Apex anonymous blocks cannot interleave DML and callouts the way
LWC `@AuraEnabled` methods do. Each LWC request is its own transaction,
so the production code path works fine; only the smoke test needs the split.

## Usage

```bash
# Tier 1: always safe
./scripts/smoke/smoke-test.sh my-dev-org

# Tier 2: consumes a small amount of MCP quota
./scripts/smoke/smoke-test.sh my-dev-org --live

# Tier 3: full approval round-trip, auto-rejects
./scripts/smoke/smoke-test.sh my-dev-org --approve

# Attachment: real S3 upload + document round-trip (implies --live)
./scripts/smoke/smoke-test.sh my-dev-org --attach

# Target a specific record
./scripts/smoke/smoke-test.sh my-dev-org --approve --record-id <opportunity-record-id>

# Standalone / general-chat org (no AWS Partner CRM Connector)
./scripts/smoke/smoke-test.sh my-dev-org --general-chat --live
```

## General-chat (standalone) orgs

On an org without the AWS Partner CRM Connector there is no `awsapn__ACE_Opportunity__c`
object, so the record-aware probes can't run (and won't even compile against that
type). The script handles this two ways:

- **Auto-fallback**: if no ACE Opportunity with an APN CRM id is found, the script
  switches to general-chat mode instead of failing.
- **Explicit**: pass `--general-chat` to force the record-less path.

In general-chat mode the tiers run record-less Apex variants
(`tier1_general.apex`, `tier2_general.apex`, `tier3a_general.apex`) that pass
`recordId = null`, exactly as the LWC does from Home or the utility bar:

- **Tier 1** validates config, `getClientConfig`, the permission set, a null-record
  session lookup, and `restoreTranscript(null)`. No callouts.
- **Tier 2** sends a read-only "list my opportunities" prompt with no record context.
- **Tier 3** attempts a write with no anchored record. Because nothing is anchored,
  the agent usually asks a clarifying question rather than emitting an approval
  request, so this commonly prints `TIER3A_NO_PENDING` and Tier 3b skips. To exercise
  a real approval round-trip on a standalone org, name an opportunity in the prompt.

## What it proves

**Tier 1** (always)
- `Chat_Agent_Config__mdt.Default` loads without throwing (validates required fields)
- `ConfigProvider.detectConnectorSandbox()` resolves against the AWS Partner CRM Connector's `awsapn__Companion_App_Settings__c.awsapn__PC_API_Sandbox_Enabled__c`
- `ConfigProvider.isSandbox()` returns a consistent value matching the connector (or an explicit override)
- `ChatAgentController.getClientConfig()` returns a valid `ConfigDto` — exactly what the LWC bootstraps from
- `ChatAgentController.getRecordContext()` describes the ACE opportunity and returns its APN CRM id
- `SessionManager.findActiveSession()` filters by catalog, so a sandbox session is not returned for an `AWS`-catalog query
- `ChatAgentController.restoreTranscript()` never returns null
- The running user holds the `Partner_Central_Chat_Agent_User` permission set

**Tier 2** (`--live`)
- `submitMessage` returns `ok=true` with a structured events envelope (the inline-events fix from TASK 11)
- A 200-status `Audit_Log__c` row is written with a captured MCP `Session_Id`
- Session continuity persists across turns (same `Session_Id` across rows)

**Tier 3** (`--approve`)
- The agent emits a `tool_approval_request` block for a plausible write request
- `Pending_Write_Operation__c` is registered with `status=pending`, `decision=unresolved`
- `decideOperation('rejected')` advances the state machine to `status=cancelled`, `decision=rejected`
- The follow-up callout succeeds (no `uncommitted-work` failure, proving the DML-before-callout split from TASK 2 holds)
- **No write ever commits to Partner Central** because the decision is rejection

**Attachment** (`--attach`)
- `McpClient.uploadAttachmentToS3` performs a real SigV4 `PutObject` to the ephemeral bucket and returns an `s3://...?versionId=...` URI (isolated first, so credential / IAM / bucket-versioning errors are attributed to the upload layer, not the agent)
- `submitMessage` with the attachment sends a `document` content block referencing the uploaded object and returns a non-empty `events` array
- Skips cleanly (prints `TIER_ATTACH_SKIP`, no failure) when `AWS_Partner_Central_S3` / `S3_Bucket_Name__c` / `Aws_Account_Id__c` are not configured, so it is safe on text-only orgs
- The prompt is read-only (summarize), so **no write is proposed and nothing commits**

## Typical happy-path output (Tier 3)

```
— Tier 1 / config + connector + session round-trip —
   target org      : my-dev-org
✓  Permission set Partner_Central_Chat_Agent_User is assigned
      config | isSandbox=true connectorDetect=true activeCred=AWS_Partner_Central_MCP
      recordContext | {"partnerCentralOpportunityId":"O12906628",...}
      session-lookup | AWS=none Sandbox=a0Vd200000KMELlEAP
✓  ConfigProvider / SessionManager / getRecordContext round-trip succeeded

— Tier 2 / live sendMessage —
      submitMessage.ok=true errorCode=null
      events.count=3
✓  Live sendMessage round-trip completed without a structured error

— Tier 3 / approval round-trip (auto-rejecting) —
      TIER3A_PENDING_OPERATION_ID=tooluse_jT2t72QHXC26afHuYFa7Gr
      TIER3A_OK
      rejecting | op=update_opportunity_enhanced catalog=Sandbox
      after-reject | status=cancelled decision=rejected
      TIER3B_OK
✓  All smoke-test tiers passed.
```

## When to run it

- After a fresh deploy on a target org
- Before handing the org to a QA review
- After changing any of: `ConfigProvider`, `SessionManager`, `ChatAgentController`, `McpClient`, or the `chatAgent` LWC's server interface
- Before cutting a release branch

Do *not* run Tier 3 in a loop — it exercises the live MCP server and
consumes upstream quota.
