# agent-card/ — HubSpot UI Extension (Partner Central Agent card)

This package contains **only** the React-based custom card that renders on the deal record sidebar with a chat-style interface to the AWS Partner Central Agent MCP Server. The card talks to an AWS Lambda backend (`../agent-backend/`) deployed independently via `../agent-infra/`.

## Layout

```
agent-card/
├── hsproject.json                       # HubSpot Projects manifest
├── hubspot.config.yml.example           # template — copy + run `hs account auth`
├── package.json                         # React + @hubspot/ui-extensions only
├── tsconfig.json                        # strict ES2022 + jsx: react-jsx
├── vitest.config.ts                     # jsdom env for RTL tests
├── vitest.setup.ts                      # jest-dom matchers
└── src/app/
    ├── app-hsmeta.json                  # private app manifest (scopes, permittedUrls.fetch)
    ├── cards/
    │   ├── AgentCard.tsx                # the card itself (carries AGENT_API_BASE_URL)
    │   ├── AgentCard-hsmeta.json        # card registration on the deal record tab
    │   ├── BulkImportPanel.tsx          # CSV bulk-import panel (paste → batched agent prompts)
    │   ├── markdown.tsx                 # tiny markdown renderer for the transcript
    │   ├── config.local.ts.example      # template — auto-materialised by deploy
    │   └── package.json                 # runtime deps for HubSpot's project build
    └── __tests__/
        ├── AgentCard.test.tsx           # 20 RTL tests
        ├── BulkImportPanel.test.tsx     # 18 RTL tests
        └── markdown.test.tsx            # 13 unit tests
```

This project has **no `app.functions/` directory**, so it deploys on every HubSpot plan including free / Standard.

## Prerequisites

- Node.js 22 + `npm` (the HubSpot CLI requires Node 22; Lambda bundles target Node 20 runtime).
- The `hs` HubSpot CLI, installed and authenticated against the target portal. First-time setup:

  ```bash
  cp hubspot.config.yml.example hubspot.config.yml
  hs account auth                         # CLI 8.6+; older versions: hs auth
  # Edit hubspot.config.yml — set defaultPortal to the alias you used
  # during `hs account auth`.
  ```

  `hubspot.config.yml` is gitignored, so the live token stays on your workstation.

- The Agent backend **already deployed** so the card has a real API URL to point at. See `../agent-infra/README.md`.

## Standard workflow

### Deploy the card (production)

```bash
cd agent-card
hs project upload
```

The card fetches its API base URL from the constant `AGENT_API_BASE_URL` at the top of `src/app/cards/AgentCard.tsx`, and HubSpot's `hubspot.fetch` allowlist is in `src/app/app-hsmeta.json:config.permittedUrls.fetch`. Both values are written by `../agent-infra/deploy.sh` after every backend deploy. If the card shows a "not configured" toast, rerun the deploy script and re-upload the card.

### Develop locally

```bash
cd agent-card
hs project dev
```

`hs project dev` renders the card in the live portal but serves the component code from your workstation. Requires the backend to be deployed.

### Run tests

```bash
cd agent-card
npm install
npm test                 # vitest run (51 tests)
npm run test:watch
npm run typecheck        # tsc --noEmit
```

The test suite mocks `@hubspot/ui-extensions` components to plain HTML so React Testing Library can exercise the card without HubSpot's remote-ui runtime. Covered:

- Empty initial state with hint text
- Send button enables only when the draft is non-empty
- Send POSTs `{ dealId, message: { type: text, text } }` to `<api>/agent/start`, then polls `<api>/agent/poll?jobId=...` until status `complete`
- Follow-up messages echo `sessionId` from the prior turn
- 401 surfaces "Authorization failed"
- `MCP_RATE_LIMITED` toast fires
- `MCP_NOT_FOUND` (stale session) auto-clears the sessionId so the next message starts fresh
- `requires_approval` renders the inline Approve / Reject / Override panel
- Override is disabled when the message is empty, enabled with text
- Approve / Reject / Override clicks POST the right `tool_approval_response`
- Once acted on, an approval entry's buttons disappear and read "Approved" / "Rejected" / "Overridden"
- Cooldown: after a send, the Send button reads "Wait Ns" and is disabled
- New conversation: button clears the transcript and drops the sessionId
- Duplicate-approval detection: when MCP re-emits an identical `approval_request`, the prompt renders in danger variant with a warning message
- Bulk import panel: CSV parser (header detection, quoted fields, CRLF, demo-cap enforcement), batch slicing at BATCH_SIZE, between-batch progress + Continue button, parent-in-flight gating, fresh-session-per-batch flag

## How the card talks to the backend

Every card action posts JSON to `<apiBaseUrl>/agent/start` to kick off an asynchronous backend job, then polls `<apiBaseUrl>/agent/poll?jobId=<uuid>` every 1.5 s until the job completes. HubSpot's `hubspot.fetch` helper signs each request with a v3 HMAC; the Agent Lambda verifies that signature before doing any work. The card never sees or handles the signature directly.

User-typed message body (POST `/agent/start`):

```json
{ "dealId": 12345, "message": { "type": "text", "text": "..." } }
```

Approval-response body (POST `/agent/start`):

```json
{
  "dealId": 12345,
  "sessionId": "session-...",
  "message": {
    "type": "tool_approval_response",
    "toolUseId": "...",
    "decision": "approve" | "reject" | "override",
    "message": "..."
  }
}
```

`/agent/start` responds in <100 ms with `{ ok: true, jobId }`. The card then polls `/agent/poll?jobId=<uuid>` until the worker writes the result to DynamoDB. The poll response embeds the same `AgentResponse` envelope a synchronous endpoint would have returned:

```json
{
  "ok": true,
  "status": "complete",
  "jobId": "<uuid>",
  "response": { ... AgentResponse ... }
}
```

The card narrows on `response.ok` and renders one of:

- A new `text` block in the transcript (status `complete`).
- An `approval_request` panel below the agent's narrative (status `requires_approval`).
- `actions.addAlert({ type: "danger", message })` on `ok: false`.

Why async? The Partner Central Agent MCP Server's `sendMessage` regularly takes 25-40 seconds for tool-call approvals. API Gateway HTTP API caps integration timeouts at 30 seconds. The async path lets the worker Lambda run for up to 5 minutes untethered from API Gateway, with the card polling cheap DynamoDB reads in between.

## Bulk import

The card includes a `BulkImportPanel` below the chat composer for demo / prototype CSV imports. Paste a CSV with a header row plus up to 30 data rows. The panel slices the rows into batches of 5 and sends each batch as a structured prompt to the agent (each batch forces a fresh MCP session to keep per-turn latency low). Within a batch, each row's `CreateOpportunity` proposal still triggers the normal HITL approval prompt — the panel just paginates the input.

The panel is intentionally demo-grade. The 30-row cap and per-row HITL friction make it unsuitable for production-scale bulk import; that path would be a separate Lambda calling `partnercentral-selling.CreateOpportunity` directly without the agent loop.

## Rate-limit / cooldown behaviour

The MCP server's `sendMessage` rate limit is **2 requests per minute** (burst 10). The card enforces a 30-second cooldown on the Send button after every send so a typical user can't trip the burst. If the server returns `MCP_RATE_LIMITED` (`-32004`), the cooldown extends to 60s and a warning Alert renders.

## Security note

`hubspot.config.yml` in this directory stores a HubSpot `personalAccessKey` for the CLI. Treat it like any credential file:
- Do not commit it to git (it's gitignored at the root, along with the `archived.hubspot.config.yml` that CLI 8.6+ produces after it migrates this file into the global config).
- Rotate the personal access key periodically.
- If a token in this file was ever pasted into chat history, rotate it immediately.

## Backend operations

The Lambda code that handles agent traffic lives in `../agent-backend/`. Deploy / rotate / tail logs instructions are in `../agent-infra/README.md`. The two codebases are independent:

- Upload the card: `hs project upload` in this directory.
- Upload the backend: `../agent-infra/deploy.sh` from repo root.
