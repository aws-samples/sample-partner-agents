/**
 * Configuration loader for the Partner Central Agent Lambda. Reads a
 * single JSON blob from AWS Secrets Manager (default secret id
 * `crm-connector/ace-agent`, configurable via `ACE_AGENT_SECRET_ID`).
 *
 * Independent of `../../backend/lib/config.ts` — the agent stack has its
 * own (much smaller) blob:
 *
 *   {
 *     "HUBSPOT_CLIENT_SECRET":      "...",  // required (HubSpot v3 HMAC verification)
 *     "HUBSPOT_PRIVATE_APP_TOKEN":  "...",  // optional (enables deal-context preamble)
 *     "ACE_AGENT_CATALOG":          "Sandbox" | "AWS"  // optional, defaults to Sandbox
 *   }
 *
 * No ACE access keys: the agent talks to MCP via the Lambda execution
 * role (SigV4) — no long-lived static credentials anywhere. No stage
 * mapping, no ACE solution ID, no ACE_DEFAULT_*: the agent doesn't
 * build payloads, it forwards natural language.
 *
 * The blob is fetched once per Lambda container and cached in a
 * module-scoped variable.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

import type { Catalog } from "./mcp-client";

export type AgentConfig = {
  /** Required. Used to verify the HubSpot v3 HMAC on inbound requests. */
  hubspotClientSecret: string;
  /** Optional. Enables the deal-context preamble. When omitted, queries run without auto-injected deal context. */
  hubspotPrivateAppToken?: string;
  /** Defaults to "Sandbox". Operators flip to "AWS" when ready for production. */
  aceAgentCatalog: Catalog;
};

export const DEFAULT_CATALOG: Catalog = "Sandbox";

export const REQUIRED_SECRET_NAMES = ["HUBSPOT_CLIENT_SECRET"] as const;

export type LoadConfigResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; missing: string[] };

const SECRET_ID =
  process.env.ACE_AGENT_SECRET_ID ?? "crm-connector/ace-agent";

const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

let cachedRaw: Record<string, string> | undefined;

async function loadSecretBlob(): Promise<Record<string, string>> {
  if (cachedRaw) return cachedRaw;
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const str = resp.SecretString ?? "{}";
  cachedRaw = JSON.parse(str) as Record<string, string>;
  return cachedRaw;
}

/**
 * Load the agent's configuration. Returns a discriminated union so
 * callers can surface `MISSING_SECRET` without throwing.
 *
 * Catalog handling: an explicit "AWS" or "Sandbox" wins; anything else
 * (missing key, blank string, unrecognised value) falls back to
 * `DEFAULT_CATALOG = "Sandbox"`. We deliberately don't fail loud on a
 * malformed catalog value — the safe default is testing, not production.
 */
export async function loadAgentConfigFromSecretsManager(): Promise<LoadConfigResult> {
  const raw = await loadSecretBlob();
  const missing: string[] = [];
  for (const key of REQUIRED_SECRET_NAMES) {
    const value = raw[key];
    if (value === undefined || value.trim() === "") {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const catalogRaw = raw["ACE_AGENT_CATALOG"]?.trim() ?? "";
  const aceAgentCatalog: Catalog =
    catalogRaw === "AWS" ? "AWS" : DEFAULT_CATALOG;

  const tokenRaw = raw["HUBSPOT_PRIVATE_APP_TOKEN"]?.trim() ?? "";
  const hubspotPrivateAppToken = tokenRaw === "" ? undefined : tokenRaw;

  return {
    ok: true,
    config: {
      hubspotClientSecret: raw["HUBSPOT_CLIENT_SECRET"] as string,
      ...(hubspotPrivateAppToken ? { hubspotPrivateAppToken } : {}),
      aceAgentCatalog,
    },
  };
}

/** Test hook: clear the container-level cache. */
export function __clearConfigCache(): void {
  cachedRaw = undefined;
}
