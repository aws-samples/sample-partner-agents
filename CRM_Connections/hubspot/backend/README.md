# backend: AWS Lambda code for the Share / Submit / Refresh / Pull handlers

This package holds the business logic that runs inside AWS Lambda on every Share, Submit, or Refresh click from the HubSpot Custom Card, plus the Pull Lambda that handles EventBridge reverse-sync. Deployed as four Lambda functions behind an API Gateway HTTP API. See `../infra/` for the deployment glue.

## Layout

```
backend/
├── package.json          # Node 20 + @aws-sdk + @hubspot/api-client
├── tsconfig.json         # strict ES2022 ESM
├── vitest.config.ts      # node env; fast-check seed logging enabled
├── esbuild.config.mjs    # bundler: dist/{share,refresh,submit,pull}.zip
├── handlers/             # AWS Lambda entry points (this is what esbuild targets)
│   ├── shared.ts         # toProxyResult, parseDealId, logRequest helpers
│   ├── share.ts          # POST /share wrapper around runShare
│   ├── refresh.ts        # POST /refresh wrapper around runRefresh
│   ├── submit.ts         # POST /submit wrapper around runSubmit
│   └── pull.ts           # EventBridge handler, wraps runPull
├── core/                 # Pure orchestration, no AWS SDK, no network
│   ├── run-share.ts      # create flow (create + associate + optional submit) + update flow w/ retry
│   ├── run-refresh.ts    # GetOpportunity + GetAwsOpportunitySummary flow
│   ├── run-submit.ts     # StartEngagementFromOpportunityTask + async task-failure detection
│   └── run-pull.ts       # AWS to HubSpot reverse sync (auto-create / auto-refresh)
├── lib/                  # Pure library modules, shared by handlers + core
│   ├── ace.ts            # @aws-sdk/client-partnercentral-selling wrapper + describeAceError()
│   ├── client-token.ts   # deterministic UUIDv5 from dealId (PAYLOAD_VERSION=v6)
│   ├── config.ts         # AWS Secrets Manager loader + per-container cache
│   ├── country.ts        # ISO-3166 country name to code normalisation (byte-identical to card copy)
│   ├── errors.ts         # ErrorCode enum + FunctionResponse envelope
│   ├── hubspot.ts        # @hubspot/api-client wrapper (read/write deal props)
│   ├── payload.ts        # buildCreatePayload / buildUpdatePayload (no hardcoded defaults, see below)
│   ├── preconditions.ts  # create-time validator (14 rules): dealName, closedate, closeDateFuture, amount, currencyCode, countryCode, stateOrRegion (US), postalCode, websiteUrl, descriptionLength, industry, stageMappable, solutions, closedLostReason
│   ├── resolve-status.ts # Refresh status decision table (Rejected > Closed > ...)
│   ├── stage-mapping.ts  # STAGE_MAPPING / STAGE_DISPLAY_NAMES parser + fwd/rev map
│   └── submission-mode.ts # Submission_Required_Fields + Create_And_Submit vs Create_Only classifier (byte-identical to card copy)
└── __tests__/            # Vitest covering share, refresh, submit, pull, payload, preconditions, stage-mapping, client-token tests
```

## How the layers compose

The Lambda handler is the outermost layer; it owns AWS concerns (event parsing, status-code mapping, structured logging) and delegates to the pure orchestration.

```
APIGatewayProxyEventV2
        │
        ▼
handlers/share.ts      parses dealId, loads config from Secrets Manager,
                       constructs real AceClient + HubspotClient
        │
        ▼
core/run-share.ts      parses STAGE_MAPPING, reads deal, validates
                       preconditions, branches create vs update, handles
                       throttle retries and LastModifiedDate retries
        │
        ▼
lib/payload.ts         buildCreatePayload / buildUpdatePayload
lib/preconditions.ts   validatePreconditions
lib/stage-mapping.ts   parseStageMapping / forwardMap / reverseMap
lib/client-token.ts    generateClientToken (deterministic UUIDv5)
lib/ace.ts             AceClient (6 methods wrapping @aws-sdk)
lib/hubspot.ts         HubspotClient (read/write deal properties)
        │
        ▼
FunctionResponse       { ok: true, message, properties } or
                       { ok: false, code, message, details? }
        │
        ▼
APIGatewayProxyResultV2  (JSON body + HTTP status from statusCodeFor)
```

## Running tests

```bash
npm test                  # vitest run, all tests once
npm run test:watch        # vitest watch mode
npm run typecheck         # tsc --noEmit
```

Property-based tests emit the fast-check seed on failure (see `vitest.config.ts`). Six correctness properties are covered:

1. Preconditions return exactly the violated rule set
2. `generateClientToken` is deterministic and injective in `dealId`
3. Stage map forward-then-reverse is consistent
4. `resolveStatus` obeys Rejected > Closed Lost > APN-present > default
5. `parseStageMapping` round-trips valid input
6. `loadConfigFromSecretsManager` reports missing secrets accurately

These properties are exercised by the Vitest suite in `__tests__/`; read the test files for the exact statements and generators.

## Building the Lambda bundles

```bash
npm run build
```

This runs `esbuild.config.mjs`, which:

1. Bundles each of `handlers/{share,refresh,submit,pull}.ts` as a minified ES module targeting Node 20.
2. Keeps `@aws-sdk/*` external. The Lambda runtime ships the SDK, so the deployed zip stays small (about 1 to 2 MB per function).
3. Wraps each `.mjs` into `dist/<name>.zip` via the system `zip` CLI.

`../infra/deploy.sh` uploads those zips to an S3 artifact bucket and passes the S3 keys as parameters to the CloudFormation stack.

## Handler and core contract

The handler wrapper is intentionally thin, one function, about 40 lines:

```typescript
export const handler = async (event): Promise<APIGatewayProxyResultV2> => {
  logRequest("share", reqId, event);

  const dealId = parseDealId(event);
  if (dealId === undefined) return toProxyResult(makeError(INTERNAL, ...), 400);

  const cfg = await loadConfigFromSecretsManager();
  if (!cfg.ok) return toProxyResult(makeError(MISSING_SECRET, ...), 500);

  const ace = createAceClient(cfg.config);
  const hs  = createHubspotClient(cfg.config.hubspotPrivateAppToken);
  const response = await runShare(dealId, { config: cfg.config, ace, hs });

  return toProxyResult(response, response.ok ? 200 : statusCodeFor(response.code));
};
```

The error code to HTTP status map lives in `handlers/shared.ts`:

| `ErrorCode`          | HTTP  | Rationale                                        |
|----------------------|-------|--------------------------------------------------|
| (success)            | 200   | success envelope                                 |
| `INTERNAL` (400)     | 400   | caller-supplied bad payload (dealId missing)     |
| `PRECONDITION`       | 422   | client-provided deal fails validation            |
| `STALE_OPPORTUNITY`  | 409   | optimistic-concurrency conflict                  |
| `AUTH_INVALID`       | 401   | JWT rejected (normally answered by API Gateway)  |
| `ACE_CREATE/UPDATE/GET/GET_SUMMARY/HUBSPOT_WRITE` | 502 | downstream AWS/HubSpot error |
| `ACE_THROTTLED`      | 503   | transient downstream error                       |
| `MISSING_SECRET` / `STAGE_UNMAPPABLE` / `INTERNAL` | 500 | server-side misconfiguration or bug |

## Secrets Manager blob shape

One JSON object at `crm-connector/ace-share` (configurable via the `ACE_SHARE_SECRET_ID` env var on the Lambdas):

```json
{
  "AWS_ACE_ACCESS_KEY_ID":       "AKIA...",
  "AWS_ACE_SECRET_ACCESS_KEY":   "...",
  "ACE_REGION":                  "us-east-1",
  "STAGE_MAPPING":               "qualified=Qualified;...",
  "STAGE_DISPLAY_NAMES":         "qualified=Qualified;...",
  "HUBSPOT_PRIVATE_APP_TOKEN":   "pat-eu1-...",
  "HUBSPOT_CLIENT_SECRET":       "..."
}
```

The config loader caches the parsed blob per Lambda container. Warm invocations pay one module-level index access; cold invocations pay one `GetSecretValue` call. See `lib/config.ts` for the cache implementation and `__clearConfigCache()` for the test hook.

## Refresh: NextSteps precedence

`runRefresh` reads `LifeCycle.NextSteps` from two ACE sources:

1. **`GetOpportunity.LifeCycle.NextSteps`** is the partner-side editable value. Share, Refresh, and the Partner Central Agent all write here.
2. **`GetAwsOpportunitySummary.LifeCycle.NextSteps`** is the AWS-reviewer annotation. Updated only by AWS-side reviewer actions; lags edits made through any partner-side path.

The snapshot helper in `core/run-share.ts:snapshotFromOpportunity` prefers (1) over (2), falling back to the summary only when the opportunity's value is blank. Reversing this would clobber fresh agent or button-click updates with stale review notes. See the regression tests in `__tests__/payload.example.test.ts` (`GetOpportunity's LifeCycle.NextSteps wins over the summary's`).

## No hardcoded defaults, deal-property-driven payloads

`buildCreatePayload` and `buildUpdatePayload` send no hardcoded field defaults. Every previously-defaulted ACE field now maps to a HubSpot deal property, and each one is handled in one of two ways.

Required fields are enforced by `validatePreconditions` (create) or the submission gate (submit). A blank value is reported as an actionable precondition violation rather than silently filled. The create-required fields are the deal name, industry, and website URL (from the deal property `ace_website_url` or the associated company's website or domain), the currency code, the amount, a future close date, the country code, the US state or region, the postal code, the description length, a solution, and a mappable stage.

Optional fields are omitted from the wire when blank, with no empty strings and no `"None"`-style filler. These include opportunity type, national security, the marketing fields, sales activities at create time, and origin, which is dropped entirely.

The only structural constant left is `ExpectedCustomerSpend.Frequency = "Monthly"`, which is tied to the monthly-amount math. The create stage comes from the deal's mapped `dealstage`, not a hardcoded `"Qualified"`. Optional env-level fallbacks (`ACE_DEFAULT_*`) remain supported but are unset by default, so absence means omit.

## Submission requirements: Create_And_Submit vs Create_Only

`lib/submission-mode.ts` defines `SUBMISSION_REQUIRED_FIELDS`, the fields AWS needs before `StartEngagementFromOpportunityTask` will pass validation:

`ace_involvement_type`, `ace_visibility`, `ace_delivery_model`, `ace_primary_need_from_aws`, `ace_customer_use_case`, `ace_sales_activities`.

When all are present, a Share is classified `Create_And_Submit` (create, then associate, then StartEngagement in one click). When any is missing, it is `Create_Only`, saved as a draft so the rep can complete the fields and submit later. `runSubmit` re-checks the same set as a precondition, so it never fires StartEngagement against a deal that AWS will reject.

> **Note on `ace_sales_activities`:** it is a `Project` field set at create or update time, but AWS also enforces it at submit (`OPPORTUNITY_VALIDATION_FAILED project.salesActivities is required`), so it lives in the submission set. `SUBMIT_DEAL_PROPERTY_NAMES` in `run-submit.ts` must list every `SUBMISSION_REQUIRED_FIELDS` entry. Otherwise the field reads back `undefined` and Submit wrongly reports it missing. A regression test guards this.

## Non-destructive reverse-sync

`snapshotToProps` (the AWS to HubSpot writeback used by Refresh, Pull, and the Share/Submit post-write) is non-destructive: for partner-editable input fields it omits the key when AWS returns blank instead of writing `""`. This matters because AWS does not echo some inputs back. Notably `InvolvementType` and `Visibility` are absent from `GetAwsOpportunitySummary` until an opportunity is submitted. Writing `""` would wipe the values the rep just entered and make submission impossible. The AWS-owned mirror fields (`aws_review_status`, `aws_stage`, sync-health flags) are still written even when blank, because AWS owns those and a blank legitimately clears stale state. See `PRESERVE_LOCAL_WHEN_AWS_BLANK` in `core/run-share.ts`.

## Verbose AWS validation errors

Partner Central `ValidationException`s frequently carry an empty top-level message, which the AWS SDK surfaces as the useless literal `"UnknownError"`, while the actionable detail lives in `ErrorList: [{ FieldName, Message, Code }]`. `describeAceError()` in `lib/ace.ts` folds those field-level entries into one readable string (for example `ExpectedCustomerSpend.CurrencyCode: ESC cloud partition requires EUR currency (INVALID_VALUE)`), and the Share / Submit / Refresh error paths use it for both the CloudWatch log and the `ace_sync_error` shown on the card. Submit additionally polls the engagement task after `StartEngagement` and surfaces an asynchronous task FAILED reason the same way, instead of reporting a false success.

## Cross-package coupling

The TypeScript Lambda stack is the canonical home of the `PAYLOAD_VERSION` constant used to derive the deterministic ACE `ClientToken`:

- `lib/client-token.ts:PAYLOAD_VERSION = "v6"`

Bumping it invalidates every previously-generated deterministic token; the create flow's existing one-shot `randomUUID()` retry on ConflictException covers the recovery path. **Bump only when you genuinely need a new token namespace.**

## Contributing

- All `lib/*.ts` modules are pure, with no network and no SDK imports besides types. New lib code should keep the "literal-object mock" test pattern.
- `core/run-*.ts` modules own orchestration and error translation. New behaviour belongs here rather than in handlers.
- `handlers/*.ts` are plumbing only. If a handler grows beyond about 50 lines something probably belongs in core.
