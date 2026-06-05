#!/usr/bin/env node
// Bundles each Lambda handler (share, refresh, pull, submit) into a
// deployable zip under `dist/<name>.zip` containing `<name>.mjs` at the
// zip root — the format CloudFormation `AWS::Lambda::Function` expects
// when the Code is uploaded via S3.
//
// The bundles are single-file, minified ES modules targeting Node.js 20.
// `@aws-sdk/*` is kept external so the Lambda runtime's bundled SDK is
// reused and the deployed artefact stays small.

import esbuild from "esbuild";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");

// Clean and recreate dist/ at the start of each build.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const handlers = ["share", "refresh", "pull", "submit"];

// ESM-in-CJS shim: some deps (`@hubspot/api-client`) reach for
// `require` at runtime. Injecting `createRequire` at the top of the
// bundle lets those CommonJS interop paths resolve inside an ES module.
const esmShimBanner = {
  js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);",
};

for (const name of handlers) {
  const entryPoint = join(__dirname, "handlers", `${name}.ts`);
  const mjsPath = join(distDir, `${name}.mjs`);
  const zipPath = join(distDir, `${name}.zip`);

  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    sourcemap: false,
    outfile: mjsPath,
    external: ["@aws-sdk/*"],
    banner: esmShimBanner,
    logLevel: "info",
  });

  // Wrap the single bundled .mjs into a zip with the file at the root.
  // `-j` strips directory components so the archive contains just
  // `<name>.mjs` — what Lambda expects when resolving the handler path.
  execFileSync("zip", ["-j", zipPath, mjsPath], { stdio: "inherit" });

  // Tidy up the raw .mjs now that it lives inside the zip.
  unlinkSync(mjsPath);

  console.log(`bundled ${name} -> dist/${name}.zip`);
}
