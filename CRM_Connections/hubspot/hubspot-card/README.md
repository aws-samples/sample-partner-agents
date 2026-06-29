# hubspot-card: HubSpot UI Extension (Custom Card)

This package contains **only** the React-based Custom Card that renders on the HubSpot deal record sidebar with the AWS Partner Central Share, Submit and Refresh buttons. The card talks to an AWS Lambda backend that lives in a separate package (`../backend/`) and is deployed independently via `../infra/`.

## Layout

```
hubspot-card/
├── hsproject.json                    # HubSpot Projects manifest
├── hubspot.config.yml.example        # template, copy to hubspot.config.yml then run `hs account auth`
├── package.json                      # React + @hubspot/ui-extensions only
├── tsconfig.json                     # strict ES2022 + jsx: react-jsx
├── vitest.config.ts                  # jsdom env for RTL tests
├── vitest.setup.ts                   # jest-dom matchers
└── src/app/
    ├── app-hsmeta.json               # private app manifest (scopes, permittedUrls.fetch)
    ├── cards/
    │   ├── AceShareCard.tsx          # the card itself (carries ACE_API_BASE_URL)
    │   ├── submission-mode.ts        # Create_And_Submit vs Create_Only classifier, kept identical to ../../../backend/lib/submission-mode.ts
    │   └── country.ts                # ISO country name to code normalisation, kept identical to ../../../backend/lib/country.ts
    └── __tests__/
        └── AceShareCard.test.tsx     # tests for the visual states and gating
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

> For this sample you deploy the card with `hs project upload`, shown under "Deploy the card" below. That is the path to use, including when you are testing against the sandbox. "Develop locally" with `hs project dev` is optional and only useful when you are iterating on the card UI. Deploying the card works the same way whether the backend talks to the Sandbox or the production catalog, because the card simply calls your API Gateway URL. The choice between Sandbox and production lives in the backend and its IAM policy, not in the card. See "Adapting for production" in the [solution README](../README.md#adapting-for-production).

### Deploy the card (the standard path)

```bash
cd hubspot-card
hs project upload
```

HubSpot builds the card on its side and ships it to the portal. The card fetches its API base URL from the constant `ACE_API_BASE_URL` at the top of `src/app/cards/AceShareCard.tsx`, and HubSpot's `hubspot.fetch` allowlist is in `src/app/app-hsmeta.json:config.permittedUrls.fetch`. Both values are written by `../infra/deploy.sh` after every backend deploy. If you see the card show a "not configured" toast, rerun `../infra/deploy.sh` to regenerate the values, then re-upload the card.

### Develop locally (optional)

```bash
cd hubspot-card
hs project dev       # HubSpot's local dev server + hot reload against the portal
```

`hs project dev` renders the card in the live portal's iframe but serves the component code from your workstation. It needs the backend deployed first, because the card's `apiBaseUrl` still points at the real API Gateway even in dev mode, so you are exercising the full stack.

### Run tests

```bash
cd hubspot-card
npm install
npm test                 # vitest run
npm run test:watch       # vitest watch mode
npm run typecheck        # tsc --noEmit
```

The test suite (`src/app/__tests__/AceShareCard.test.tsx`) mocks `@hubspot/ui-extensions` components to plain HTML so React Testing Library can exercise the card without HubSpot's remote-ui runtime. It covers the five visual states (Placeholder, Active with no opportunity, Active with an opportunity, In flight, and Error), the share readiness checklist and its fallback from the deal to the associated company, the submission gating that picks between "Share to AWS (creates and submits)" and "Share to AWS (save as draft)" along with the missing fields hint, and the push before submit lock that disables Submit while the deal is in the Pending Sync state. It also covers the button being disabled while a request is in flight, the double click guard, the Share, Submit and Refresh URL composition, the 401 handling, and the success and error toasts.

## How the card talks to the backend

Every Share or Refresh click posts JSON to `<apiBaseUrl>/share` or `<apiBaseUrl>/refresh`. HubSpot's `hubspot.fetch` helper automatically signs the request with a JWT in the `Authorization` header, plus an `X-HubSpot-Signature-V3` HMAC. The Lambda verifies the v3 signature inline (using the public-app client secret) before doing any work. The card never sees or handles the JWT directly.

The request body is always `{ "dealId": <number> }`. The response is a JSON body matching the backend's `FunctionResponse` envelope (`{ ok: true, message, properties }` or `{ ok: false, code, message, details? }`). The card narrows on `res.ok` and surfaces one of:

- `actions.addAlert({ type: "success", message })` on `ok: true`.
- `actions.addAlert({ type: "danger", message })` on `ok: false`.

A persistent inline `Alert` also renders whenever `ace_sync_error` on the deal is not empty. Because the backend formats the field level detail that AWS returns on a validation error (see "Verbose AWS validation errors" in the [backend README](../backend/README.md)), that alert shows the actual reason, such as the specific field and code, rather than a generic failure.

## Card behaviour and gating

The card only offers an action when the deal is actually ready for it, so a rep never clicks a button that is going to fail in AWS/ACE. There are three things happening behind the buttons:

1. Before a deal has been shared, the card shows a readiness checklist. This mirrors the create time validation the backend runs, so the rep can see exactly which fields are still needed. Those are the deal name, customer industry, website URL, currency, country, US state, postal code, amount, a future close date, a description of at least twenty characters, and a solution. Country, state, postal code and website can also come from the associated company when the deal itself does not carry them.

2. Once the deal is ready, the Share button describes what the next click will do. When every submission field is set, meaning involvement type, visibility, delivery model, primary need from AWS, customer use case and sales activities, and the checklist passes, the button reads "Share to AWS (creates and submits)". If something is still missing it reads "Share to AWS (save as draft)" and lists what is outstanding. Once a draft exists on the AWS side, the card shows "Push updates to AWS" next to a separate "Submit for AWS Review" button.

3. Submit stays locked while the deal has changes that have not reached AWS yet. This matters because Submit only runs the engagement task against whatever is already on the opportunity, it does not push the deal's current field values first. The card recognises this as the Pending Sync state, which happens when the deal was edited after the last successful sync. In that state Submit is disabled and the card asks the rep to push the updates first. The card allows a few seconds of tolerance so that the lock does not trigger straight after a push, since HubSpot bumps the deal's last modified time by a second or two when the backend writes the sync timestamp. Once the push completes, Submit becomes available again.

### Keeping the shared files identical with the backend

The files `cards/submission-mode.ts` and `cards/country.ts` are exact copies of `../backend/lib/submission-mode.ts` and `../backend/lib/country.ts`. The card decides submission readiness and normalises country names with the same logic the Lambda uses, so the buttons never disagree with what the backend will accept. If you change one of these files, copy it to the other location so the two stay identical.

## Security note

`hubspot.config.yml` in this directory stores a HubSpot `personalAccessKey` and a cached `accessToken` for the CLI. Treat it like any credential file:
- Do not commit it to git. Both `hubspot.config.yml` and the `archived.hubspot.config.yml` produced by CLI 8.6+ (after it migrates this file into the global `~/.hscli/config.yml`) are gitignored.
- Rotate the personal access key periodically (HubSpot Settings, Integrations, API Key).
- If a token in this file was ever pasted into chat history or any other shared channel, rotate it immediately.

## Backend operations

The Lambda code that handles Share / Refresh lives in `../backend/`. Deploy / rotate / tail logs instructions are in `../infra/README.md`. The two codebases are independent:

- Upload the card: `hs project upload` in this directory.
- Upload the backend: `../infra/deploy.sh` from repo root.

Either can redeploy without touching the other, as long as the card's `apiBaseUrl` points at a live API.
