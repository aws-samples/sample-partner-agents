/**
 * Async agent path — single Lambda function that handles three event
 * shapes via a dispatcher:
 *
 *   1. API Gateway POST /agent/start  → write a pending job, async-
 *      invoke ourselves with the worker payload, return { jobId } in
 *      <100 ms.
 *
 *   2. API Gateway GET /agent/poll    → look up the job in DDB and
 *      return its current state. Cheap; safe to poll every 1.5 s
 *      from the card.
 *
 *   3. Lambda async invocation        → read the worker payload, call
 *      MCP (full 5-min Lambda timeout, untethered from the API
 *      Gateway 30 s ceiling), write the result to DDB.
 *
 * Why one Lambda for all three? Sharing the bundle and the IAM role
 * is simpler than three separate functions, and the dispatch is two
 * cheap branches at the top.
 *
 * Why a separate Lambda from `handlers/agent.ts`? IAM hygiene. Only
 * this Lambda needs DynamoDB read/write and `lambda:Invoke` on
 * itself. The synchronous `POST /agent` keeps a tighter IAM surface
 * and stays available as the canonical chat-channel path.
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";

import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandInput,
} from "@aws-sdk/client-lambda";

import { runAgent } from "../core/run-agent";
import { loadAgentConfigFromSecretsManager } from "../lib/config";
import { createMcpClient } from "../lib/mcp-client";
import { ErrorCode, makeError, type AgentResponse } from "../lib/errors";
import { verifyHubspotSignature } from "../lib/hubspot-signature";
import {
  getJob,
  markComplete,
  markFailedWithError,
  markRunning,
  putPendingJob,
  type StoredRequest,
} from "../lib/job-store";
import { parseBody } from "./agent";
import {
  toProxyResult,
  requestIdOf,
  logBegin,
} from "./shared";

/**
 * Worker invocation payload. The start handler writes one of these
 * via `lambda:Invoke` with `InvocationType: "Event"`. The dispatcher
 * recognises it by the absence of a `requestContext` property (which
 * is always present on API Gateway events).
 */
type WorkerEvent = {
  __workerInvocation: true;
  jobId: string;
  request: StoredRequest;
};

type AnyEvent =
  | APIGatewayProxyEventV2WithRequestContext<unknown>
  | WorkerEvent;

let _lambdaClient: LambdaClient | undefined;
function lambdaClient(): LambdaClient {
  if (!_lambdaClient) _lambdaClient = new LambdaClient({});
  return _lambdaClient;
}

/** Test-only: replace the lambda client. */
export function __setLambdaClientForTests(c: LambdaClient): void {
  _lambdaClient = c;
}

export const handler = async (
  event: AnyEvent,
): Promise<APIGatewayProxyResultV2 | { ok: boolean }> => {
  // Worker invocation: no API Gateway context. Process and return.
  if (isWorkerEvent(event)) {
    await handleWorker(event);
    return { ok: true };
  }

  // API Gateway event: dispatch by route key.
  const apiEvent = event;
  const reqId = requestIdOf(apiEvent);
  logBegin(apiEvent, reqId);

  const requestContext = apiEvent.requestContext as
    | { routeKey?: string }
    | undefined;
  const routeKey = requestContext?.routeKey;
  if (routeKey === "POST /agent/start") {
    return await handleStart(apiEvent);
  }
  if (routeKey === "GET /agent/poll") {
    return await handlePoll(apiEvent);
  }

  return toProxyResult(
    makeError(
      ErrorCode.INTERNAL,
      undefined,
      `Unknown route: ${routeKey ?? "(none)"}`,
    ),
    404,
  );
};

// ---------------------------------------------------------------------------
// Start handler
// ---------------------------------------------------------------------------

async function handleStart(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>,
): Promise<APIGatewayProxyResultV2> {
  // Reuse the synchronous handler's parsing + signature verification
  // so the request shape is identical to POST /agent.
  const cfg = await loadAgentConfigFromSecretsManager();
  if (!cfg.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.MISSING_SECRET,
        undefined,
        `Configuration error: missing secrets: ${cfg.missing.join(", ")}. Contact your admin.`,
        { missingSecrets: cfg.missing },
      ),
      500,
    );
  }

  const sigResult = verifyHubspotSignature(
    event as unknown as Parameters<typeof verifyHubspotSignature>[0],
    cfg.config.hubspotClientSecret,
  );
  if (!sigResult.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.AUTH_INVALID,
        undefined,
        "Authorization failed. Reload the HubSpot page and try again.",
      ),
      401,
    );
  }

  const parsed = parseBody(event);
  if (parsed === undefined) {
    return toProxyResult(
      makeError(
        ErrorCode.INTERNAL,
        undefined,
        "Malformed request body. Expected { dealId, message, sessionId? }.",
      ),
      400,
    );
  }

  const jobId = randomUUID();
  const stored: StoredRequest = {
    dealId: parsed.dealId,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    message: parsed.message,
  };

  // Write the pending record FIRST. If the async invoke fails, the
  // poll endpoint will at least return `pending` rather than 404.
  // The worker can also detect missing-job-record and exit cleanly.
  try {
    await putPendingJob({ jobId, request: stored });
  } catch (err) {
    return toProxyResult(
      makeError(
        ErrorCode.INTERNAL,
        "putPendingJob",
        `Failed to register job: ${(err as Error).message}`,
      ),
      500,
    );
  }

  // Async self-invoke. `InvocationType: Event` returns immediately
  // (~10 ms) and runs the worker in a separate Lambda invocation
  // with its own 5-min timeout — no API Gateway in front of it.
  const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME ?? "ace-agent-AgentAsyncLambda";
  const workerPayload: WorkerEvent = {
    __workerInvocation: true,
    jobId,
    request: stored,
  };
  const invokeArgs: InvokeCommandInput = {
    FunctionName: fnName,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify(workerPayload)),
  };

  try {
    await lambdaClient().send(new InvokeCommand(invokeArgs));
  } catch (err) {
    // Self-invoke failed. Mark the job errored so the polling card
    // surfaces a real message instead of waiting forever.
    const errorMessage = `Failed to dispatch worker: ${(err as Error).message}`;
    await markFailedWithError({ jobId, errorMessage });
    return toProxyResult(
      makeError(ErrorCode.INTERNAL, "lambdaInvoke", errorMessage),
      500,
    );
  }

  log("agent.async.start", {
    jobId,
    dealId: parsed.dealId,
    sessionId: parsed.sessionId ?? null,
  });

  return {
    statusCode: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, jobId }),
  };
}

// ---------------------------------------------------------------------------
// Poll handler
// ---------------------------------------------------------------------------

async function handlePoll(
  event: APIGatewayProxyEventV2WithRequestContext<unknown>,
): Promise<APIGatewayProxyResultV2> {
  // GET requests don't carry a body; verify HMAC against the empty
  // body so the v3 signature check still binds the URL + timestamp.
  const cfg = await loadAgentConfigFromSecretsManager();
  if (!cfg.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.MISSING_SECRET,
        undefined,
        `Configuration error: missing secrets: ${cfg.missing.join(", ")}. Contact your admin.`,
        { missingSecrets: cfg.missing },
      ),
      500,
    );
  }

  const sigResult = verifyHubspotSignature(
    event as unknown as Parameters<typeof verifyHubspotSignature>[0],
    cfg.config.hubspotClientSecret,
  );
  if (!sigResult.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.AUTH_INVALID,
        undefined,
        "Authorization failed. Reload the HubSpot page and try again.",
      ),
      401,
    );
  }

  const jobId = event.queryStringParameters?.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    return toProxyResult(
      makeError(
        ErrorCode.INTERNAL,
        undefined,
        "Missing required query parameter: jobId",
      ),
      400,
    );
  }

  const job = await getJob(jobId);
  if (!job) {
    return toProxyResult(
      makeError(
        ErrorCode.MCP_NOT_FOUND,
        undefined,
        "Job not found or expired. Try the action again.",
      ),
      404,
    );
  }

  // Render the job's current state. The card narrows on `status` —
  // when `complete` or `error`, `response` carries the AgentResponse
  // body verbatim (mirrors the synchronous endpoint's wire format
  // so the card can reuse the same rendering code).
  const wire: {
    ok: true;
    status: typeof job.status;
    jobId: string;
    response?: AgentResponse;
    errorMessage?: string;
  } = {
    ok: true,
    status: job.status,
    jobId,
    ...(job.response ? { response: job.response } : {}),
    ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wire),
  };
}

// ---------------------------------------------------------------------------
// Worker handler
// ---------------------------------------------------------------------------

async function handleWorker(event: WorkerEvent): Promise<void> {
  log("agent.async.worker.begin", {
    jobId: event.jobId,
    dealId: event.request.dealId,
  });

  try {
    await markRunning(event.jobId);
  } catch (err) {
    // If we can't even update the record to running, the table is
    // probably gone or our IAM is wrong. Bail — the card's poll will
    // eventually return 404 once TTL expires the pending row.
    log("agent.async.worker.markRunning.failed", {
      jobId: event.jobId,
      error: (err as Error).message,
    });
    return;
  }

  // Reload config + build MCP client (each Lambda container loads
  // these once and reuses across invocations, so the cost is on
  // cold start only).
  const cfg = await loadAgentConfigFromSecretsManager();
  if (!cfg.ok) {
    await markFailedWithError({
      jobId: event.jobId,
      errorMessage: `Configuration error: missing secrets: ${cfg.missing.join(", ")}.`,
    });
    return;
  }

  const mcp = createMcpClient();

  // Same orchestration the sync handler uses — full feature parity
  // (deal context preamble, validation, MCP call, error mapping).
  const response = await runAgentSafely({
    request: event.request,
    config: cfg.config,
    mcp,
  });

  try {
    await markComplete({ jobId: event.jobId, response });
  } catch (err) {
    // Surface the failure to mark complete via a separate error
    // record so the card sees the problem rather than waiting forever.
    log("agent.async.worker.markComplete.failed", {
      jobId: event.jobId,
      error: (err as Error).message,
    });
    await markFailedWithError({
      jobId: event.jobId,
      errorMessage: `Failed to record agent response: ${(err as Error).message}`,
    });
    return;
  }

  log("agent.async.worker.complete", {
    jobId: event.jobId,
    ok: response.ok,
    status: response.ok ? response.status : "error",
  });
}

/**
 * Wrap `runAgent` in try/catch so an unexpected exception in the
 * orchestration layer (e.g. malformed HubSpot deal payload, MCP
 * client crash) doesn't take the worker down without leaving a
 * trace. Always returns a typed AgentResponse the store can persist.
 */
async function runAgentSafely(args: {
  request: StoredRequest;
  config: Parameters<typeof runAgent>[1]["config"];
  mcp: ReturnType<typeof createMcpClient>;
}): Promise<AgentResponse> {
  try {
    // The shape the sync handler builds via `parseBody` — same fields
    // we stored verbatim. Cast through unknown because StoredRequest
    // declares `message: unknown` (we don't re-validate inside the
    // worker; the sync handler's parseBody already did).
    return await runAgent(args.request as unknown as Parameters<typeof runAgent>[0], {
      config: args.config,
      mcp: args.mcp,
    });
  } catch (err) {
    return makeError(
      ErrorCode.INTERNAL,
      "runAgent",
      `Worker crashed: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWorkerEvent(event: AnyEvent): event is WorkerEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "__workerInvocation" in event &&
    (event as WorkerEvent).__workerInvocation === true
  );
}

function log(eventName: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "agent-async",
      event: eventName,
      ...details,
    }),
  );
}
