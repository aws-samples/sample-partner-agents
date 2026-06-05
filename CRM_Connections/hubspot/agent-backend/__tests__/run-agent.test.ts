/**
 * Tests for `agent-backend/core/run-agent.ts`.
 *
 * Strategy: provide a literal-object `McpClient` mock and a literal
 * `fetchContextImpl` mock. Assert what gets sent to `mcp.sendMessage`
 * (specifically the deal-context preamble injection for text messages
 * and the absence thereof for approval responses) and what response
 * envelope is returned.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

import { runAgent } from "../core/run-agent";
import type { AgentConfig } from "../lib/config";
import type { McpClient, MCPCallResult } from "../lib/mcp-client";
import { ErrorCode } from "../lib/errors";

// ---- helpers ---------------------------------------------------------------

type SendMessageArgs = Parameters<McpClient["sendMessage"]>[0];

function makeMcpMock(canned: MCPCallResult): {
  client: McpClient;
  calls: SendMessageArgs[];
} {
  const calls: SendMessageArgs[] = [];
  return {
    calls,
    client: {
      async sendMessage(args) {
        calls.push(args);
        return canned;
      },
      async getSession() {
        throw new Error("not used");
      },
    },
  };
}

const baseConfigSandbox: AgentConfig = {
  hubspotClientSecret: "hcs",
  aceAgentCatalog: "Sandbox",
};

const baseConfigAws: AgentConfig = {
  hubspotClientSecret: "hcs",
  aceAgentCatalog: "AWS",
};

const okComplete: MCPCallResult = {
  ok: true,
  status: "complete",
  sessionId: "session-abc",
  blocks: [{ type: "text", text: "ok" }],
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ---- text message ---------------------------------------------------------

describe("runAgent — text message", () => {
  test("forwards plain text without preamble when no HubSpot token", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    const result = await runAgent(
      { dealId: 42, message: { type: "text", text: "What's blocking O123?" } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.content).toEqual([
      { type: "text", text: "What's blocking O123?" },
    ]);
    expect(calls[0]!.catalog).toBe("Sandbox");
  });

  test("prepends deal-context preamble when token is configured", async () => {
    const { client, calls } = makeMcpMock(okComplete);
    const fetchContextImpl = vi.fn().mockResolvedValue({
      dealId: 42,
      dealname: "Acme Corp Cloud Migration",
      aceOpportunityId: "O1234567890",
      aceSyncStatus: "Submitted",
      aceAwsAccountId: "123456789012",
    });

    await runAgent(
      { dealId: 42, message: { type: "text", text: "Update target close date" } },
      {
        config: { ...baseConfigSandbox, hubspotPrivateAppToken: "pat-xyz" },
        mcp: client,
        fetchContextImpl,
      }
    );

    expect(fetchContextImpl).toHaveBeenCalledWith(42, expect.any(Object));
    expect(calls[0]!.content.length).toBe(2);
    const first = calls[0]!.content[0]!;
    expect(first.type).toBe("text");
    if (first.type === "text") {
      expect(first.text).toContain("HubSpot deal id 42");
      expect(first.text).toContain('name "Acme Corp Cloud Migration"');
      expect(first.text).toContain("ACE opportunity O1234567890");
      expect(first.text).toContain("AWS account 123456789012");
    }
    const second = calls[0]!.content[1]!;
    expect(second).toEqual({ type: "text", text: "Update target close date" });
  });

  test("token configured but HubSpot fetch fails → no preamble, still forwards", async () => {
    const { client, calls } = makeMcpMock(okComplete);
    const fetchContextImpl = vi.fn().mockResolvedValue(undefined);

    const result = await runAgent(
      { dealId: 42, message: { type: "text", text: "Hi" } },
      {
        config: { ...baseConfigSandbox, hubspotPrivateAppToken: "pat-xyz" },
        mcp: client,
        fetchContextImpl,
      }
    );

    expect(result.ok).toBe(true);
    expect(calls[0]!.content).toEqual([{ type: "text", text: "Hi" }]);
  });

  test("includes sessionId on follow-up turns", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    await runAgent(
      {
        dealId: 42,
        sessionId: "session-prior",
        message: { type: "text", text: "Tell me more" },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(calls[0]!.sessionId).toBe("session-prior");
  });

  test("uses configured catalog (AWS)", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    await runAgent(
      { dealId: 1, message: { type: "text", text: "x" } },
      { config: baseConfigAws, mcp: client }
    );

    expect(calls[0]!.catalog).toBe("AWS");
  });

  test("empty text → INTERNAL with validation message", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    const result = await runAgent(
      { dealId: 42, message: { type: "text", text: "   " } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.INTERNAL);
      expect(result.message).toMatch(/empty/i);
    }
    expect(calls.length).toBe(0);
  });

  test("requires_approval response surfaces approval block", async () => {
    const { client } = makeMcpMock({
      ok: true,
      status: "requires_approval",
      sessionId: "session-abc",
      blocks: [
        { type: "text", text: "Confirm?" },
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "update_opportunity_enhanced",
          parameters: { opportunityId: "O123" },
        },
      ],
    });

    const result = await runAgent(
      { dealId: 1, message: { type: "text", text: "do it" } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("requires_approval");
      expect(result.blocks).toHaveLength(2);
    }
  });
});

// ---- approval response -----------------------------------------------------

describe("runAgent — approval response", () => {
  test("approve forwards tool_approval_response without deal-context preamble", async () => {
    const { client, calls } = makeMcpMock(okComplete);
    const fetchContextImpl = vi.fn();

    await runAgent(
      {
        dealId: 42,
        sessionId: "session-abc",
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "approve",
        },
      },
      {
        config: { ...baseConfigSandbox, hubspotPrivateAppToken: "pat-xyz" },
        mcp: client,
        fetchContextImpl,
      }
    );

    // Crucial: no HubSpot fetch on approval responses, no preamble.
    expect(fetchContextImpl).not.toHaveBeenCalled();
    expect(calls[0]!.content).toEqual([
      { type: "tool_approval_response", toolUseId: "u1", decision: "approve" },
    ]);
    expect(calls[0]!.sessionId).toBe("session-abc");
  });

  test("reject with optional message forwards the message", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    await runAgent(
      {
        dealId: 42,
        sessionId: "session-abc",
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "reject",
          message: "Wrong amount",
        },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(calls[0]!.content).toEqual([
      {
        type: "tool_approval_response",
        toolUseId: "u1",
        decision: "reject",
        message: "Wrong amount",
      },
    ]);
  });

  test("reject without message is allowed", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    await runAgent(
      {
        dealId: 42,
        sessionId: "session-abc",
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "reject",
        },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(calls[0]!.content).toEqual([
      { type: "tool_approval_response", toolUseId: "u1", decision: "reject" },
    ]);
  });

  test("override without message → INTERNAL", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    const result = await runAgent(
      {
        dealId: 42,
        sessionId: "session-abc",
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "override",
        },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.INTERNAL);
      expect(result.message).toMatch(/explanatory message/i);
    }
    expect(calls.length).toBe(0);
  });

  test("override with empty whitespace message → INTERNAL", async () => {
    const { client } = makeMcpMock(okComplete);

    const result = await runAgent(
      {
        dealId: 42,
        sessionId: "session-abc",
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "override",
          message: "   ",
        },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
  });

  test("override with message forwards correctly", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    await runAgent(
      {
        dealId: 42,
        sessionId: "session-abc",
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "override",
          message: "Use revenue 250000 instead",
        },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(calls[0]!.content).toEqual([
      {
        type: "tool_approval_response",
        toolUseId: "u1",
        decision: "override",
        message: "Use revenue 250000 instead",
      },
    ]);
  });

  test("approval without sessionId → INTERNAL", async () => {
    const { client, calls } = makeMcpMock(okComplete);

    const result = await runAgent(
      {
        dealId: 42,
        message: {
          type: "tool_approval_response",
          toolUseId: "u1",
          decision: "approve",
        },
      },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.INTERNAL);
      expect(result.message).toMatch(/sessionId/);
    }
    expect(calls.length).toBe(0);
  });
});

// ---- error mapping ---------------------------------------------------------

describe("runAgent — error mapping", () => {
  test("MCP_RATE_LIMITED surfaces user-friendly message", async () => {
    const { client } = makeMcpMock({
      ok: false,
      code: ErrorCode.MCP_RATE_LIMITED,
      rpcCode: -32004,
      rpcMessage: "Rate limit exceeded",
    });

    const result = await runAgent(
      { dealId: 1, message: { type: "text", text: "hi" } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_RATE_LIMITED);
      expect(result.message).toMatch(/rate-limited/i);
      expect(result.details?.rpcCode).toBe(-32004);
      expect(result.details?.rpcMessage).toBe("Rate limit exceeded");
    }
  });

  test("MCP_PERMISSION_DENIED surfaces admin-contact message", async () => {
    const { client } = makeMcpMock({
      ok: false,
      code: ErrorCode.MCP_PERMISSION_DENIED,
      rpcCode: -31004,
      rpcMessage: "missing UpdateOpportunity",
    });

    const result = await runAgent(
      { dealId: 1, message: { type: "text", text: "x" } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/role.*doesn't allow/i);
    }
  });

  test("MCP_AUTH_FAILURE surfaces admin-contact message", async () => {
    const { client } = makeMcpMock({
      ok: false,
      code: ErrorCode.MCP_AUTH_FAILURE,
      rpcCode: -32001,
      rpcMessage: "expired",
    });

    const result = await runAgent(
      { dealId: 1, message: { type: "text", text: "x" } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/authenticate.*Partner Central/i);
    }
  });

  test("MCP_INTERNAL with no rpcCode still surfaces a message", async () => {
    const { client } = makeMcpMock({
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "broken",
    });

    const result = await runAgent(
      { dealId: 1, message: { type: "text", text: "x" } },
      { config: baseConfigSandbox, mcp: client }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.MCP_INTERNAL);
      expect(result.details?.rpcCode).toBeUndefined();
    }
  });
});
