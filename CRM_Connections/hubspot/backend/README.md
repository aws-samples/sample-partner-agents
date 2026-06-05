# backend/ — AWS Lambda code for the Share / Submit / Refresh / Pull handlers

This package holds the business logic that runs inside AWS Lambda on every Share, Submit, or Refresh click from the HubSpot Custom Card, plus the Pull Lambda that handles EventBridge reverse-sync. Deployed as four Lambda functions behind an API Gateway HTTP API — see `../infra/` for the deployment glue.

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
│   └── pull.ts           # EventBridge handler — wraps runPull
├── core/                 # Pure orchestration — no AWS SDK, no network
│   ├── run-share.ts      # 3-step ACE create flow + update flow w/ retry
│   ├── run-refresh.ts    # GetOpportunity + GetAwsOpportunitySummary flow
│   ├── run-submit.ts     # Submit-to-AWS flow (AssociateOpportunity + stage transition)
│   └── run-pull.ts       # AWS → HubSpot reverse sync (auto-create / auto-refresh)
├── lib/                  # Pure library modules, shared by handlers + core
│   ├── ace.ts            # @aws-sdk/client-partnercentral-selling wrapper
│   ├── client-token.ts   # deterministic UUIDv5 from dealId (PAYLOAD_VERSION=v6)
│   ├── config.ts         # AWS Secrets Manager loader + per-container cache
│   ├── errors.ts         # ErrorCode enum + FunctionResponse envelope
│   ├── hubspot.ts        # @hubspot/api-client wrapper (read/write deal props)
│   ├── payload.ts        # buildCreatePayload / buildUpdatePayload
│   ├── preconditions.ts  # 9-rule validator (closedate, amount, countryCode, stateOrRegion, postalCode, descriptionLength, stageMappable, solutions, closedLostReason)
│   ├── resolve-status.ts # Refresh status decision table (Rejected > Closed > ...)
│   └── stage-mapping.ts  # STAGE_MAPPING / STAGE_DISPLAY_NAMES parser + fwd/rev map
└── __tests__/            # Vitest — share, refresh, submit, pull, payload, preconditions, stage-mapping, client-token tests
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
npm test                  # vitest run — all tests once
npm run test:watch        # vitest — watch mode
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
2. Keeps `@aws-sdk/*` external — the Lambda runtime ships the SDK, so the deployed zip stays small (~1–2 MB per function).
3. Wraps each `.mjs` into `dist/<name>.zip` via the system `zip` CLI.

`../infra/deploy.sh` uploads those zips to an S3 artifact bucket and passes the S3 keys as parameters to the CloudFormation stack.

## Handler ⇄ core contract

The handler wrapper is intentionally thin — one function, ~40 lines:

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

The error-code → HTTP-status map lives in `handlers/shared.ts`:

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

## Refresh — NextSteps precedence

`runRefresh` reads `LifeCycle.NextSteps` from two ACE sources:

1. **`GetOpportunity.LifeCycle.NextSteps`** — the partner-side editable value. Share, Refresh, and the Partner Central Agent all write here.
2. **`GetAwsOpportunitySummary.LifeCycle.NextSteps`** — the AWS-reviewer annotation. Updated only by AWS-side reviewer actions; lags edits made through any partner-side path.

The snapshot helper in `core/run-share.ts:snapshotFromOpportunity` prefers (1) over (2), falling back to the summary only when the opportunity's value is blank. Reversing this would clobber fresh agent / button-click updates with stale review notes — see the regression tests in `__tests__/payload.example.test.ts` (`GetOpportunity's LifeCycle.NextSteps wins over the summary's`).

## Cross-package coupling

The TypeScript Lambda stack is the canonical home of the `PAYLOAD_VERSION` constant used to derive the deterministic ACE `ClientToken`:

- `lib/client-token.ts:PAYLOAD_VERSION = "v6"`

Bumping it invalidates every previously-generated deterministic token; the create flow's existing one-shot `randomUUID()` retry on ConflictException covers the recovery path. **Bump only when you genuinely need a new token namespace.**

## Contributing

- All `lib/*.ts` modules are pure — no network, no SDK imports besides types. New lib code should keep the "literal-object mock" test pattern.
- `core/run-*.ts` modules own orchestration and error translation. New behaviour belongs here rather than in handlers.
- `handlers/*.ts` are plumbing only — if a handler grows beyond ~50 lines something probably belongs in core.
