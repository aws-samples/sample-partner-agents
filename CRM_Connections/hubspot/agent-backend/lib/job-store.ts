/**
 * DynamoDB-backed job store for the async agent path.
 *
 * Why this exists
 * ===============
 * API Gateway HTTP APIs cap integration timeouts at 30 seconds. The
 * AWS Partner Central Agent MCP Server's `sendMessage` regularly takes
 * 25–40 seconds for tool-call approvals as session context grows, so
 * we need a way to run the call asynchronously and let the card poll.
 *
 * The pattern: client POSTs to `/agent/start` → start handler writes
 * a job record here, async-invokes the worker handler, returns
 * `{ jobId }` in <100 ms. Worker calls MCP (untethered from API
 * Gateway, full 5-min Lambda timeout), updates the job record with
 * the result. Client polls `/agent/poll?jobId=...` every ~1.5 s,
 * reads the record, renders the result.
 *
 * Schema
 * ======
 *   PK:        jobId        (string, UUID v4)
 *   TTL attr:  expiresAt    (number, epoch seconds)
 *
 * Attributes:
 *   status:       "pending" | "running" | "complete" | "error"
 *   dealId:       number
 *   request:      JSON-stringified inbound payload (sessionId + message)
 *   response:     JSON-stringified AgentResponse (set when status=complete or =error with backend body)
 *   errorMessage: short human-facing string (set when status=error)
 *   createdAt:    ISO 8601 timestamp
 *   updatedAt:    ISO 8601 timestamp
 *
 * TTL is set to creation + 1 hour. Jobs are short-lived; the card
 * either reads the result within ~60 s of completion or the user
 * navigated away.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

import type { AgentResponse } from "./errors";

/** Status values stored in DynamoDB. */
export type JobStatus = "pending" | "running" | "complete" | "error";

/**
 * Job record as the card sees it after polling. Note the `response`
 * is fully-typed, not the JSON-stringified form — the store
 * deserialises before returning.
 */
export type JobRecord = {
  jobId: string;
  status: JobStatus;
  dealId: number;
  /** Set on complete or error (when MCP returned a body). */
  response?: AgentResponse;
  /** Set on error to provide a short user-readable summary. */
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

/** Inputs the card sends on /agent/start. Stored verbatim under `request`. */
export type StoredRequest = {
  dealId: number;
  sessionId?: string;
  message: unknown;
};

/** TTL: jobs auto-expire from DynamoDB 1 hour after creation. */
const JOB_TTL_SECONDS = 60 * 60;

const TABLE_NAME = process.env.AGENT_JOB_TABLE ?? "ace-agent-jobs";

let _client: DynamoDBClient | undefined;
function client(): DynamoDBClient {
  if (!_client) {
    _client = new DynamoDBClient({});
  }
  return _client;
}

/**
 * Test-only: replace the underlying DDB client. Tests inject a
 * fake/recording client. Production code never calls this.
 */
export function __setDynamoClientForTests(c: DynamoDBClient): void {
  _client = c;
}

/**
 * Test-only: reset the cached client to default.
 */
export function __resetDynamoClientForTests(): void {
  _client = undefined;
}

/**
 * Initial write: status=pending. Called by the start handler before
 * it kicks off the async worker invocation.
 */
export async function putPendingJob(args: {
  jobId: string;
  request: StoredRequest;
}): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + JOB_TTL_SECONDS;

  await client().send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        jobId: { S: args.jobId },
        status: { S: "pending" satisfies JobStatus },
        dealId: { N: String(args.request.dealId) },
        request: { S: JSON.stringify(args.request) },
        createdAt: { S: nowIso },
        updatedAt: { S: nowIso },
        expiresAt: { N: String(expiresAt) },
      },
    }),
  );
}

/**
 * Mark a job as running. Called by the worker handler at the start of
 * processing — purely informational so a slow poll cycle can show
 * "still working" instead of "pending".
 */
export async function markRunning(jobId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await client().send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
      UpdateExpression:
        "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": { S: "running" satisfies JobStatus },
        ":updatedAt": { S: nowIso },
      },
    }),
  );
}

/**
 * Terminal write: store the agent's full response and mark the job
 * complete. Called by the worker handler once MCP returns. The card's
 * next poll picks this up and renders.
 */
export async function markComplete(args: {
  jobId: string;
  response: AgentResponse;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await client().send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: args.jobId } },
      // `response` and `status` are both reserved words in DynamoDB.
      // Use ExpressionAttributeNames placeholders for any reserved
      // word that appears as an attribute name in the expression.
      UpdateExpression:
        "SET #status = :status, #response = :response, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
        "#response": "response",
      },
      ExpressionAttributeValues: {
        ":status": {
          S: (args.response.ok ? "complete" : "error") satisfies JobStatus,
        },
        ":response": { S: JSON.stringify(args.response) },
        ":updatedAt": { S: nowIso },
      },
    }),
  );
}

/**
 * Terminal write: store an opaque error (e.g. an exception thrown
 * from the worker invocation itself, before any AgentResponse was
 * synthesised). The card surfaces `errorMessage` in a danger toast.
 */
export async function markFailedWithError(args: {
  jobId: string;
  errorMessage: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await client().send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: args.jobId } },
      UpdateExpression:
        "SET #status = :status, errorMessage = :errorMessage, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": { S: "error" satisfies JobStatus },
        ":errorMessage": { S: args.errorMessage },
        ":updatedAt": { S: nowIso },
      },
    }),
  );
}

/**
 * Read a job by id. Returns `undefined` when no record exists (TTL
 * has already expired the job, or the jobId is forged). The poll
 * handler turns this into a 404.
 */
export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  const resp = await client().send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { jobId: { S: jobId } },
    }),
  );
  if (!resp.Item) return undefined;
  const item = resp.Item;

  const status = (item.status?.S ?? "pending") as JobStatus;
  const dealIdStr = item.dealId?.N;
  const dealId = dealIdStr !== undefined ? Number(dealIdStr) : 0;

  let response: AgentResponse | undefined;
  if (item.response?.S) {
    try {
      response = JSON.parse(item.response.S) as AgentResponse;
    } catch {
      // Stored payload was somehow corrupted. Surface as error.
      return {
        jobId,
        status: "error",
        dealId,
        errorMessage: "Stored response was not valid JSON.",
        createdAt: item.createdAt?.S ?? "",
        updatedAt: item.updatedAt?.S ?? "",
      };
    }
  }

  return {
    jobId,
    status,
    dealId,
    ...(response ? { response } : {}),
    ...(item.errorMessage?.S ? { errorMessage: item.errorMessage.S } : {}),
    createdAt: item.createdAt?.S ?? "",
    updatedAt: item.updatedAt?.S ?? "",
  };
}
