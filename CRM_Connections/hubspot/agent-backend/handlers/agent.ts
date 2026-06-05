/**
 * Agent Lambda handler (AWS API Gateway HTTP API v2).
 *
 * Thin wrapper around `runAgent(input, deps)`. Responsibilities:
 *   1. Emit an `agent.begin` log line.
 *   2. Verify HubSpot v3 HMAC on the request.
 *   3. Parse + validate the request body.
 *   4. Load the agent config from Secrets Manager.
 *   5. Construct the MCP client.
 *   6. Delegate to `runAgent`.
 *   7. Serialise `AgentResponse` into an `APIGatewayProxyResultV2`.
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { runAgent, type AgentInboundMessage } from "../core/run-agent";
import { loadAgentConfigFromSecretsManager } from "../lib/config";
import { createMcpClient } from "../lib/mcp-client";
import { ErrorCode, makeError } from "../lib/errors";
import { verifyHubspotSignature } from "../lib/hubspot-signature";
import {
  toProxyResult,
  statusCodeFor,
  requestIdOf,
  logBegin,
} from "./shared";

type RawBody = {
  dealId?: unknown;
  sessionId?: unknown;
  message?: unknown;
};

type ParsedBody = {
  dealId: number;
  sessionId?: string;
  message: AgentInboundMessage;
};

export const handler = async (
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): Promise<APIGatewayProxyResultV2> => {
  const reqId = requestIdOf(event);
  logBegin(event, reqId);

  // 1. Load config first so signature verification has the client secret.
  const cfg = await loadAgentConfigFromSecretsManager();
  if (!cfg.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.MISSING_SECRET,
        undefined,
        `Configuration error: missing secrets: ${cfg.missing.join(", ")}. Contact your admin.`,
        { missingSecrets: cfg.missing }
      ),
      500
    );
  }

  // 2. Verify HubSpot v3 HMAC.
  const sigResult = verifyHubspotSignature(
    event as unknown as Parameters<typeof verifyHubspotSignature>[0],
    cfg.config.hubspotClientSecret
  );
  if (!sigResult.ok) {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        fn: "agent",
        reqId,
        event: "auth.deny",
        details: { reason: sigResult.reason },
      })
    );
    return toProxyResult(
      makeError(
        ErrorCode.AUTH_INVALID,
        undefined,
        "Authorization failed. Reload the HubSpot page and try again."
      ),
      401
    );
  }

  // 3. Parse + validate the body.
  const parsed = parseBody(event);
  if (parsed === undefined) {
    return toProxyResult(
      makeError(
        ErrorCode.INTERNAL,
        undefined,
        "Malformed request body. Expected { dealId, message, sessionId? }."
      ),
      400
    );
  }

  // 4. Run.
  const mcp = createMcpClient();
  const response = await runAgent(parsed, { config: cfg.config, mcp });

  const status = response.ok ? 200 : statusCodeFor(response.code);
  return toProxyResult(response, status);
};

// ---------------------------------------------------------------------------
// Body parsing — exported for direct testing.
// ---------------------------------------------------------------------------

export function parseBody(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): ParsedBody | undefined {
  const rawText = readBodyText(event);
  if (rawText === undefined) return undefined;

  let raw: RawBody;
  try {
    raw = JSON.parse(rawText) as RawBody;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;

  if (typeof raw.dealId !== "number" || !Number.isFinite(raw.dealId)) {
    return undefined;
  }

  const sessionId =
    typeof raw.sessionId === "string" && raw.sessionId.length > 0
      ? raw.sessionId
      : undefined;

  const message = parseInboundMessage(raw.message);
  if (message === undefined) return undefined;

  return {
    dealId: raw.dealId,
    ...(sessionId ? { sessionId } : {}),
    message,
  };
}

function readBodyText(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): string | undefined {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return raw;
}

function parseInboundMessage(value: unknown): AgentInboundMessage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const m = value as Record<string, unknown>;

  if (m.type === "text") {
    if (typeof m.text !== "string") return undefined;
    return { type: "text", text: m.text };
  }

  if (m.type === "tool_approval_response") {
    if (typeof m.toolUseId !== "string" || m.toolUseId === "") return undefined;
    const decision = m.decision;
    if (
      decision !== "approve" &&
      decision !== "reject" &&
      decision !== "override"
    ) {
      return undefined;
    }
    const optMessage =
      typeof m.message === "string" && m.message.length > 0 ? m.message : undefined;
    return {
      type: "tool_approval_response",
      toolUseId: m.toolUseId,
      decision,
      ...(optMessage ? { message: optMessage } : {}),
    };
  }

  return undefined;
}
