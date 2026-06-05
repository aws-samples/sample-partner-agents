/**
 * Tests for `agent-backend/lib/mcp-client.ts`.
 *
 * Strategy:
 *   - `interpretEnvelope` is tested against the actual doubly-nested
 *     wire shape we observe from the Partner Central Agent MCP Server,
 *     plus the simpler flat shape the AWS docs describe (we accept
 *     both for robustness).
 *   - Network behaviour (`createMcpClient(...).sendMessage(...)`) is
 *     tested by injecting a `fetchImpl` mock that captures the
 *     outgoing request and returns canned responses.
 *   - SigV4 signing determinism: pinned `nowMs` and `credentialsProvider`
 *     so the Authorization header is byte-stable across runs.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

import {
  createMcpClient,
  interpretEnvelope,
  __resetRpcIdForTests,
  MCP_ENDPOINT_HOST,
  MCP_ENDPOINT_PATH,
} from "../lib/mcp-client";
import { ErrorCode } from "../lib/errors";

// ---- fixtures --------------------------------------------------------------

const FIXED_CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const FIXED_NOW = new Date("2026-01-15T12:00:00Z").getTime();

beforeEach(() => {
  __resetRpcIdForTests();
});

/**
 * Build a JSON-RPC envelope matching the actual MCP server format:
 * doubly-nested with the inner envelope JSON-encoded inside
 * `result.content[0].text`.
 */
function makeNestedResult(inner: object): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(inner) }],
      isError: false,
    },
  };
}

function mockFetch(responseEnvelope: unknown, status = 200) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return {
      status,
      statusText: status === 200 ? "OK" : "ERR",
      text: async () => JSON.stringify(responseEnvelope),
    };
  };
  return { fetchImpl, calls };
}

// ===========================================================================
// interpretEnvelope — doubly-nested wire format
// ===========================================================================

describe("interpretEnvelope — actual MCP wire format", () => {
  test("ASSISTANT_RESPONSE block is normalised to a text block", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "session-abc",
        status: "complete",
        role: "assistant",
        content: [
          {
            type: "ASSISTANT_RESPONSE",
            content: { text: "Hello, sales rep" },
            timestamp: "2026-01-15T12:00:00Z",
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("complete");
      expect(result.sessionId).toBe("session-abc");
      expect(result.blocks).toEqual([
        { type: "text", text: "Hello, sales rep" },
      ]);
    }
  });

  test("multiple ASSISTANT_RESPONSE blocks become separate text blocks", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "complete",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "First part." } },
          { type: "ASSISTANT_RESPONSE", content: { text: "Second part." } },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks).toEqual([
        { type: "text", text: "First part." },
        { type: "text", text: "Second part." },
      ]);
    }
  });

  test("serverToolUse and serverToolResult blocks are dropped", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "complete",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "I'll help you." } },
          {
            type: "serverToolUse",
            content: {
              input: "{}",
              name: "thinking",
              toolUseId: "tooluse_zWMv0",
              displayToolActivity: "Calculating...",
            },
          },
          {
            type: "serverToolResult",
            content: {
              output: "Completed",
              name: "thinking",
              toolUseId: "tooluse_zWMv0",
              status: "success",
            },
          },
          { type: "ASSISTANT_RESPONSE", content: { text: "Here's the answer." } },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks).toEqual([
        { type: "text", text: "I'll help you." },
        { type: "text", text: "Here's the answer." },
      ]);
    }
  });

  test("requires_approval status surfaces approval_request block (docs-flat shape)", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "session-xyz",
        status: "requires_approval",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "I'd like to update O123." } },
          {
            type: "tool_approval_request",
            toolUseId: "tool-use-98765",
            toolName: "update_opportunity_enhanced",
            parameters: {
              opportunityId: "O1234567890",
              targetCloseDate: "2026-03-31",
            },
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("requires_approval");
      expect(result.blocks).toEqual([
        { type: "text", text: "I'd like to update O123." },
        {
          type: "approval_request",
          toolUseId: "tool-use-98765",
          toolName: "update_opportunity_enhanced",
          parameters: {
            opportunityId: "O1234567890",
            targetCloseDate: "2026-03-31",
          },
        },
      ]);
    }
  });

  test("requires_approval surfaces approval_request from the live wire shape (content.text JSON-encoded)", () => {
    // This mirrors the actual production payload captured from CloudWatch:
    //   { type: "tool_approval_request",
    //     content: { text: "<JSON-encoded {tool_use_id, tool_name, input, …}>" } }
    const innerJson = JSON.stringify({
      tool_use_id: "tooluse_yEAo0qthtHddgUgRU0sYlt",
      tool_name: "update_opportunity_enhanced",
      input: {
        payload: {
          Identifier: "O13589660",
          LifeCycle: {
            NextSteps:
              "Meeting with John Doe (CTO) on May 30 at HubSpot offices",
          },
        },
      },
      tool_description: "Tool: update_opportunity_enhanced\\nID: …",
      requires_approval: null,
      display_tool_activity: null,
    });
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "session-live",
        status: "requires_approval",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "About to update…" } },
          {
            type: "tool_approval_request",
            content: { text: innerJson },
            timestamp: "2026-05-16T00:44:04.814173+00:00",
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("requires_approval");
      // Pull the approval_request block out (text block also present).
      const approval = result.blocks.find(
        (b) => b.type === "approval_request"
      );
      expect(approval).toBeDefined();
      if (approval && approval.type === "approval_request") {
        expect(approval.toolUseId).toBe("tooluse_yEAo0qthtHddgUgRU0sYlt");
        expect(approval.toolName).toBe("update_opportunity_enhanced");
        expect(approval.parameters).toEqual({
          payload: {
            Identifier: "O13589660",
            LifeCycle: {
              NextSteps:
                "Meeting with John Doe (CTO) on May 30 at HubSpot offices",
            },
          },
        });
      }
    }
  });

  test("malformed live-shape approval (content.text not JSON) is silently dropped", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "requires_approval",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "About to…" } },
          {
            type: "tool_approval_request",
            content: { text: "{not-json" },
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the ASSISTANT_RESPONSE survives.
      expect(result.blocks).toEqual([
        { type: "text", text: "About to…" },
      ]);
    }
  });

  test("status=error inner envelope → MCP_INTERNAL", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "error",
        content: [{ type: "ASSISTANT_RESPONSE", content: { text: "boom" } }],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toMatch(/status=error/i);
    }
  });

  test("inner envelope with empty ASSISTANT_RESPONSE text is silently dropped", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "complete",
        content: [
          { type: "ASSISTANT_RESPONSE", content: { text: "" } },
          { type: "ASSISTANT_RESPONSE", content: { text: "real answer" } },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks).toEqual([{ type: "text", text: "real answer" }]);
    }
  });

  test("approval_request without parameters falls back to empty object", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "requires_approval",
        content: [
          {
            type: "tool_approval_request",
            toolUseId: "u1",
            toolName: "submit_opportunity",
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const block = result.blocks[0];
      expect(block).toBeDefined();
      if (block && block.type === "approval_request") {
        expect(block.parameters).toEqual({});
      }
    }
  });
});

// ===========================================================================
// interpretEnvelope — backward compat with simpler documented shape
// ===========================================================================

describe("interpretEnvelope — flat (documented) wire format fallback", () => {
  test("flat 'text' block in inner envelope is accepted", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "complete",
        content: [{ type: "text", text: "Plain text answer" }],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks).toEqual([
        { type: "text", text: "Plain text answer" },
      ]);
    }
  });
});

// ===========================================================================
// interpretEnvelope — error paths
// ===========================================================================

describe("interpretEnvelope — error mapping", () => {
  test("error -32001 → MCP_AUTH_FAILURE", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32001,
        message:
          "Authentication failed. Verify your SigV4 credentials and ensure they have not expired.",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_AUTH_FAILURE);
      expect(result.rpcCode).toBe(-32001);
      expect(result.rpcMessage).toContain("Authentication failed");
    }
  });

  test("error -31004 → MCP_PERMISSION_DENIED", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -31004, message: "IAM identity lacks UpdateOpportunity" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_PERMISSION_DENIED);
      expect(result.rpcCode).toBe(-31004);
    }
  });

  test("error -32002 → MCP_ACCESS_DENIED", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -32002, message: "Account not enrolled" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_ACCESS_DENIED);
  });

  test("error -32004 → MCP_RATE_LIMITED", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -32004, message: "Rate limit exceeded" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_RATE_LIMITED);
  });

  test("error -30001 → MCP_NOT_FOUND", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -30001, message: "Session not found" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_NOT_FOUND);
  });

  test("error -32600 → MCP_BAD_REQUEST", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid request" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_BAD_REQUEST);
  });

  test("error -32603 (and unknown codes) → MCP_INTERNAL", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal" },
    });
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_INTERNAL);

    const result2 = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -99999, message: "From the future" },
    });
    if (!result2.ok) expect(result2.code).toBe(ErrorCode.MCP_INTERNAL);
  });

  test("missing both result and error → MCP_INTERNAL", () => {
    const result = interpretEnvelope({ jsonrpc: "2.0", id: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
  });

  test("malformed envelope (null/array/string) → MCP_INTERNAL", () => {
    expect(interpretEnvelope(null).ok).toBe(false);
    expect(interpretEnvelope("string").ok).toBe(false);
    expect(interpretEnvelope([1, 2]).ok).toBe(false);
  });

  test("result with empty content → MCP_INTERNAL", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      result: { content: [], isError: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toMatch(/empty/i);
    }
  });

  test("result.content[0] not a text block → MCP_INTERNAL", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      result: {
        content: [{ type: "image", data: "..." }],
        isError: false,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toMatch(/not a text block/);
    }
  });

  test("inner envelope is not valid JSON → MCP_INTERNAL", () => {
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      result: {
        content: [{ type: "text", text: "{not json" }],
        isError: false,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toMatch(/not valid JSON/i);
    }
  });

  test("inner envelope with unexpected status → MCP_INTERNAL", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        sessionId: "s1",
        status: "in_progress",
        content: [],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
  });

  test("inner envelope missing sessionId → MCP_INTERNAL", () => {
    const result = interpretEnvelope(
      makeNestedResult({
        status: "complete",
        content: [],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toMatch(/sessionId/);
    }
  });

  test("rpcMessage truncated at 500 chars", () => {
    const long = "x".repeat(800);
    const result = interpretEnvelope({
      jsonrpc: "2.0",
      error: { code: -32603, message: long },
    });
    if (!result.ok) {
      expect(result.rpcMessage?.length).toBeLessThanOrEqual(501);
      expect(result.rpcMessage?.endsWith("…")).toBe(true);
    }
  });
});

// ===========================================================================
// createMcpClient — sendMessage / getSession network behaviour
// ===========================================================================

describe("createMcpClient.sendMessage", () => {
  test("posts JSON-RPC tools/call with sendMessage args, includes _meta", async () => {
    const { fetchImpl, calls } = mockFetch(
      makeNestedResult({
        sessionId: "session-new",
        status: "complete",
        content: [{ type: "ASSISTANT_RESPONSE", content: { text: "ok" } }],
      })
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
      clientInfo: { integrator: "TestCo", sourceProduct: "TestApp" },
    });

    const result = await client.sendMessage({
      catalog: "Sandbox",
      content: [{ type: "text", text: "hello" }],
    });

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.url).toBe(`https://${MCP_ENDPOINT_HOST}${MCP_ENDPOINT_PATH}`);
    expect(c.method).toBe("POST");

    const body = JSON.parse(c.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("sendMessage");
    expect(body.params.arguments).toMatchObject({
      catalog: "Sandbox",
      content: [{ type: "text", text: "hello" }],
      stream: false,
    });
    expect(body.params.arguments.sessionId).toBeUndefined();
    expect(body.params._meta).toEqual({
      integrator: "TestCo",
      sourceProduct: "TestApp",
    });
  });

  test("includes sessionId when provided", async () => {
    const { fetchImpl, calls } = mockFetch(
      makeNestedResult({
        sessionId: "session-existing",
        status: "complete",
        content: [],
      })
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    await client.sendMessage({
      catalog: "AWS",
      content: [{ type: "text", text: "follow-up" }],
      sessionId: "session-existing",
    });

    expect(calls[0]).toBeDefined();
    const body = JSON.parse(calls[0]!.body);
    expect(body.params.arguments.sessionId).toBe("session-existing");
    expect(body.params.arguments.catalog).toBe("AWS");
  });

  test("default _meta when no clientInfo passed", async () => {
    const { fetchImpl, calls } = mockFetch(
      makeNestedResult({
        sessionId: "s1",
        status: "complete",
        content: [],
      })
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    await client.sendMessage({
      catalog: "Sandbox",
      content: [{ type: "text", text: "hi" }],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.params._meta).toEqual({
      integrator: "Direct",
      sourceProduct: "HubSpot ACE Agent Card",
    });
  });

  test("approval response posts tool_approval_response block", async () => {
    const { fetchImpl, calls } = mockFetch(
      makeNestedResult({
        sessionId: "session-existing",
        status: "complete",
        content: [{ type: "ASSISTANT_RESPONSE", content: { text: "done" } }],
      })
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    await client.sendMessage({
      catalog: "Sandbox",
      sessionId: "session-existing",
      content: [
        {
          type: "tool_approval_response",
          toolUseId: "tool-use-98765",
          decision: "approve",
        },
      ],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.params.arguments.content).toEqual([
      {
        type: "tool_approval_response",
        toolUseId: "tool-use-98765",
        decision: "approve",
      },
    ]);
  });

  test("SigV4 Authorization header is present and well-formed", async () => {
    const { fetchImpl, calls } = mockFetch(
      makeNestedResult({
        sessionId: "s1",
        status: "complete",
        content: [],
      })
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    await client.sendMessage({
      catalog: "Sandbox",
      content: [{ type: "text", text: "hello" }],
    });

    expect(calls[0]).toBeDefined();
    const auth =
      calls[0]!.headers["authorization"] ??
      calls[0]!.headers["Authorization"];
    expect(auth).toBeDefined();
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(auth).toContain("Credential=AKIAIOSFODNN7EXAMPLE/");
    expect(auth).toContain("/us-east-1/partnercentral-agents-mcp/aws4_request");
    expect(auth).toContain("SignedHeaders=");
    expect(auth).toContain("Signature=");
  });

  test("network error → MCP_INTERNAL with diagnostic message", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    const result = await client.sendMessage({
      catalog: "Sandbox",
      content: [{ type: "text", text: "x" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toContain("ECONNREFUSED");
    }
  });

  test("HTTP 503 response → MCP_INTERNAL", async () => {
    const { fetchImpl } = mockFetch(
      { error: { code: -32603, message: "broken" } },
      503
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    const result = await client.sendMessage({
      catalog: "Sandbox",
      content: [{ type: "text", text: "x" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toMatch(/503/);
    }
  });

  test("non-JSON response body → MCP_INTERNAL", async () => {
    const fetchImpl = async () => ({
      status: 200,
      statusText: "OK",
      text: async () => "not actually json {{{",
    });
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    const result = await client.sendMessage({
      catalog: "Sandbox",
      content: [{ type: "text", text: "x" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.rpcMessage).toContain("Non-JSON");
    }
  });
});

describe("createMcpClient.getSession", () => {
  test("posts JSON-RPC tools/call with getSession args", async () => {
    const { fetchImpl, calls } = mockFetch(
      makeNestedResult({
        sessionId: "session-existing",
        status: "complete",
        content: [{ type: "ASSISTANT_RESPONSE", content: { text: "{}" } }],
      })
    );
    const client = createMcpClient({
      fetchImpl,
      credentialsProvider: async () => FIXED_CREDS,
      nowMs: () => FIXED_NOW,
    });

    await client.getSession({
      catalog: "Sandbox",
      sessionId: "session-existing",
    });

    expect(calls[0]).toBeDefined();
    const body = JSON.parse(calls[0]!.body);
    expect(body.params.name).toBe("getSession");
    expect(body.params.arguments).toEqual({
      sessionId: "session-existing",
      catalog: "Sandbox",
    });
  });
});
