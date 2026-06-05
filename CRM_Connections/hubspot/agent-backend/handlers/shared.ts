/**
 * Shared helpers for the Agent Lambda handler.
 *
 * Mirrors the concept of `../../backend/handlers/shared.ts` for the
 * Share/Refresh stack: factor out HTTP-status mapping and structured
 * logging so the handler proper stays a thin wrapper around the
 * orchestration.
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
  APIGatewayEventRequestContextV2,
} from "aws-lambda";

import { ErrorCode, type AgentResponse } from "../lib/errors";

const STATUS_BY_CODE: Record<string, number> = {
  MISSING_SECRET: 500,
  AUTH_INVALID: 401,
  INTERNAL: 400, // INTERNAL is reserved for caller-side bad payload from the agent handler
  MCP_AUTH_FAILURE: 502,
  MCP_PERMISSION_DENIED: 502,
  MCP_ACCESS_DENIED: 502,
  MCP_RATE_LIMITED: 503,
  MCP_NOT_FOUND: 404,
  MCP_BAD_REQUEST: 502,
  MCP_INTERNAL: 502,
};

export function statusCodeFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export function toProxyResult(
  response: AgentResponse,
  statusCode: number
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  };
}

export function requestIdOf(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): string {
  const ctx = event.requestContext as APIGatewayEventRequestContextV2;
  return ctx?.requestId ?? "unknown";
}

export function logBegin(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>,
  reqId: string
): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "agent",
      reqId,
      event: "agent.begin",
      msg: "agent invocation started",
    })
  );
}
