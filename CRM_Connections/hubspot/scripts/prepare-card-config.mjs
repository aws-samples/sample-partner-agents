#!/usr/bin/env node
/**
 * Postinstall hook: materialise the gitignored card-config files from
 * their committed `.example` templates after `npm ci` / `npm install`.
 *
 * Two file pairs handled per card:
 *   - `cards/config.local.ts.example` → `cards/config.local.ts`
 *   - `app-hsmeta.template.json`      → `app-hsmeta.json`
 *
 * The real files are gitignored so each partner's deployer URL stays
 * out of the upstream public repo. The templates carry placeholder
 * values like `https://REPLACE-ME.execute-api.us-east-1.amazonaws.com`
 * so a fresh clone builds (npm test, tsc --noEmit) immediately, but
 * `hs project upload` against the placeholder URL will fail at the
 * first hubspot.fetch call. Run `infra/deploy.sh` (or
 * `agent-infra/deploy.sh`) to populate the real values.
 *
 * Idempotent: if the real file already exists, the script leaves it
 * alone — partners who set up their values manually don't get
 * overwritten on subsequent `npm ci`.
 *
 * Determines which card we're in by inspecting the cwd. The npm
 * postinstall hook runs from the package directory, so
 * `process.cwd()` is `hubspot-card/` or `agent-card/`.
 */

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();

/** Pairs of (template path, real path) relative to the package root. */
const pairs = [
  // app-hsmeta.json: HubSpot UI Extensions reads this to register the
  // card and enforce the fetch allowlist.
  ["src/app/app-hsmeta.template.json", "src/app/app-hsmeta.json"],
  // config.local.ts: imported by the card's runtime as the production
  // fallback API base URL when no `apiBaseUrl` prop is provided.
  // Tests always supply `apiBaseUrl` directly so the file's runtime
  // value is irrelevant in the test suite — only TypeScript needs the
  // import to resolve.
  ["src/app/cards/config.local.ts.example", "src/app/cards/config.local.ts"],
];

let materialised = 0;
let skipped = 0;
for (const [template, real] of pairs) {
  const templatePath = join(cwd, template);
  const realPath = join(cwd, real);
  if (!existsSync(templatePath)) {
    // Template missing — quietly skip. This means we're either in a
    // package that doesn't use this pattern, or the pair was renamed
    // and someone forgot to update this script.
    continue;
  }
  if (existsSync(realPath)) {
    skipped += 1;
    continue;
  }
  copyFileSync(templatePath, realPath);
  console.log(`prepare-card-config: created ${real} from ${template}`);
  materialised += 1;
}

if (materialised + skipped === 0) {
  // No relevant pairs found in this cwd. Stay quiet so the postinstall
  // hook is harmless when invoked from packages that don't ship card
  // config.
  process.exit(0);
}
