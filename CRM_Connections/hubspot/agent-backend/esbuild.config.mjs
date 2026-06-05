#!/usr/bin/env node
// Bundles the Agent Lambda handler into a deployable zip under
// `dist/agent.zip`. Mirrors the bundling conventions of `../backend/esbuild.config.mjs` so partners deploying
// only the agent stack don't need to learn a new tool.

import esbuild from "esbuild";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const handlers = ["agent", "agent-async"];

// ESM-in-CJS shim: lets dependencies that reach for `require` at
// runtime resolve inside an ES module bundle.
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

  execFileSync("zip", ["-j", zipPath, mjsPath], { stdio: "inherit" });
  unlinkSync(mjsPath);

  console.log(`bundled ${name} -> dist/${name}.zip`);
}
