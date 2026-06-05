/**
 * Orchestration for the Agent Lambda. Pure(ish) — the only side effects
 * are the MCP call and the optional HubSpot deal-context fetch, both
 * injected as dependencies for testability.
 *
 * Two request shapes flow through here:
 *
 *   1. **User text message.** The card sends `{ dealId, message: { type:
 *      "text", text } }`. We optionally prepend a deal-context preamble
 *      (when a HubSpot token is configured), forward to MCP, normalise
 *      the response.
 *
 *   2. **Approval response.** The card sends `{ dealId, sessionId,
 *      message: { type: "tool_approval_response", toolUseId, decision,
 *      message? } }`. We forward to MCP **without** the deal-context
 *      preamble — the agent already has the context from the prior turn.
 *
 * Returns the canonical `AgentResponse` envelope the card narrows on.
 */

import type { AgentConfig } from "../lib/config";
import { ErrorCode, makeError, type AgentResponse } from "../lib/errors";
import type {
  Catalog,
  McpClient,
  McpContentBlock,
} from "../lib/mcp-client";
import {
  fetchDealContext,
  renderDealContextPreamble,
  type DealContextDeps,
} from "../lib/hubspot-deal-context";

/** Inbound message shape coming from the card's POST body. */
export type AgentInboundMessage =
  | { type: "text"; text: string }
  | {
      type: "tool_approval_response";
      toolUseId: string;
      decision: "approve" | "reject" | "override";
      message?: string;
    };

export type RunAgentInput = {
  dealId: number;
  /** Echo of the previous turn's session id — omit on the first message. */
  sessionId?: string;
  message: AgentInboundMessage;
};

export type RunAgentDeps = {
  config: AgentConfig;
  mcp: McpClient;
  /**
   * Optional override for the HubSpot deal-context fetcher (mostly for
   * tests). Production uses the real `fetchDealContext` against
   * `api.hubapi.com`.
   */
  fetchContextImpl?: typeof fetchDealContext;
};

/**
 * Validate the inbound message and forward to MCP. Logs lifecycle
 * events to stdout (`agent.text.begin` / `agent.approval.begin` /
 * `agent.complete` / `agent.requires_approval` / `agent.error`).
 */
export async function runAgent(
  input: RunAgentInput,
  deps: RunAgentDeps
): Promise<AgentResponse> {
  const { dealId, sessionId, message } = input;
  const catalog: Catalog = deps.config.aceAgentCatalog;

  if (message.type === "text") {
    return await runTextMessage(
      { dealId, sessionId, text: message.text },
      catalog,
      deps
    );
  }

  return await runApprovalResponse(
    { dealId, sessionId, response: message },
    catalog,
    deps
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runTextMessage(
  args: { dealId: number; sessionId?: string; text: string },
  catalog: Catalog,
  deps: RunAgentDeps
): Promise<AgentResponse> {
  log("agent.text.begin", {
    dealId: args.dealId,
    sessionId: args.sessionId ?? null,
    catalog,
  });

  if (args.text.trim() === "") {
    return makeError(
      ErrorCode.INTERNAL,
      "validate",
      "Message text cannot be empty."
    );
  }

  // Compose content. When a HubSpot token is configured, prepend a
  // single text block with the deal-context preamble. This runs on
  // every user text message — sessions are short and the preamble is
  // idempotent against itself.
  const blocks: McpContentBlock[] = [];

  if (deps.config.hubspotPrivateAppToken) {
    const fetchCtx = deps.fetchContextImpl ?? fetchDealContext;
    const ctxDeps: DealContextDeps = {
      privateAppToken: deps.config.hubspotPrivateAppToken,
    };
    const ctx = await fetchCtx(args.dealId, ctxDeps);
    const preamble = renderDealContextPreamble(ctx);
    if (preamble !== "") {
      blocks.push({ type: "text", text: preamble });
    }
  }

  blocks.push({ type: "text", text: args.text });

  const result = await deps.mcp.sendMessage({
    catalog,
    content: blocks,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  });

  return mapMcpResultToAgentResponse(result, "agent.text");
}

async function runApprovalResponse(
  args: {
    dealId: number;
    sessionId?: string;
    response: Extract<AgentInboundMessage, { type: "tool_approval_response" }>;
  },
  catalog: Catalog,
  deps: RunAgentDeps
): Promise<AgentResponse> {
  log("agent.approval.begin", {
    dealId: args.dealId,
    sessionId: args.sessionId ?? null,
    decision: args.response.decision,
    toolUseId: args.response.toolUseId,
    catalog,
  });

  if (!args.sessionId) {
    return makeError(
      ErrorCode.INTERNAL,
      "validate",
      "Approval responses require a sessionId from the prior turn."
    );
  }

  if (
    args.response.decision === "override" &&
    (args.response.message === undefined ||
      args.response.message.trim() === "")
  ) {
    return makeError(
      ErrorCode.INTERNAL,
      "validate",
      "Override decisions require an explanatory message."
    );
  }

  const block: McpContentBlock = {
    type: "tool_approval_response",
    toolUseId: args.response.toolUseId,
    decision: args.response.decision,
    ...(args.response.message ? { message: args.response.message } : {}),
  };

  const result = await deps.mcp.sendMessage({
    catalog,
    sessionId: args.sessionId,
    content: [block],
  });

  return mapMcpResultToAgentResponse(result, "agent.approval");
}

function mapMcpResultToAgentResponse(
  result: Awaited<ReturnType<McpClient["sendMessage"]>>,
  fnLabel: string
): AgentResponse {
  if (result.ok) {
    log(`${fnLabel}.${result.status === "complete" ? "complete" : "requires_approval"}`, {
      sessionId: result.sessionId,
      blockCount: result.blocks.length,
    });
    return {
      ok: true,
      status: result.status,
      sessionId: result.sessionId,
      blocks: result.blocks,
    };
  }

  log(`${fnLabel}.error`, {
    code: result.code,
    rpcCode: result.rpcCode,
    rpcMessage: result.rpcMessage,
  });
  return makeError(
    result.code,
    "mcp",
    userMessageForCode(result.code),
    {
      ...(typeof result.rpcCode === "number" ? { rpcCode: result.rpcCode } : {}),
      ...(result.rpcMessage ? { rpcMessage: result.rpcMessage } : {}),
    }
  );
}

/**
 * Convert an internal `ErrorCode` into a card-facing message. Keep
 * these short — the card surfaces them as a banner.
 */
function userMessageForCode(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.MCP_AUTH_FAILURE:
      return "Could not authenticate with AWS Partner Central. Contact your admin.";
    case ErrorCode.MCP_PERMISSION_DENIED:
      return "Your AWS Partner Central role doesn't allow this action. Contact your admin.";
    case ErrorCode.MCP_ACCESS_DENIED:
      return "AWS Partner Central denied this request.";
    case ErrorCode.MCP_RATE_LIMITED:
      return "AWS rate-limited the request. Wait a moment and try again.";
    case ErrorCode.MCP_NOT_FOUND:
      return "Session expired or resource not found. Click \"New conversation\" and try again.";
    case ErrorCode.MCP_BAD_REQUEST:
      return "AWS rejected the request as malformed.";
    case ErrorCode.MCP_INTERNAL:
      return "AWS Partner Central encountered an internal error. Try again.";
    case ErrorCode.MISSING_SECRET:
      return "Configuration error: a required secret is missing.";
    case ErrorCode.AUTH_INVALID:
      return "Authorization failed. Reload the HubSpot page and try again.";
    case ErrorCode.INTERNAL:
    default:
      return "Unexpected error. Please try again.";
  }
}

function log(event: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "agent",
      event,
      ...details,
    })
  );
}
