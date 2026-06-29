# agent-backend/ — AWS Lambda code for the AWS Partner Central Agent card

This package holds the business logic that runs inside AWS Lambda on every Send / Approve / Reject / Override click from the Agent card. Two Lambda functions behind a single API Gateway HTTP API — see `../agent-infra/` for the deployment glue.

The agent stack is **independent** of `../backend/` (the Share/Refresh stack). You can deploy the agent on its own without the bidirectional sync, or alongside it.

## Layout

```
agent-backend/
├── package.json               # Node 20 + @aws-sdk/{secrets-manager,signature-v4,protocol-http,client-dynamodb,client-lambda}
├── tsconfig.json              # strict ES2022 ESM
├── vitest.config.ts           # node env
├── esbuild.config.mjs         # bundler: dist/agent.zip + dist/agent-async.zip
├── handlers/                  # AWS Lambda entry points
│   ├── shared.ts                  toProxyResult, statusCodeFor, requestIdOf
│   ├── agent.ts                   POST /agent — synchronous handler (legacy fallback)
│   └── agent-async.ts             POST /agent/start, GET /agent/poll, async self-invoke worker
├── core/
│   └── run-agent.ts               text + approval orchestration, deal-context preamble
├── lib/                       # Pure libraries
│   ├── config.ts                  Secrets Manager loader (3 keys)
│   ├── errors.ts                  ErrorCode enum, AgentResponse envelope
│   ├── hubspot-deal-context.ts    best-effort deal lookup for the preamble
│   ├── hubspot-signature.ts       HubSpot v3 HMAC verification
│   ├── job-store.ts               DynamoDB-backed async job state
│   └── mcp-client.ts              SigV4 + JSON-RPC 2.0 over HTTPS
└── __tests__/                 # Vitest — 88 tests
```

## Why two Lambdas

API Gateway HTTP APIs cap integration timeouts at 30 seconds. The Partner Central Agent MCP Server's `sendMessage` regularly takes 25-40 seconds for tool-call approvals as session context grows. The async path lets the card POST to `/agent/start` (returns `{ jobId }` in <100 ms), the start handler async-invokes a worker via `lambda:Invoke` with `InvocationType: "Event"`, and the worker calls MCP untethered from API Gateway with the full 5-minute Lambda budget. The card polls `GET /agent/poll?jobId=...` every 1.5 s until the worker writes the result to DynamoDB.

The original `POST /agent` (synchronous) Lambda is retained as a fallback for very short interactions (it still works and shares the same orchestration code) but the card no longer routes any traffic through it. All chat Send + approval + bulk-import calls flow through the async path so MCP sessions stay scoped to a single IAM principal.

## Wire flow (async path)

The Agent card POSTs JSON to `<apiBaseUrl>/agent/start` with one of two body shapes:

**User-typed message:**
```json
{ "dealId": 12345, "message": { "type": "text", "text": "What's blocking this?" } }
```

**Approval response (after a `requires_approval` turn):**
```json
{
  "dealId": 12345,
  "sessionId": "session-...",
  "message": {
    "type": "tool_approval_response",
    "toolUseId": "tool-use-98765",
    "decision": "approve" | "reject" | "override",
    "message": "..."
  }
}
```

`/agent/start` responds immediately with:

```json
{ "ok": true, "jobId": "<uuid>" }
```

Then the card polls `GET /agent/poll?jobId=<uuid>` until status is `complete` or `error`. The poll response embeds the same `AgentResponse` envelope the synchronous `/agent` route used to return:

```typescript
type PollResponse = {
  ok: true,
  status: "pending" | "running" | "complete" | "error",
  jobId: string,
  response?: AgentResponse,        // populated on complete or error-with-body
  errorMessage?: string,           // populated on error without a body
};

type AgentSuccess = {
  ok: true,
  status: "complete" | "requires_approval",
  sessionId: string,
  blocks: Array<
    | { type: "text", text: string }
    | { type: "approval_request", toolUseId: string, toolName: string,
        parameters: Record<string, unknown> }
  >,
};
type AgentError = {
  ok: false,
  code: "MCP_AUTH_FAILURE" | "MCP_PERMISSION_DENIED" | "MCP_RATE_LIMITED" | "MCP_NOT_FOUND" | ...,
  message: string,
  details?: { rpcCode?: number, rpcMessage?: string },
};
```

The card narrows on `response.ok` and renders identically to how it would have for a synchronous response — the polling pattern is a transport detail, not a contract change.

## Running tests

```bash
npm test                  # vitest run — all tests once
npm run test:watch        # watch mode
npm run typecheck         # tsc --noEmit
```

## Building bundles

```bash
npm run build
```

Produces `dist/agent.zip` (~30KB), a single-file ES module targeting Node 20 with `@aws-sdk/*` external (provided by the Lambda runtime).

## Secrets Manager blob shape

One JSON object at `crm-connector/ace-agent` (configurable via `ACE_AGENT_SECRET_ID` env var on the Lambdas):

```json
{
  "HUBSPOT_CLIENT_SECRET":     "...",
  "HUBSPOT_PRIVATE_APP_TOKEN": "...",
  "ACE_AGENT_CATALOG":         "Sandbox"
}
```

| Key | Required? | Purpose |
|-----|-----------|---------|
| `HUBSPOT_CLIENT_SECRET` | yes | HubSpot v3 HMAC verification key |
| `HUBSPOT_PRIVATE_APP_TOKEN` | optional | Enables the deal-context preamble. Without it, queries run without auto-injected context. |
| `ACE_AGENT_CATALOG` | optional | `Sandbox` (default) or `AWS`. Flip to `AWS` if you adapt this sample for the production catalog. |

The agent NEVER receives long-lived ACE access keys. SigV4 signing uses the Lambda execution role's temporary credentials at runtime via `@aws-sdk/credential-provider-node`'s `defaultProvider`.

## IAM model

The Lambda execution role gets two AWS-managed policies (configured in `../agent-infra/cloudformation.yaml`):

- `AWSMcpServiceActionsFullAccess` — grants `partnercentral:UseSession` and all MCP-scoped actions (`aws:IsMcpServiceAction == true`).
- `AWSPartnerCentralSandboxFullAccess` — grants the data-access actions (`Get*`, `List*`, `UpdateOpportunity`, etc.) scoped to the Sandbox catalog only.

To adapt this sample for the production (`AWS`) catalog, swap `AWSPartnerCentralSandboxFullAccess` for `AWSPartnerCentralFullAccess` in the CloudFormation template and also update `ACE_AGENT_CATALOG` to `"AWS"`.

## What's intentionally NOT here

- **No SSE streaming on the wire.** MCP supports SSE for incremental responses; the card uses `hubspot.fetch` which is a JSON request/response wrapper and can't surface SSE events. The async start+poll pattern delivers the same UX (long calls without a 30s ceiling) without needing SSE on the client.
- **No file uploads.** The MCP server accepts attached PDFs/CSVs/etc. via S3 pre-upload; this integration is text-only.
- **No client-side session persistence.** `sessionId` lives in card state only. Closing/reopening the card starts a fresh session. MCP's 48-hour absolute session expiry makes longer client-side persistence fragile anyway, and in practice MCP evicts sessions faster than the documented TTL — the card has automatic stale-session recovery for that case.

## Cross-package coupling

None. The agent stack is fully independent of:

- `../backend/` (Share/Refresh) — no shared imports, no shared secrets blob, no shared CloudFormation stack.
- `../src/` (Python batch) — no shared mapping logic, no shared HubSpot custom properties.

## Contributing

- All `lib/*.ts` modules are pure — no network besides the explicit fetch surface, no SDK imports beyond types. New lib code should keep the literal-object mock test pattern.
- `core/run-agent.ts` owns orchestration and error translation. New behaviour belongs here rather than in handlers.
- `handlers/agent.ts` is plumbing only — body parsing, signature check, response serialisation. The async dispatcher in `handlers/agent-async.ts` shares the same shape with three event branches (start, poll, worker) and adds DynamoDB / `lambda:Invoke` side effects.

## Latency budget

The async path removes the 30-second API Gateway ceiling that the synchronous Lambda was bounded by. Instead:

- `POST /agent/start` returns in <100 ms (write a pending DDB row + fire-and-forget `lambda:Invoke`).
- The worker invocation runs at 5-minute Lambda timeout, plenty of budget for any MCP response we've seen.
- `GET /agent/poll` is one DynamoDB GetItem per call (~10 ms server-side).
- The card polls every 1.5 s; total wall-clock latency for a typical bulk-create approval is ~10-25 s end-to-end.

When MCP itself errors out (`-32603 INTERNAL_ERROR`, `-32602 ResourceNotFoundException`, etc.) the worker writes the error envelope to DDB and the card surfaces a typed error toast on the next poll. The card auto-recovers on `MCP_NOT_FOUND` by dropping the local sessionId so the next message starts a fresh session.
