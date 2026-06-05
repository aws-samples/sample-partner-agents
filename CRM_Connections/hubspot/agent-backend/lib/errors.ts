/**
 * Response envelope and error model for the Partner Central Agent
 * Lambda. Mirrors the shape of `../../backend/lib/errors.ts` so the
 * card UI can narrow on `ok: true | false` identically across the
 * Share/Refresh path and the Agent path — but with an Agent-specific
 * error-code set.
 *
 * Notes:
 *   - `ErrorCode` is `as const` + a type alias rather than a `const enum`
 *     because `tsconfig.isolatedModules: true` forbids `const enum`
 *     re-exports.
 *   - `MCP_*` codes map 1:1 to the JSON-RPC error codes returned by the
 *     Partner Central Agent MCP Server. Translation from RPC code to
 *     ErrorCode lives in `lib/mcp-client.ts`.
 *   - `requires_approval` is NOT an error — it's a legitimate success
 *     status carrying a tool_approval_request block. See `AgentResponse`
 *     below.
 */

export const ErrorCode = {
  /** Secrets Manager blob is missing one or more required keys. */
  MISSING_SECRET: "MISSING_SECRET",
  /** Inbound HubSpot signature didn't verify. */
  AUTH_INVALID: "AUTH_INVALID",
  /** Caller-side bad request (missing dealId, malformed body, etc.). */
  INTERNAL: "INTERNAL",

  /** MCP returned -32001 — SigV4 signature invalid or credentials expired. */
  MCP_AUTH_FAILURE: "MCP_AUTH_FAILURE",
  /** MCP returned -31004 — IAM identity lacks the required partnercentral: action. */
  MCP_PERMISSION_DENIED: "MCP_PERMISSION_DENIED",
  /** MCP returned -32002 — general access denied (account not enrolled, region mismatch). */
  MCP_ACCESS_DENIED: "MCP_ACCESS_DENIED",
  /** MCP returned -32004 — rate limit exceeded; client should back off. */
  MCP_RATE_LIMITED: "MCP_RATE_LIMITED",
  /** MCP returned -30001 — session, opportunity, etc. not found. */
  MCP_NOT_FOUND: "MCP_NOT_FOUND",
  /** MCP returned -32600 — malformed JSON-RPC request. */
  MCP_BAD_REQUEST: "MCP_BAD_REQUEST",
  /** MCP returned -32603 or any other unexpected internal failure. */
  MCP_INTERNAL: "MCP_INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Content blocks the card renders. The agent normalises MCP's content
 * array into this two-block-type format:
 *   - `text`: a chat-style assistant message
 *   - `approval_request`: a write-action proposal awaiting Approve / Reject / Override
 */
export type AgentBlock =
  | { type: "text"; text: string }
  | {
      type: "approval_request";
      toolUseId: string;
      toolName: string;
      parameters: Record<string, unknown>;
    };

export type AgentSuccess = {
  ok: true;
  /** "complete" if the agent finished; "requires_approval" if a write needs human consent. */
  status: "complete" | "requires_approval";
  /** Echo this on the next sendMessage to keep the conversation in the same session. */
  sessionId: string;
  /** Normalised content blocks the card renders top-down. */
  blocks: AgentBlock[];
};

export type ErrorDetails = {
  step?: string;
  missingSecrets?: string[];
  /** Raw JSON-RPC error code, when the failure originated at the MCP server. */
  rpcCode?: number;
  /** Free-form note from the MCP error message (truncated to 500 chars). */
  rpcMessage?: string;
};

export type ErrorResponse = {
  ok: false;
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
};

/**
 * Discriminated union the card consumes. Narrow on `ok`.
 */
export type AgentResponse = AgentSuccess | ErrorResponse;

/**
 * Build a fully-typed ErrorResponse. `details` is omitted when no fields
 * are provided, keeping the wire payload minimal.
 */
export function makeError(
  code: ErrorCode,
  step: string | undefined,
  message: string,
  extraDetails?: Omit<ErrorDetails, "step">
): ErrorResponse {
  const details: ErrorDetails = { ...(extraDetails ?? {}) };
  if (step !== undefined) details.step = step;
  const hasDetails = Object.keys(details).length > 0;
  return {
    ok: false,
    code,
    message,
    ...(hasDetails ? { details } : {}),
  };
}
