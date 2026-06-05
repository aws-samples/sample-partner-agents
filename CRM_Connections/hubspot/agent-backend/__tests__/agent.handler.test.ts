/**
 * Tests for `agent-backend/handlers/agent.ts`.
 *
 * Strategy: mock the config loader, signature verifier, MCP client
 * factory, and `runAgent`. Then probe body parsing, error-status mapping,
 * and the happy path.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2WithRequestContext } from "aws-lambda";

let configResult:
  | { ok: true; config: { hubspotClientSecret: string; aceAgentCatalog: "Sandbox" | "AWS" } }
  | { ok: false; missing: string[] };

let signatureResult:
  | { ok: true; identity: Record<string, string> }
  | { ok: false; reason: string };

vi.mock("../lib/config", () => ({
  loadAgentConfigFromSecretsManager: async () => configResult,
}));

vi.mock("../lib/hubspot-signature", () => ({
  verifyHubspotSignature: () => signatureResult,
}));

vi.mock("../lib/mcp-client", () => ({
  createMcpClient: () => ({}),
}));

const runAgentMock = vi.fn();
vi.mock("../core/run-agent", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

const { handler } = await import("../handlers/agent");

function makeEvent(
  body: string | undefined
): APIGatewayProxyEventV2WithRequestContext<unknown> {
  return {
    version: "2.0",
    routeKey: "POST /agent",
    rawPath: "/agent",
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "test",
      domainPrefix: "test",
      http: {
        method: "POST",
        path: "/agent",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-agent-1",
      routeKey: "POST /agent",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithRequestContext<unknown>;
}

describe("handlers/agent.handler", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    configResult = {
      ok: true,
      config: {
        hubspotClientSecret: "test-secret",
        aceAgentCatalog: "Sandbox",
      },
    };
    signatureResult = {
      ok: true,
      identity: { hubId: "1", userId: "2", appId: "3", userEmail: "x@y.z" },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("happy path text message → 200 with success envelope", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: true,
      status: "complete",
      sessionId: "session-1",
      blocks: [{ type: "text", text: "hello back" }],
    });

    const result = await handler(
      makeEvent(
        JSON.stringify({ dealId: 42, message: { type: "text", text: "Hi" } })
      )
    );
    expect(result).toMatchObject({
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
    });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("complete");
    expect(runAgentMock.mock.calls[0][0]).toEqual({
      dealId: 42,
      message: { type: "text", text: "Hi" },
    });
  });

  test("requires_approval status passed through with status 200", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: true,
      status: "requires_approval",
      sessionId: "session-1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "submit_opportunity",
          parameters: {},
        },
      ],
    });

    const result = await handler(
      makeEvent(
        JSON.stringify({ dealId: 1, message: { type: "text", text: "go" } })
      )
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.status).toBe("requires_approval");
  });

  test("approval response forwards correctly", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: true,
      status: "complete",
      sessionId: "session-1",
      blocks: [],
    });

    await handler(
      makeEvent(
        JSON.stringify({
          dealId: 1,
          sessionId: "session-1",
          message: {
            type: "tool_approval_response",
            toolUseId: "u1",
            decision: "approve",
          },
        })
      )
    );

    expect(runAgentMock.mock.calls[0][0]).toEqual({
      dealId: 1,
      sessionId: "session-1",
      message: {
        type: "tool_approval_response",
        toolUseId: "u1",
        decision: "approve",
      },
    });
  });

  test("override decision with message preserved", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [],
    });

    await handler(
      makeEvent(
        JSON.stringify({
          dealId: 1,
          sessionId: "s1",
          message: {
            type: "tool_approval_response",
            toolUseId: "u1",
            decision: "override",
            message: "Use 250000",
          },
        })
      )
    );

    expect(runAgentMock.mock.calls[0][0].message.message).toBe("Use 250000");
  });

  test("missing dealId → 400 INTERNAL", async () => {
    const result = await handler(
      makeEvent(JSON.stringify({ message: { type: "text", text: "x" } }))
    );
    expect(result).toMatchObject({ statusCode: 400 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("INTERNAL");
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  test("non-numeric dealId → 400 INTERNAL", async () => {
    const result = await handler(
      makeEvent(
        JSON.stringify({ dealId: "fourtytwo", message: { type: "text", text: "x" } })
      )
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("malformed JSON body → 400 INTERNAL", async () => {
    const result = await handler(makeEvent("{not json"));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("missing message → 400 INTERNAL", async () => {
    const result = await handler(makeEvent(JSON.stringify({ dealId: 1 })));
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("unknown message type → 400 INTERNAL", async () => {
    const result = await handler(
      makeEvent(
        JSON.stringify({
          dealId: 1,
          message: { type: "rocket_launch", text: "ignite" },
        })
      )
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("approval response missing toolUseId → 400 INTERNAL", async () => {
    const result = await handler(
      makeEvent(
        JSON.stringify({
          dealId: 1,
          message: {
            type: "tool_approval_response",
            decision: "approve",
          },
        })
      )
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("approval response with bad decision → 400 INTERNAL", async () => {
    const result = await handler(
      makeEvent(
        JSON.stringify({
          dealId: 1,
          message: {
            type: "tool_approval_response",
            toolUseId: "u1",
            decision: "maybe",
          },
        })
      )
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  test("MISSING_SECRET → 500", async () => {
    configResult = { ok: false, missing: ["HUBSPOT_CLIENT_SECRET"] };
    const result = await handler(
      makeEvent(JSON.stringify({ dealId: 1, message: { type: "text", text: "x" } }))
    );
    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("MISSING_SECRET");
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  test("invalid signature → 401 AUTH_INVALID", async () => {
    signatureResult = { ok: false, reason: "invalid_signature" };
    const result = await handler(
      makeEvent(JSON.stringify({ dealId: 1, message: { type: "text", text: "x" } }))
    );
    expect(result).toMatchObject({ statusCode: 401 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("AUTH_INVALID");
  });

  test("MCP_RATE_LIMITED from runAgent → 503", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: false,
      code: "MCP_RATE_LIMITED",
      message: "AWS rate-limited the request. Wait a moment and try again.",
    });
    const result = await handler(
      makeEvent(JSON.stringify({ dealId: 1, message: { type: "text", text: "x" } }))
    );
    expect(result).toMatchObject({ statusCode: 503 });
  });

  test("MCP_PERMISSION_DENIED from runAgent → 502", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: false,
      code: "MCP_PERMISSION_DENIED",
      message: "Your AWS Partner Central role doesn't allow this action.",
    });
    const result = await handler(
      makeEvent(JSON.stringify({ dealId: 1, message: { type: "text", text: "x" } }))
    );
    expect(result).toMatchObject({ statusCode: 502 });
  });

  test("MCP_NOT_FOUND from runAgent → 404", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: false,
      code: "MCP_NOT_FOUND",
      message: "Resource not found.",
    });
    const result = await handler(
      makeEvent(JSON.stringify({ dealId: 1, message: { type: "text", text: "x" } }))
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  test("base64-encoded body decoded before parse", async () => {
    runAgentMock.mockResolvedValueOnce({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [],
    });
    const json = JSON.stringify({
      dealId: 99,
      message: { type: "text", text: "encoded" },
    });
    const evt = makeEvent(Buffer.from(json).toString("base64"));
    evt.isBase64Encoded = true;

    const result = await handler(evt);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(runAgentMock.mock.calls[0][0].dealId).toBe(99);
  });
});
