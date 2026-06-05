/**
 * Shared helpers for the Share / Refresh Lambda handlers.
 *
 * Each handler is a thin wrapper around a pure `run*` orchestration function:
 * it parses the API Gateway event, loads config from Secrets Manager,
 * constructs real SDK clients, delegates to `runShare` / `runRefresh`, and
 * serialises the typed `FunctionResponse` envelope into an
 * `APIGatewayProxyResultV2`. This module factors out the parts that are
 * identical between the two handlers.
 *
 * ## HTTP status code mapping
 *
 * The wire protocol always carries a JSON body matching `FunctionResponse`
 * (a discriminated union on `ok: true | false`). The HTTP status code is a
 * hint for operators and non-JSON HTTP tooling; the card itself narrows on
 * `ok`, not on the status. See design.md §toProxyResult for the mapping
 * table.
 *
 * ## Structured logging
 *
 * `logRequest` emits a single `<fn>.begin` JSON line per invocation. All
 * other lifecycle events (create.success, update.fail, etc.) are emitted by
 * the core orchestrations themselves in future iterations; this module
 * scopes itself to the wrapper layer only.
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
  APIGatewayEventRequestContextV2,
} from "aws-lambda";

import { ErrorCode, type FunctionResponse } from "../lib/errors";

/**
 * Map from our internal `ErrorCode` enum to the HTTP status code the
 * Lambda returns to API Gateway. See design.md §toProxyResult for
 * rationale on each value. Unknown codes default to 500.
 */
const STATUS_BY_CODE: Record<string, number> = {
  MISSING_SECRET: 500,
  PRECONDITION: 422,
  STAGE_UNMAPPABLE: 500,
  ACE_THROTTLED: 503,
  ACE_CREATE: 502,
  ACE_UPDATE: 502,
  ACE_GET: 502,
  ACE_GET_SUMMARY: 502,
  HUBSPOT_WRITE: 502,
  STALE_OPPORTUNITY: 409,
  AUTH_INVALID: 401,
  INTERNAL: 500,
};

/**
 * Return the HTTP status code for the given `ErrorCode`. For `INTERNAL`
 * errors where the root cause is a caller-provided bad payload (e.g.
 * missing `dealId`), the wrapper chooses 400 explicitly rather than
 * relying on this map — so `INTERNAL` here resolves to 500 for actual
 * server bugs.
 */
export function statusCodeFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * Serialise a `FunctionResponse` into an API Gateway v2 proxy result with
 * the correct HTTP status. Callers pass an explicit `statusCode` when they
 * need to override the map (e.g. 200 on success, 400 for a malformed
 * request body).
 */
export function toProxyResult(
  response: FunctionResponse,
  statusCode: number
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  };
}

/**
 * Parse `event.body` as JSON and return a positive integer `dealId` if
 * present. Returns `undefined` when the body is missing, not parseable as
 * JSON, or the `dealId` field is absent / not a finite number. Handlers
 * surface an `INTERNAL`/400 response on `undefined`.
 *
 * API Gateway HTTP API v2 may base64-encode the body when `isBase64Encoded`
 * is true; decode that path too.
 */
export function parseDealId(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): number | undefined {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === "") return undefined;

  let text: string;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  } else {
    text = raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;
  const dealId = (parsed as { dealId?: unknown }).dealId;
  if (typeof dealId !== "number" || !Number.isFinite(dealId)) return undefined;
  return dealId;
}

/**
 * Emit a single JSON line describing the start of an invocation. Format
 * matches the structured-logging contract in design.md §Structured
 * logging: `time`, `level`, `fn`, `reqId`, `event = <fn>.begin`. Secrets
 * never appear — only the request id and a fixed event label.
 */
export function logRequest(
  fn: "share" | "submit" | "refresh" | "auth",
  reqId: string,
  _event: APIGatewayProxyEventV2WithRequestContext<unknown>
): void {
  const line = {
    time: new Date().toISOString(),
    level: "info",
    fn,
    reqId,
    event: `${fn}.begin`,
    msg: `${fn} invocation started`,
  };
  console.log(JSON.stringify(line));
}

/**
 * Shorthand accessor for the API Gateway v2 request context — used to pull
 * the `requestId` out without every caller retyping the long generic.
 */
export function requestIdOf(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): string {
  const ctx = event.requestContext as APIGatewayEventRequestContextV2;
  return ctx?.requestId ?? "unknown";
}
