# hubspot-card/ — HubSpot UI Extension (Custom Card)

This package contains **only** the React-based Custom Card that renders on the HubSpot deal record sidebar (AWS Partner Central → Share / Refresh buttons). The card talks to an AWS Lambda backend that lives in a separate package (`../backend/`) and is deployed independently via `../infra/`.

## Layout

```
hubspot-card/
├── hsproject.json                    # HubSpot Projects manifest
├── hubspot.config.yml.example        # template — copy to hubspot.config.yml + run `hs account auth`
├── package.json                      # React + @hubspot/ui-extensions only
├── tsconfig.json                     # strict ES2022 + jsx: react-jsx
├── vitest.config.ts                  # jsdom env for RTL tests
├── vitest.setup.ts                   # jest-dom matchers
└── src/app/
    ├── app-hsmeta.json               # private app manifest (scopes, permittedUrls.fetch)
    ├── cards/
    │   └── AceShareCard.tsx          # the card itself (carries ACE_API_BASE_URL)
    └── __tests__/
        └── AceShareCard.test.tsx     # RTL tests for the visual states
```

This project has **no `app.functions/` directory**, which is the whole point of the pivot: HubSpot Serverless Functions require HubSpot Enterprise, and this portal is on Standard. Without an `app.functions` entry the card deploys on every HubSpot plan.

## Prerequisites

- Node.js 22 + `npm` (the HubSpot CLI requires Node 22; Lambda bundles target Node 20 runtime).
- The `hs` HubSpot CLI, installed and authenticated against the target portal. The first time you set up this directory, copy `hubspot.config.yml.example` to `hubspot.config.yml` and run `hs account auth` to populate the access key. `hubspot.config.yml` is gitignored, so the live token stays on your workstation.

  ```
  cp hubspot.config.yml.example hubspot.config.yml
  hs account auth               # CLI 8.6+; older versions: hs auth
  ```

  After auth, set `defaultPortal` in `hubspot.config.yml` to the alias you picked, and `hs project upload` will use it.
- The AWS backend **already deployed** so the card has a real `apiBaseUrl` to point at. See `../infra/README.md`.

## Standard workflow

### Deploy the card (production)

```bash
cd hubspot-card
hs project upload
```

HubSpot builds the card on its side and ships it to the portal. The card fetches its API base URL from the constant `ACE_API_BASE_URL` at the top of `src/app/cards/AceShareCard.tsx`, and HubSpot's `hubspot.fetch` allowlist is in `src/app/app-hsmeta.json:config.permittedUrls.fetch`. Both values are written by `../infra/deploy.sh` after every backend deploy. If you see the card show a "not configured" toast, rerun `../infra/deploy.sh` to regenerate the values, then re-upload the card.

### Develop locally

```bash
cd hubspot-card
hs project dev       # HubSpot's local dev server + hot reload against the portal
```

`hs project dev` renders the card in the live portal's iframe but serves the component code from your workstation. Requires the backend to be deployed — the card's `apiBaseUrl` still points at the real API Gateway even in dev mode, so you're exercising the full stack.

### Run tests

```bash
cd hubspot-card
npm install
npm test                 # vitest run
npm run test:watch       # vitest watch mode
npm run typecheck        # tsc --noEmit
```

The test suite (`src/app/__tests__/AceShareCard.test.tsx`) mocks `@hubspot/ui-extensions` components to plain HTML so React Testing Library can exercise the card without HubSpot's remote-ui runtime. Covered:
- all 5 visual states (Placeholder, Active-no-opp, Active-with-opp, In-flight, Error)
- button-disabled-while-in-flight
- double-click guard (R11.1)
- Share / Refresh URL composition
- 401 AUTH_INVALID synthesis from backend responses
- success and error toast paths

## How the card talks to the backend

Every Share or Refresh click posts JSON to `<apiBaseUrl>/share` or `<apiBaseUrl>/refresh`. HubSpot's `hubspot.fetch` helper automatically signs the request with a short-lived JWT in the `Authorization` header, plus an `X-HubSpot-Signature-V3` HMAC. The Lambda verifies the v3 signature inline (using the public-app client secret) before doing any work. The card never sees or handles the JWT directly.

The request body is always `{ "dealId": <number> }`. The response is a JSON body matching the backend's `FunctionResponse` envelope (`{ ok: true, message, properties }` or `{ ok: false, code, message, details? }`). The card narrows on `res.ok` and surfaces one of:

- `actions.addAlert({ type: "success", message })` on `ok: true`.
- `actions.addAlert({ type: "danger", message })` on `ok: false`.

A persistent inline `Alert` also renders whenever `ace_sync_error` on the deal is non-empty (R6.5).

## Security note

`hubspot.config.yml` in this directory stores a HubSpot `personalAccessKey` and a cached `accessToken` for the CLI. Treat it like any credential file:
- Do not commit it to git. Both `hubspot.config.yml` and the `archived.hubspot.config.yml` produced by CLI 8.6+ (after it migrates this file into the global `~/.hscli/config.yml`) are gitignored.
- Rotate the personal access key periodically (HubSpot Settings → Integrations → API Key).
- If a token in this file was ever pasted into chat history or any other shared channel, rotate it immediately.

## Backend operations

The Lambda code that handles Share / Refresh lives in `../backend/`. Deploy / rotate / tail logs instructions are in `../infra/README.md`. The two codebases are independent:

- Upload the card: `hs project upload` in this directory.
- Upload the backend: `../infra/deploy.sh` from repo root.

Either can redeploy without touching the other, as long as the card's `apiBaseUrl` points at a live API.
