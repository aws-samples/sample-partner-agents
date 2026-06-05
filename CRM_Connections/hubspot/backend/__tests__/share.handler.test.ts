/**
 * Handler-wrapper tests for `backend/handlers/share.ts` (task 5.4).
 *
 * These tests exercise only the Lambda wrapper layer — the event parsing,
 * secrets loading, and response serialisation. The underlying `runShare`
 * orchestration is covered separately in `share.test.ts`.
 *
 * To avoid pulling in the real AWS SDK clients we mock three things:
 *   - `../lib/config` — so the test can swap between "secrets present"
 *     and "secrets missing" without constructing a real SecretsManagerClient.
 *   - `../lib/ace` / `../lib/hubspot` — their factory functions are
 *     called by the wrapper but the resulting clients are never invoked
 *     here (because we also mock `runShare`). Stubbing the factories
 *     keeps the wrapper code paths callable.
 *   - `../core/run-share` — so tests can control what `runShare` returns
 *     (success / precondition / etc.) and assert the HTTP status code
 *     derived by the wrapper.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2WithRequestContext } from "aws-lambda";

// ---- Mocks ----

let configResult:
  | { ok: true; config: Record<string, string> }
  | { ok: false; missing: string[] };

let authConfigResult:
  | { ok: true; config: { hubspotClientSecret: string } }
  | { ok: false; missing: string[] };

let signatureResult:
  | { ok: true; identity: Record<string, string> }
  | { ok: false; reason: string } = {
  ok: true,
  identity: { hubId: "1", userId: "2", appId: "3", userEmail: "x@y.z" },
};

vi.mock("../lib/config", () => {
  return {
    ACE_CATALOG: "Sandbox" as const,
    loadConfigFromSecretsManager: async () => configResult,
    loadAuthConfigFromSecretsManager: async () => authConfigResult,
  };
});

vi.mock("../lib/hubspot-signature", () => ({
  verifyHubspotSignature: () => signatureResult,
}));

vi.mock("../lib/ace", () => ({
  createAceClient: () => ({}),
  ACEThrottledError: class extends Error {},
}));

vi.mock("../lib/hubspot", () => ({
  createHubspotClient: () => ({}),
}));

const runShareMock = vi.fn();
vi.mock("../core/run-share", () => ({
  runShare: (...args: unknown[]) => runShareMock(...args),
}));

// Import AFTER mocks are registered.
const { handler } = await import("../handlers/share");

// ---- Helpers ----

function makeEvent(
  body: string | undefined,
  isBase64Encoded = false
): APIGatewayProxyEventV2WithRequestContext<unknown> {
  return {
    version: "2.0",
    routeKey: "POST /share",
    rawPath: "/share",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "test",
      domainPrefix: "test",
      http: {
        method: "POST",
        path: "/share",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-abc-123",
      routeKey: "POST /share",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body,
    isBase64Encoded,
  } as unknown as APIGatewayProxyEventV2WithRequestContext<unknown>;
}

// ---- Tests ----

describe("handlers/share.handler", () => {
  beforeEach(() => {
    runShareMock.mockReset();
    // Default: signature OK.
    signatureResult = {
      ok: true,
      identity: { hubId: "1", userId: "2", appId: "3", userEmail: "x@y.z" },
    };
    // Default: auth config (client secret) present.
    authConfigResult = {
      ok: true,
      config: { hubspotClientSecret: "test-secret" },
    };
    // Default: secrets present.
    configResult = {
      ok: true,
      config: {
        awsAccessKeyId: "AKIA",
        awsSecretAccessKey: "secret",
        aceRegion: "us-east-1",
        stageMappingRaw: "qualified=Qualified",
        stageDisplayNamesRaw: "",
        hubspotPrivateAppToken: "pat-xyz",
      },
    };
  });

  test("well-formed event → 200 with success envelope", async () => {
    runShareMock.mockResolvedValueOnce({
      ok: true,
      message: "Created ACE opportunity O12345",
      properties: {
        ace_opportunity_id: "O12345",
        ace_sync_status: "Submitted",
        ace_last_sync: "2026-04-30T00:00:00Z",
        ace_sync_error: "",
      },
    });

    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
    });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(true);
    expect(body.properties.ace_opportunity_id).toBe("O12345");

    // runShare received dealId 42.
    expect(runShareMock).toHaveBeenCalledTimes(1);
    expect(runShareMock.mock.calls[0][0]).toBe(42);
  });

  test("missing body → 400 INTERNAL", async () => {
    const result = await handler(makeEvent(undefined));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("INTERNAL");
    expect(runShareMock).not.toHaveBeenCalled();
  });

  test("non-JSON body → 400 INTERNAL", async () => {
    const result = await handler(makeEvent("this is not json"));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("INTERNAL");
    expect(runShareMock).not.toHaveBeenCalled();
  });

  test("missing dealId → 400 INTERNAL", async () => {
    const result = await handler(makeEvent(JSON.stringify({})));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("INTERNAL");
  });

  test("non-numeric dealId → 400 INTERNAL", async () => {
    const result = await handler(makeEvent(JSON.stringify({ dealId: "42" })));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("base64-encoded body is decoded before parsing", async () => {
    runShareMock.mockResolvedValueOnce({
      ok: true,
      message: "ok",
      properties: {
        ace_opportunity_id: "O1",
        ace_sync_status: "Submitted",
        ace_last_sync: "t",
        ace_sync_error: "",
      },
    });
    const bodyBytes = Buffer.from(JSON.stringify({ dealId: 99 })).toString("base64");
    const result = await handler(makeEvent(bodyBytes, true));
    expect(result).toMatchObject({ statusCode: 200 });
    expect(runShareMock.mock.calls[0][0]).toBe(99);
  });

  test("MISSING_SECRET → 500 with missingSecrets detail", async () => {
    configResult = {
      ok: false,
      missing: ["STAGE_MAPPING", "HUBSPOT_PRIVATE_APP_TOKEN"],
    };
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("MISSING_SECRET");
    expect(body.details.missingSecrets).toEqual([
      "STAGE_MAPPING",
      "HUBSPOT_PRIVATE_APP_TOKEN",
    ]);
    expect(runShareMock).not.toHaveBeenCalled();
  });

  test("PRECONDITION from runShare → 422", async () => {
    runShareMock.mockResolvedValueOnce({
      ok: false,
      code: "PRECONDITION",
      message: "Cannot share: closedate, amount",
      details: { preconditionFailures: ["closedate", "amount"] },
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 422 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("PRECONDITION");
  });

  test("STALE_OPPORTUNITY from runShare → 409", async () => {
    runShareMock.mockResolvedValueOnce({
      ok: false,
      code: "STALE_OPPORTUNITY",
      message: "Refresh then Share",
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 409 });
  });

  test("ACE_THROTTLED from runShare → 503", async () => {
    runShareMock.mockResolvedValueOnce({
      ok: false,
      code: "ACE_THROTTLED",
      message: "Throttled",
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 503 });
  });

  test("ACE_CREATE from runShare → 502", async () => {
    runShareMock.mockResolvedValueOnce({
      ok: false,
      code: "ACE_CREATE",
      message: "CreateOpportunity failed: boom",
      details: { step: "CreateOpportunity" },
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 502 });
  });
});
