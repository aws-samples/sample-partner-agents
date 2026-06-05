/**
 * Handler-wrapper tests for `backend/handlers/refresh.ts` (task 5.4).
 *
 * Mirrors the structure of `share.handler.test.ts`: mocks the config
 * loader, the client factories, and `runRefresh`, then exercises the
 * wrapper's event-parsing and response-serialisation logic.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2WithRequestContext } from "aws-lambda";

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

vi.mock("../lib/config", () => ({
  ACE_CATALOG: "Sandbox" as const,
  loadConfigFromSecretsManager: async () => configResult,
  loadAuthConfigFromSecretsManager: async () => authConfigResult,
}));

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

const runRefreshMock = vi.fn();
vi.mock("../core/run-refresh", () => ({
  runRefresh: (...args: unknown[]) => runRefreshMock(...args),
}));

const { handler } = await import("../handlers/refresh");

function makeEvent(
  body: string | undefined
): APIGatewayProxyEventV2WithRequestContext<unknown> {
  return {
    version: "2.0",
    routeKey: "POST /refresh",
    rawPath: "/refresh",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "test",
      domainPrefix: "test",
      http: {
        method: "POST",
        path: "/refresh",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-refresh-1",
      routeKey: "POST /refresh",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithRequestContext<unknown>;
}

describe("handlers/refresh.handler", () => {
  beforeEach(() => {
    runRefreshMock.mockReset();
    signatureResult = {
      ok: true,
      identity: { hubId: "1", userId: "2", appId: "3", userEmail: "x@y.z" },
    };
    authConfigResult = {
      ok: true,
      config: { hubspotClientSecret: "test-secret" },
    };
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
    runRefreshMock.mockResolvedValueOnce({
      ok: true,
      message: "Refreshed — stage Qualified, Submitted — awaiting AWS acceptance",
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
    expect(runRefreshMock.mock.calls[0][0]).toBe(42);
  });

  test("missing dealId → 400 INTERNAL", async () => {
    const result = await handler(makeEvent(JSON.stringify({})));
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("INTERNAL");
    expect(runRefreshMock).not.toHaveBeenCalled();
  });

  test("MISSING_SECRET → 500", async () => {
    configResult = { ok: false, missing: ["HUBSPOT_PRIVATE_APP_TOKEN"] };
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("MISSING_SECRET");
    expect(runRefreshMock).not.toHaveBeenCalled();
  });

  test("PRECONDITION (deal not yet shared) → 422", async () => {
    runRefreshMock.mockResolvedValueOnce({
      ok: false,
      code: "PRECONDITION",
      message: "This deal has not been shared yet. Click Share first.",
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 422 });
  });

  test("ACE_GET from runRefresh → 502", async () => {
    runRefreshMock.mockResolvedValueOnce({
      ok: false,
      code: "ACE_GET",
      message: "GetOpportunity failed: boom",
      details: { step: "GetOpportunity" },
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 502 });
  });

  test("ACE_GET_SUMMARY from runRefresh → 502", async () => {
    runRefreshMock.mockResolvedValueOnce({
      ok: false,
      code: "ACE_GET_SUMMARY",
      message: "GetAwsOpportunitySummary failed",
      details: { step: "GetAwsOpportunitySummary" },
    });
    const result = await handler(makeEvent(JSON.stringify({ dealId: 42 })));
    expect(result).toMatchObject({ statusCode: 502 });
  });
});
