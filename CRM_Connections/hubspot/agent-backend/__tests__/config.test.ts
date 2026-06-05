/**
 * Tests for `agent-backend/lib/config.ts`.
 *
 * Strategy: mock `@aws-sdk/client-secrets-manager` so we control the
 * raw SecretString seen by the loader. Each test clears the per-container
 * cache via `__clearConfigCache()` so the mock is reread.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  GetSecretValueCommand: vi.fn().mockImplementation((args) => args),
}));

const { loadAgentConfigFromSecretsManager, __clearConfigCache } = await import(
  "../lib/config"
);

function withSecret(blob: Record<string, string>): void {
  mockSend.mockResolvedValue({ SecretString: JSON.stringify(blob) });
}

describe("loadAgentConfigFromSecretsManager", () => {
  beforeEach(() => {
    __clearConfigCache();
    mockSend.mockReset();
  });

  test("happy path with all keys → ok with config", async () => {
    withSecret({
      HUBSPOT_CLIENT_SECRET: "client-secret-1",
      HUBSPOT_PRIVATE_APP_TOKEN: "pat-1",
      ACE_AGENT_CATALOG: "AWS",
    });

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hubspotClientSecret).toBe("client-secret-1");
      expect(result.config.hubspotPrivateAppToken).toBe("pat-1");
      expect(result.config.aceAgentCatalog).toBe("AWS");
    }
  });

  test("missing client secret → ok:false with missing list", async () => {
    withSecret({});

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["HUBSPOT_CLIENT_SECRET"]);
    }
  });

  test("blank client secret counts as missing", async () => {
    withSecret({ HUBSPOT_CLIENT_SECRET: "   " });

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["HUBSPOT_CLIENT_SECRET"]);
    }
  });

  test("missing catalog defaults to Sandbox", async () => {
    withSecret({ HUBSPOT_CLIENT_SECRET: "x" });

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.aceAgentCatalog).toBe("Sandbox");
  });

  test("unrecognised catalog value falls back to Sandbox", async () => {
    withSecret({
      HUBSPOT_CLIENT_SECRET: "x",
      ACE_AGENT_CATALOG: "Mainframe",
    });

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.aceAgentCatalog).toBe("Sandbox");
  });

  test("blank private app token resolves to undefined", async () => {
    withSecret({
      HUBSPOT_CLIENT_SECRET: "x",
      HUBSPOT_PRIVATE_APP_TOKEN: "   ",
    });

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.hubspotPrivateAppToken).toBeUndefined();
  });

  test("absent private app token resolves to undefined", async () => {
    withSecret({ HUBSPOT_CLIENT_SECRET: "x" });

    const result = await loadAgentConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.hubspotPrivateAppToken).toBeUndefined();
  });

  test("config is cached per container — second call hits the same blob", async () => {
    withSecret({ HUBSPOT_CLIENT_SECRET: "first" });

    const r1 = await loadAgentConfigFromSecretsManager();
    expect(r1.ok).toBe(true);

    // Mutate the mock — the cache should still hold the original blob.
    withSecret({ HUBSPOT_CLIENT_SECRET: "second" });
    const r2 = await loadAgentConfigFromSecretsManager();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.config.hubspotClientSecret).toBe("first");
  });
});
