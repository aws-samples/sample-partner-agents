import { describe, test, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

// Feature: hubspot-ace-share-refresh-buttons
// Property 6: loadConfigFromSecretsManager reports missing secrets accurately
//
// For any subset S of the required secret names, if the Secrets Manager blob has
// exactly the secrets in S unset (and all others set to non-empty values), then:
//   - S empty                 ⇒ { ok: true, config: ... }
//   - S non-empty             ⇒ { ok: false, missing: exact membership of S }
// ACE_REGION is excluded from the required set because it has a documented default.
//
// Validates: Requirements 8.5

// Module-level mock holder so each test can swap the blob returned by
// GetSecretValueCommand without re-initialising vi.mock.
let secretBlob: Record<string, string> = {};
let sendCallCount = 0;

vi.mock("@aws-sdk/client-secrets-manager", () => {
  return {
    // The real GetSecretValueCommand is a class; our mock just records the
    // input so `send()` can return the right blob.
    GetSecretValueCommand: class {
      public input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    },
    SecretsManagerClient: class {
      async send(_cmd: unknown): Promise<{ SecretString: string }> {
        sendCallCount += 1;
        return { SecretString: JSON.stringify(secretBlob) };
      }
    },
  };
});

// Import the module under test AFTER vi.mock is registered so the
// SecretsManagerClient constructor at module load picks up the mock.
const configModule = await import("../lib/config");
const {
  loadConfigFromSecretsManager,
  loadAuthConfigFromSecretsManager,
  REQUIRED_SECRET_NAMES,
  __clearConfigCache,
} = configModule;

/**
 * Build a fully-populated blob, then delete the given subset of required
 * secret names (and optionally overwrite ACE_REGION / STAGE_DISPLAY_NAMES
 * / HUBSPOT_CLIENT_SECRET to arbitrary values).
 */
function buildBlob(options: {
  unset?: readonly string[];
  whitespaceKeys?: readonly string[];
  whitespaceValue?: string;
  aceRegion?: string;
  includeClientSecret?: boolean;
}): Record<string, string> {
  const blob: Record<string, string> = {};
  for (const key of REQUIRED_SECRET_NAMES) {
    blob[key] = `value-for-${key}`;
  }
  // STAGE_DISPLAY_NAMES + ACE_REGION are optional per-loader; pre-populate
  // ACE_REGION so tests can distinguish "default applied" from "provided".
  if (options.aceRegion !== undefined) blob.ACE_REGION = options.aceRegion;
  blob.STAGE_DISPLAY_NAMES = "qualified=Qualified";
  if (options.includeClientSecret)
    blob.HUBSPOT_CLIENT_SECRET = "client-secret-abc123";
  for (const key of options.unset ?? []) delete blob[key];
  for (const key of options.whitespaceKeys ?? []) {
    blob[key] = options.whitespaceValue ?? "";
  }
  return blob;
}

describe("loadConfigFromSecretsManager — Property 6", () => {
  beforeEach(() => {
    __clearConfigCache();
    sendCallCount = 0;
  });

  test("missing-set equals the unset subset of required secrets", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(REQUIRED_SECRET_NAMES as unknown as string[]),
        async (unsetSubset) => {
          __clearConfigCache();
          secretBlob = buildBlob({
            unset: unsetSubset,
            aceRegion: "us-west-2",
          });

          const result = await loadConfigFromSecretsManager();
          if (unsetSubset.length === 0) {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.config.aceRegion).toBe("us-west-2");
            }
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              // missing is the exact set (order-insensitive).
              expect(new Set(result.missing)).toEqual(new Set(unsetSubset));
              expect(result.missing.length).toBe(unsetSubset.length);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("whitespace-only secret values are treated as missing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(REQUIRED_SECRET_NAMES as unknown as string[]),
        fc.constantFrom("", " ", "\t", "\n", "   \t\n "),
        async (whitespaceSubset, blank) => {
          __clearConfigCache();
          secretBlob = buildBlob({
            whitespaceKeys: whitespaceSubset,
            whitespaceValue: blank,
          });

          const result = await loadConfigFromSecretsManager();
          if (whitespaceSubset.length === 0) {
            expect(result.ok).toBe(true);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(new Set(result.missing)).toEqual(new Set(whitespaceSubset));
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("ACE_REGION absent returns config with default 'us-east-1'", async () => {
    __clearConfigCache();
    secretBlob = buildBlob({});
    delete secretBlob.ACE_REGION;
    const result = await loadConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.aceRegion).toBe("us-east-1");
    }
  });

  test("parsed blob is cached per container across multiple loads", async () => {
    __clearConfigCache();
    secretBlob = buildBlob({});
    const first = await loadConfigFromSecretsManager();
    const second = await loadConfigFromSecretsManager();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Two loader calls → one underlying send() (cache hit on second call).
    expect(sendCallCount).toBe(1);
  });

  test("__clearConfigCache() forces a fresh fetch on next load", async () => {
    __clearConfigCache();
    secretBlob = buildBlob({});
    await loadConfigFromSecretsManager();
    __clearConfigCache();
    await loadConfigFromSecretsManager();
    expect(sendCallCount).toBe(2);
  });
});

describe("loadAuthConfigFromSecretsManager — Property 6 (auth surface)", () => {
  beforeEach(() => {
    __clearConfigCache();
    sendCallCount = 0;
  });

  test("HUBSPOT_CLIENT_SECRET present returns the client secret", async () => {
    secretBlob = buildBlob({ includeClientSecret: true });
    const result = await loadAuthConfigFromSecretsManager();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.hubspotClientSecret).toBe("client-secret-abc123");
    }
  });

  test("HUBSPOT_CLIENT_SECRET absent reports it as missing", async () => {
    secretBlob = buildBlob({ includeClientSecret: false });
    const result = await loadAuthConfigFromSecretsManager();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["HUBSPOT_CLIENT_SECRET"]);
    }
  });

  test("HUBSPOT_CLIENT_SECRET whitespace-only reports it as missing", async () => {
    secretBlob = buildBlob({ includeClientSecret: false });
    secretBlob.HUBSPOT_CLIENT_SECRET = "   \t  ";
    const result = await loadAuthConfigFromSecretsManager();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["HUBSPOT_CLIENT_SECRET"]);
    }
  });
});
