/**
 * MCP client for the AWS Partner Central Agent MCP Server.
 *
 * Wire format (per
 * https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html):
 *   - Endpoint:    https://partnercentral-agents-mcp.us-east-1.api.aws/mcp
 *   - Protocol:    JSON-RPC 2.0 over HTTPS POST
 *   - Auth:        AWS Signature Version 4
 *     - Service:   partnercentral-agents-mcp
 *     - Region:    us-east-1
 *   - TLS:         1.2 or higher
 *
 * This module is the only place SigV4 signing happens. Callers
 * (`core/run-agent.ts`, `handlers/agent.ts`) treat the client as an
 * opaque object with `sendMessage` / `getSession` methods returning
 * normalised `MCPCallResult` envelopes.
 *
 * Streaming (SSE) is intentionally NOT supported in v1 because
 * `hubspot.fetch` is a JSON request/response wrapper that can't surface
 * SSE events to the React card. Every call uses `stream: false`.
 *
 * Tested via `__tests__/mcp-client.test.ts` against a mocked
 * `fetch`-shaped transport so signing determinism, JSON-RPC
 * envelope shape, and error-code mapping are covered without
 * round-tripping to AWS.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

import { ErrorCode, type AgentBlock } from "./errors";

/** Production endpoint for the Partner Central Agent MCP Server. */
export const MCP_ENDPOINT_HOST =
  "partnercentral-agents-mcp.us-east-1.api.aws" as const;
export const MCP_ENDPOINT_PATH = "/mcp" as const;
/** The SigV4 service name AWS uses for this endpoint. Distinct from `partnercentral-selling`. */
export const MCP_SERVICE_NAME = "partnercentral-agents-mcp" as const;
export const MCP_REGION = "us-east-1" as const;

/** Two catalogs supported by the MCP server. */
export type Catalog = "AWS" | "Sandbox";

/**
 * MCP content block as defined by the protocol. We accept exactly four
 * block types from callers; the server returns a fifth (`tool_approval_request`)
 * which we surface to the card via `AgentBlock`.
 */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; filename: string; s3Uri: string }
  | {
      type: "tool_approval_response";
      toolUseId: string;
      decision: "approve" | "reject" | "override";
      message?: string;
    };

/**
 * Caller's view of an MCP call result. Translates the JSON-RPC envelope
 * into a discriminated union that maps cleanly onto `AgentResponse` in
 * the orchestration layer.
 */
export type MCPCallResult =
  | {
      ok: true;
      status: "complete" | "requires_approval";
      sessionId: string;
      blocks: AgentBlock[];
    }
  | {
      ok: false;
      /** The internal ErrorCode the orchestration should surface to the card. */
      code: ErrorCode;
      /** Raw JSON-RPC error code from the server, when one was returned. */
      rpcCode?: number;
      /** Truncated error message from the server, for diagnostics. */
      rpcMessage?: string;
    };

/**
 * Optional MCP integrator-attribution metadata. AWS uses this to identify
 * the source of MCP traffic. Defaults below provide a reasonable value
 * for partners forking this connector.
 */
export type ClientInfo = {
  /** Company name, or `"Direct"` for partners who haven't picked a label. */
  integrator?: string;
  /** Product / agent name, e.g. `"AWS CRM Connector"`. */
  sourceProduct?: string;
};

/**
 * Pluggable HTTP transport so tests can mock the network. Production
 * uses the global `fetch`. The contract matches the WHATWG
 * `Response`-style return.
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

export type McpClientOptions = {
  /** Override transport (mostly for tests). */
  fetchImpl?: FetchLike;
  /** Override the credential provider (mostly for tests). */
  credentialsProvider?: () => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiration?: Date;
  }>;
  /** Override `Date.now()` for deterministic SigV4 timestamps in tests. */
  nowMs?: () => number;
  clientInfo?: ClientInfo;
};

const DEFAULT_CLIENT_INFO: ClientInfo = {
  integrator: "Direct",
  sourceProduct: "HubSpot ACE Agent Card",
};

/**
 * Internal monotonic counter for JSON-RPC `id`. Fresh per Lambda
 * container — collisions across containers are fine because IDs only
 * matter within a single request/response pair.
 */
let nextRpcId = 1;

export type McpClient = {
  sendMessage(args: {
    catalog: Catalog;
    content: McpContentBlock[];
    sessionId?: string;
  }): Promise<MCPCallResult>;
  getSession(args: {
    catalog: Catalog;
    sessionId: string;
  }): Promise<MCPCallResult>;
};

export function createMcpClient(opts: McpClientOptions = {}): McpClient {
  const fetchImpl: FetchLike =
    opts.fetchImpl ??
    (async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, statusText: r.statusText, text: () => r.text() };
    });
  const credsProvider =
    opts.credentialsProvider ??
    (async () => {
      const c = await defaultProvider()();
      return c;
    });
  const now = opts.nowMs ?? (() => Date.now());
  const clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;

  /** Sign and POST a single JSON-RPC envelope to the MCP endpoint. */
  async function rpcCall(
    method: "tools/call",
    params: Record<string, unknown>
  ): Promise<MCPCallResult> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method,
      params,
    });

    const creds = await credsProvider();
    const signer = new SignatureV4({
      credentials: creds,
      region: MCP_REGION,
      service: MCP_SERVICE_NAME,
      sha256: Sha256,
    });

    // Date.now() is the only non-determinism the signer pulls in, so
    // exposing `nowMs` lets tests pin the timestamp. SigV4 reads
    // `signingDate` if provided.
    const signingDate = new Date(now());
    const unsignedRequest = new HttpRequest({
      method: "POST",
      protocol: "https:",
      hostname: MCP_ENDPOINT_HOST,
      path: MCP_ENDPOINT_PATH,
      headers: {
        host: MCP_ENDPOINT_HOST,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    });
    const signed = await signer.sign(unsignedRequest, { signingDate });

    let resp;
    try {
      resp = await fetchImpl(
        `https://${MCP_ENDPOINT_HOST}${MCP_ENDPOINT_PATH}`,
        {
          method: "POST",
          headers: signed.headers,
          body,
        }
      );
    } catch (err) {
      return {
        ok: false,
        code: ErrorCode.MCP_INTERNAL,
        rpcMessage: `Network error: ${(err as Error).message}`,
      };
    }

    let raw: string;
    try {
      raw = await resp.text();
    } catch (err) {
      return {
        ok: false,
        code: ErrorCode.MCP_INTERNAL,
        rpcMessage: `Failed to read MCP response: ${(err as Error).message}`,
      };
    }

    if (resp.status >= 500) {
      return {
        ok: false,
        code: ErrorCode.MCP_INTERNAL,
        rpcMessage: `MCP server returned ${resp.status} ${resp.statusText}: ${truncate(raw)}`,
      };
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        code: ErrorCode.MCP_INTERNAL,
        rpcMessage: `Non-JSON response from MCP: ${truncate(raw)}`,
      };
    }

    return interpretEnvelope(envelope);
  }

  return {
    async sendMessage(args) {
      const params: Record<string, unknown> = {
        name: "sendMessage",
        arguments: {
          content: args.content,
          catalog: args.catalog,
          stream: false,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        },
        _meta: {
          integrator: clientInfo.integrator ?? "Direct",
          sourceProduct: clientInfo.sourceProduct ?? "HubSpot ACE Agent Card",
        },
      };
      return rpcCall("tools/call", params);
    },

    async getSession(args) {
      const params: Record<string, unknown> = {
        name: "getSession",
        arguments: {
          sessionId: args.sessionId,
          catalog: args.catalog,
        },
        _meta: {
          integrator: clientInfo.integrator ?? "Direct",
          sourceProduct: clientInfo.sourceProduct ?? "HubSpot ACE Agent Card",
        },
      };
      return rpcCall("tools/call", params);
    },
  };
}

// ---------------------------------------------------------------------------
// Envelope interpretation. Pure function — exported for direct testing.
// ---------------------------------------------------------------------------

/**
 * Translate a raw JSON-RPC 2.0 envelope into the caller-facing
 * `MCPCallResult`.
 *
 * The actual wire format from the Partner Central Agent MCP Server is
 * doubly-nested — different from what the public docs describe. The
 * outer JSON-RPC envelope wraps a single MCP `text` content block whose
 * `text` field is itself a JSON-encoded "inner envelope" carrying the
 * agent's actual response:
 *
 *   {
 *     "jsonrpc": "2.0", "id": N,
 *     "result": {
 *       "content": [{"type": "text", "text": "<inner JSON>"}],
 *       "isError": false
 *     }
 *   }
 *
 * Inner JSON shape:
 *
 *   {
 *     "content": [
 *       {"type": "ASSISTANT_RESPONSE", "content": {"text": "..."}, "timestamp": "..."},
 *       {"type": "serverToolUse",      "content": {...},          "timestamp": "..."},
 *       {"type": "serverToolResult",   "content": {...},          "timestamp": "..."},
 *       ... possibly more ...
 *     ],
 *     "sessionId": "session-...",
 *     "status":    "complete" | "requires_approval" | "error",
 *     "role":      "assistant",
 *     "timestamp": "..."
 *   }
 *
 * We parse both layers and emit `AgentBlock`s the card can render
 * directly. `serverToolUse` and `serverToolResult` blocks are internal
 * tool-call traces — we drop them, since the trailing
 * `ASSISTANT_RESPONSE` always summarises what happened. Multiple
 * `ASSISTANT_RESPONSE` blocks are concatenated as separate text blocks
 * preserving paragraph breaks.
 *
 * If the outer envelope carries `error` instead of `result`, we map
 * the JSON-RPC error code to an `ErrorCode`.
 */
export function interpretEnvelope(envelope: unknown): MCPCallResult {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope)
  ) {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "Malformed JSON-RPC envelope",
    };
  }
  const env = envelope as Record<string, unknown>;

  if ("error" in env && env.error !== undefined) {
    const err = env.error as { code?: number; message?: string };
    return mapJsonRpcError(err.code, err.message);
  }

  const result = env.result;
  if (result === undefined || result === null || typeof result !== "object") {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "MCP response missing both `result` and `error` fields",
    };
  }
  const r = result as Record<string, unknown>;

  // Unwrap the doubly-nested structure: result.content[0].text holds a
  // JSON-encoded inner envelope.
  const outerContent = Array.isArray(r.content) ? r.content : [];
  const firstBlock = outerContent[0];
  if (
    firstBlock === undefined ||
    firstBlock === null ||
    typeof firstBlock !== "object"
  ) {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "MCP response result.content is empty",
    };
  }
  const fb = firstBlock as Record<string, unknown>;
  if (fb.type !== "text" || typeof fb.text !== "string") {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "MCP response result.content[0] is not a text block",
    };
  }

  let inner: unknown;
  try {
    inner = JSON.parse(fb.text);
  } catch {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: `Inner envelope is not valid JSON: ${truncate(fb.text)}`,
    };
  }

  if (inner === null || typeof inner !== "object") {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "Inner envelope is not an object",
    };
  }
  const innerObj = inner as Record<string, unknown>;

  const status = innerObj.status;
  if (
    status !== "complete" &&
    status !== "requires_approval" &&
    status !== "error"
  ) {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: `Inner envelope status: ${String(status)}`,
    };
  }

  if (status === "error") {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "Agent returned status=error",
    };
  }

  const sessionId =
    typeof innerObj.sessionId === "string" ? innerObj.sessionId : "";
  if (sessionId === "") {
    return {
      ok: false,
      code: ErrorCode.MCP_INTERNAL,
      rpcMessage: "Inner envelope missing sessionId",
    };
  }

  const innerContent = Array.isArray(innerObj.content) ? innerObj.content : [];
  const blocks = normaliseInnerContent(innerContent);

  return {
    ok: true,
    status: status as "complete" | "requires_approval",
    sessionId,
    blocks,
  };
}

/**
 * Map MCP's JSON-RPC error codes to our internal `ErrorCode`. The
 * documented codes are listed in mcp-configuration-reference.html
 * §Error codes.
 */
function mapJsonRpcError(
  code: number | undefined,
  message: string | undefined
): MCPCallResult {
  const rpcMessage = truncate(message ?? "MCP error");
  switch (code) {
    case -32001:
      return {
        ok: false,
        code: ErrorCode.MCP_AUTH_FAILURE,
        rpcCode: code,
        rpcMessage,
      };
    case -31004:
      return {
        ok: false,
        code: ErrorCode.MCP_PERMISSION_DENIED,
        rpcCode: code,
        rpcMessage,
      };
    case -32002:
      return {
        ok: false,
        code: ErrorCode.MCP_ACCESS_DENIED,
        rpcCode: code,
        rpcMessage,
      };
    case -32004:
      return {
        ok: false,
        code: ErrorCode.MCP_RATE_LIMITED,
        rpcCode: code,
        rpcMessage,
      };
    case -30001:
      return {
        ok: false,
        code: ErrorCode.MCP_NOT_FOUND,
        rpcCode: code,
        rpcMessage,
      };
    case -32602:
      // -32602 is the JSON-RPC standard "Invalid params" code, which
      // the Partner Central MCP server uses for ResourceNotFoundException
      // when the requested session has been ejected from server-held
      // state (e.g. after a tool-call cycle completes). The card uses
      // MCP_NOT_FOUND to trigger a stale-session recovery — drop the
      // local sessionId and prompt the user to start a fresh
      // conversation.
      return {
        ok: false,
        code: ErrorCode.MCP_NOT_FOUND,
        rpcCode: code,
        rpcMessage,
      };
    case -32600:
      return {
        ok: false,
        code: ErrorCode.MCP_BAD_REQUEST,
        rpcCode: code,
        rpcMessage,
      };
    default:
      return {
        ok: false,
        code: ErrorCode.MCP_INTERNAL,
        ...(typeof code === "number" ? { rpcCode: code } : {}),
        rpcMessage,
      };
  }
}

/**
 * Convert MCP's inner content array into the card-facing
 * `AgentBlock[]` shape. Block types we recognise from the live wire
 * format:
 *
 *   - `ASSISTANT_RESPONSE` — agent's natural-language reply. The text
 *     lives at `content.text`. Multiple of these are emitted as
 *     separate text blocks so paragraph breaks are preserved in the
 *     transcript.
 *   - `tool_approval_request` — write proposal awaiting human consent.
 *     **The wire format is doubly-nested**: `content.text` is itself a
 *     JSON-encoded string with the actual fields (`tool_use_id`,
 *     `tool_name`, `input`, `tool_description`). The MCP docs describe
 *     a flatter shape with `toolUseId`/`toolName`/`parameters` as
 *     direct properties — we accept both forms for forward compat.
 *   - `serverToolUse` / `serverToolResult` — internal tool-call traces.
 *     Dropped: the trailing `ASSISTANT_RESPONSE` always summarises what
 *     happened, so surfacing the raw traces would be noisy.
 */
function normaliseInnerContent(raw: unknown[]): AgentBlock[] {
  const out: AgentBlock[] = [];
  for (const block of raw) {
    if (block === null || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;

    if (b.type === "ASSISTANT_RESPONSE") {
      const c = b.content as Record<string, unknown> | undefined;
      const text = c && typeof c.text === "string" ? c.text : "";
      if (text !== "") out.push({ type: "text", text });
      continue;
    }

    // Fallback for the simpler documented shape.
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
      continue;
    }

    if (b.type === "tool_approval_request") {
      // Two possible shapes — try the live one first, fall back to docs shape.
      const c = b.content as Record<string, unknown> | undefined;
      let parsed: {
        toolUseId?: string;
        toolName?: string;
        parameters?: Record<string, unknown>;
      } = {};

      if (c && typeof c.text === "string") {
        // Live wire format: content.text is a JSON-encoded inner-inner
        // envelope. Fields are snake_case there (tool_use_id, tool_name,
        // input).
        try {
          const inner = JSON.parse(c.text) as Record<string, unknown>;
          parsed = {
            toolUseId:
              typeof inner.tool_use_id === "string"
                ? inner.tool_use_id
                : undefined,
            toolName:
              typeof inner.tool_name === "string"
                ? inner.tool_name
                : undefined,
            parameters:
              inner.input && typeof inner.input === "object"
                ? (inner.input as Record<string, unknown>)
                : {},
          };
        } catch {
          // fall through to the docs-shape path
        }
      }

      // Documented shape: fields directly on the block.
      if (parsed.toolUseId === undefined && typeof b.toolUseId === "string") {
        parsed.toolUseId = b.toolUseId;
      }
      if (parsed.toolName === undefined && typeof b.toolName === "string") {
        parsed.toolName = b.toolName;
      }
      if (parsed.parameters === undefined && typeof b.parameters === "object") {
        parsed.parameters =
          (b.parameters as Record<string, unknown>) ?? {};
      }

      if (parsed.toolUseId && parsed.toolName) {
        out.push({
          type: "approval_request",
          toolUseId: parsed.toolUseId,
          toolName: parsed.toolName,
          parameters: parsed.parameters ?? {},
        });
      }
      continue;
    }

    // serverToolUse / serverToolResult / unknown types: drop silently.
  }
  return out;
}

/** Cap diagnostic strings at 500 characters so log lines stay readable. */
function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Test hook — reset the JSON-RPC id counter to 1 for deterministic test output. */
export function __resetRpcIdForTests(): void {
  nextRpcId = 1;
}
