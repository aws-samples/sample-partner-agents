/**
 * Tests for `agent-backend/handlers/agent-async.ts`.
 *
 * Coverage:
 *   - Start handler writes a pending job, dispatches a worker, returns
 *     202 + jobId.
 *   - Poll handler reads the job and surfaces complete / running /
 *     not-found correctly.
 *   - Worker invocation marks running, calls runAgent, marks complete.
 *   - Auth + body validation paths return the expected status codes.
 *
 * Strategy: same mocking pattern as agent.handler.test.ts — replace the
 * config loader, signature verifier, MCP client factory, runAgent, plus
 * the job-store and lambda-invoke modules with controllable doubles.
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

const putPendingJobMock = vi.fn();
const markRunningMock = vi.fn();
const markCompleteMock = vi.fn();
const markFailedWithErrorMock = vi.fn();
const getJobMock = vi.fn();

vi.mock("../lib/job-store", () => ({
  putPendingJob: (...args: unknown[]) => putPendingJobMock(...args),
  markRunning: (...args: unknown[]) => markRunningMock(...args),
  markComplete: (...args: unknown[]) => markCompleteMock(...args),
  markFailedWithError: (...args: unknown[]) => markFailedWithErrorMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...args),
}));

const lambdaSendMock = vi.fn();
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send(...args: unknown[]) {
      return lambdaSendMock(...args);
    }
  },
  InvokeCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { handler } = await import("../handlers/agent-async");

function makeApiEvent(args: {
  routeKey: "POST /agent/start" | "GET /agent/poll";
  body?: string;
  query?: Record<string, string>;
  method?: "GET" | "POST";
}): APIGatewayProxyEventV2WithRequestContext<unknown> {
  return {
    version: "2.0",
    routeKey: args.routeKey,
    rawPath: args.routeKey.split(" ")[1],
    rawQueryString: args.query
      ? new URLSearchParams(args.query).toString()
      : "",
    headers: {},
    queryStringParameters: args.query,
    requestContext: {
      accountId: "test",
      apiId: "test",
      domainName: "test",
      domainPrefix: "test",
      http: {
        method: args.method ?? "POST",
        path: args.routeKey.split(" ")[1],
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-async-1",
      routeKey: args.routeKey,
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body: args.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithRequestContext<unknown>;
}

describe("agent-async — start handler", () => {
  beforeEach(() => {
    putPendingJobMock.mockReset();
    lambdaSendMock.mockReset();
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

  test("happy path: writes pending job, dispatches worker, returns 202 + jobId", async () => {
    putPendingJobMock.mockResolvedValueOnce(undefined);
    lambdaSendMock.mockResolvedValueOnce({});

    const result = await handler(
      makeApiEvent({
        routeKey: "POST /agent/start",
        body: JSON.stringify({
          dealId: 42,
          message: { type: "text", text: "Hi" },
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 202 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(true);
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(20);

    expect(putPendingJobMock).toHaveBeenCalledTimes(1);
    expect(putPendingJobMock.mock.calls[0][0]).toMatchObject({
      jobId: body.jobId,
      request: {
        dealId: 42,
        message: { type: "text", text: "Hi" },
      },
    });
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
  });

  test("missing client secret → 500 with MISSING_SECRET", async () => {
    configResult = { ok: false, missing: ["HUBSPOT_CLIENT_SECRET"] };

    const result = await handler(
      makeApiEvent({
        routeKey: "POST /agent/start",
        body: JSON.stringify({
          dealId: 42,
          message: { type: "text", text: "Hi" },
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 500 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.code).toBe("MISSING_SECRET");
    expect(putPendingJobMock).not.toHaveBeenCalled();
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  test("invalid signature → 401", async () => {
    signatureResult = { ok: false, reason: "invalid_signature" };

    const result = await handler(
      makeApiEvent({
        routeKey: "POST /agent/start",
        body: JSON.stringify({
          dealId: 42,
          message: { type: "text", text: "Hi" },
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 401 });
    expect(putPendingJobMock).not.toHaveBeenCalled();
  });

  test("malformed body → 400", async () => {
    const result = await handler(
      makeApiEvent({
        routeKey: "POST /agent/start",
        body: "not json",
      }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(putPendingJobMock).not.toHaveBeenCalled();
  });

  test("self-invoke failure: marks job errored, returns 500", async () => {
    putPendingJobMock.mockResolvedValueOnce(undefined);
    lambdaSendMock.mockRejectedValueOnce(new Error("invoke failed"));

    const result = await handler(
      makeApiEvent({
        routeKey: "POST /agent/start",
        body: JSON.stringify({
          dealId: 42,
          message: { type: "text", text: "Hi" },
        }),
      }),
    );

    expect(result).toMatchObject({ statusCode: 500 });
    expect(markFailedWithErrorMock).toHaveBeenCalledTimes(1);
    expect(
      markFailedWithErrorMock.mock.calls[0][0].errorMessage,
    ).toContain("invoke failed");
  });
});

describe("agent-async — poll handler", () => {
  beforeEach(() => {
    getJobMock.mockReset();
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

  test("complete job → 200 with response body", async () => {
    getJobMock.mockResolvedValueOnce({
      jobId: "job-1",
      status: "complete",
      dealId: 42,
      response: {
        ok: true,
        status: "complete",
        sessionId: "session-1",
        blocks: [{ type: "text", text: "hello" }],
      },
      createdAt: "2026-05-22T10:00:00Z",
      updatedAt: "2026-05-22T10:00:30Z",
    });

    const result = await handler(
      makeApiEvent({
        routeKey: "GET /agent/poll",
        method: "GET",
        query: { jobId: "job-1" },
      }),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("complete");
    expect(body.response.ok).toBe(true);
    expect(body.response.blocks[0].text).toBe("hello");
  });

  test("pending job → 200 with status pending and no response yet", async () => {
    getJobMock.mockResolvedValueOnce({
      jobId: "job-2",
      status: "pending",
      dealId: 42,
      createdAt: "2026-05-22T10:00:00Z",
      updatedAt: "2026-05-22T10:00:00Z",
    });

    const result = await handler(
      makeApiEvent({
        routeKey: "GET /agent/poll",
        method: "GET",
        query: { jobId: "job-2" },
      }),
    );

    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.response).toBeUndefined();
  });

  test("missing jobId query parameter → 400", async () => {
    const result = await handler(
      makeApiEvent({ routeKey: "GET /agent/poll", method: "GET" }),
    );

    expect(result).toMatchObject({ statusCode: 400 });
    expect(getJobMock).not.toHaveBeenCalled();
  });

  test("unknown jobId → 404", async () => {
    getJobMock.mockResolvedValueOnce(undefined);

    const result = await handler(
      makeApiEvent({
        routeKey: "GET /agent/poll",
        method: "GET",
        query: { jobId: "does-not-exist" },
      }),
    );

    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe("agent-async — worker invocation", () => {
  beforeEach(() => {
    markRunningMock.mockReset();
    markCompleteMock.mockReset();
    markFailedWithErrorMock.mockReset();
    runAgentMock.mockReset();
    configResult = {
      ok: true,
      config: {
        hubspotClientSecret: "test-secret",
        aceAgentCatalog: "Sandbox",
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("worker calls runAgent and writes the response to the job store", async () => {
    markRunningMock.mockResolvedValueOnce(undefined);
    markCompleteMock.mockResolvedValueOnce(undefined);
    runAgentMock.mockResolvedValueOnce({
      ok: true,
      status: "complete",
      sessionId: "session-1",
      blocks: [{ type: "text", text: "hi" }],
    });

    // Worker events are plain JSON payloads with the magic discriminator.
    const result = await handler({
      __workerInvocation: true,
      jobId: "job-99",
      request: {
        dealId: 42,
        message: { type: "text", text: "Hi" },
      },
    } as unknown as APIGatewayProxyEventV2WithRequestContext<unknown>);

    expect(result).toEqual({ ok: true });
    expect(markRunningMock).toHaveBeenCalledTimes(1);
    expect(markRunningMock.mock.calls[0][0]).toBe("job-99");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(markCompleteMock).toHaveBeenCalledTimes(1);
    expect(markCompleteMock.mock.calls[0][0]).toMatchObject({
      jobId: "job-99",
      response: { ok: true, status: "complete" },
    });
  });

  test("worker exception → marks failed with error message", async () => {
    markRunningMock.mockResolvedValueOnce(undefined);
    markCompleteMock.mockResolvedValueOnce(undefined);
    runAgentMock.mockRejectedValueOnce(new Error("MCP timed out"));

    await handler({
      __workerInvocation: true,
      jobId: "job-100",
      request: {
        dealId: 42,
        message: { type: "text", text: "Hi" },
      },
    } as unknown as APIGatewayProxyEventV2WithRequestContext<unknown>);

    // The wrapping `runAgentSafely` converts the throw into an
    // ErrorResponse and stores it via markComplete (which records
    // status=error since response.ok is false).
    expect(markCompleteMock).toHaveBeenCalledTimes(1);
    const stored = markCompleteMock.mock.calls[0][0].response;
    expect(stored.ok).toBe(false);
    expect(stored.code).toBe("INTERNAL");
    expect(stored.message).toContain("Worker crashed");
    expect(stored.message).toContain("MCP timed out");
  });
});
