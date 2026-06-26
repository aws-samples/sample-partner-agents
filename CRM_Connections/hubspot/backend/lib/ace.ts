/**
 * Thin wrapper around `@aws-sdk/client-partnercentral-selling` (Requirements
 * 10.1, 10.2, 10.3).
 *
 * Provides:
 *   - A single injectable `PartnerCentralSellingClient` constructed from
 *     `AppConfig` (region + static credentials). Tests pass a pre-built
 *     client mock so the real SDK constructor never runs under Vitest.
 *   - Typed methods for the six commands the Share / Refresh flows need:
 *     `CreateOpportunity`, `AssociateOpportunity`,
 *     `StartEngagementFromOpportunityTask`, `UpdateOpportunity`,
 *     `GetOpportunity`, and `GetAwsOpportunitySummary`.
 *   - A throttle-retry policy: on `ThrottlingException` or
 *     `TooManyRequestsException`, sleep 1000ms and retry once. A second
 *     failure surfaces to the caller as `ACEThrottledError`, which
 *     `share.ts` / `refresh.ts` translate into the `ACE_THROTTLED` error
 *     code (R10.3).
 *
 * Non-throttling errors (e.g. `ConflictException` from a stale
 * `LastModifiedDate` on `UpdateOpportunity`) pass straight through
 * unchanged so the caller can handle them per R11.2.
 *
 * ---
 * Note on retry policy scope. The design document's Share_Function
 * algorithm originally sketched a three-attempt policy with exponential
 * backoff (1000ms, 2000ms). `tasks.md` §9.1 narrowed that to a single
 * 1000ms retry, which is what this module implements. If the
 * multi-attempt policy is ever needed, it can be reintroduced here
 * without breaking the callers because `sendWithRetry` is the only
 * place that decides how many times to retry.
 */

import {
  PartnerCentralSellingClient,
  CreateOpportunityCommand,
  type CreateOpportunityCommandInput,
  type CreateOpportunityCommandOutput,
  UpdateOpportunityCommand,
  type UpdateOpportunityCommandInput,
  type UpdateOpportunityCommandOutput,
  GetOpportunityCommand,
  type GetOpportunityCommandInput,
  type GetOpportunityCommandOutput,
  GetAwsOpportunitySummaryCommand,
  type GetAwsOpportunitySummaryCommandInput,
  type GetAwsOpportunitySummaryCommandOutput,
  AssociateOpportunityCommand,
  type AssociateOpportunityCommandInput,
  type AssociateOpportunityCommandOutput,
  DisassociateOpportunityCommand,
  type DisassociateOpportunityCommandInput,
  type DisassociateOpportunityCommandOutput,
  StartEngagementFromOpportunityTaskCommand,
  type StartEngagementFromOpportunityTaskCommandInput,
  type StartEngagementFromOpportunityTaskCommandOutput,
  ListEngagementFromOpportunityTasksCommand,
  type ListEngagementFromOpportunityTasksCommandInput,
  type ListEngagementFromOpportunityTasksCommandOutput,
} from "@aws-sdk/client-partnercentral-selling";

import type { AppConfig } from "./config";

/** Delay, in milliseconds, between the initial attempt and the single retry. */
const RETRY_DELAY_MS = 1000;

/**
 * Thrown when an ACE call is rate-limited twice in a row. Callers translate
 * this into an `ACE_THROTTLED` error response; no other error type in this
 * module should be caught and re-wrapped — they flow through unchanged.
 */
export class ACEThrottledError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ACEThrottledError";
    this.cause = cause;
  }
}

/**
 * AWS SDK v3 surfaces throttling as either `ThrottlingException` or the
 * legacy `TooManyRequestsException` name, depending on the service. Check
 * both so the policy is robust across SDK updates.
 */
function isThrottlingError(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "name" in err) {
    const name = (err as { name: unknown }).name;
    return name === "ThrottlingException" || name === "TooManyRequestsException";
  }
  return false;
}

/**
 * Build a verbose, operator-actionable diagnostic string from an AWS
 * Partner Central SDK error.
 *
 * Partner Central `ValidationException`s frequently carry an EMPTY
 * top-level `message` — which the AWS SDK then surfaces as the useless
 * literal `"UnknownError"` — while the real, field-level detail lives in
 * `ErrorList: [{ FieldName, Message, Code }]` (and sometimes a `Reason`).
 * Example seen in the wild: top-level message empty, ErrorList =
 * `[{ FieldName: "ExpectedCustomerSpend.CurrencyCode", Code:
 * "INVALID_VALUE", Message: "ESC cloud partition requires EUR currency" }]`.
 *
 * This folds those entries into a single readable string so the card's
 * "Sync Error" and the CloudWatch log show e.g.
 *   "ExpectedCustomerSpend.CurrencyCode: ESC cloud partition requires EUR
 *    currency (INVALID_VALUE)"
 * instead of "UnknownError". It only ever exposes AWS's own field names
 * and diagnostics — never the request payload values.
 */
export function describeAceError(err: unknown): string {
  if (err === null || typeof err !== "object") {
    return typeof err === "string" && err.length > 0 ? err : "unknown error";
  }
  const e = err as Record<string, unknown>;
  const name = typeof e.name === "string" ? e.name : "";
  const baseMsg =
    typeof e.message === "string" && e.message.length > 0 ? e.message : "";
  const reason = typeof e.Reason === "string" ? e.Reason : "";

  // Fold field-level ErrorList entries (the actionable part).
  const list = Array.isArray(e.ErrorList) ? e.ErrorList : [];
  const fieldParts: string[] = [];
  for (const item of list) {
    if (item !== null && typeof item === "object") {
      const f = item as Record<string, unknown>;
      const field = typeof f.FieldName === "string" ? f.FieldName : "";
      const fmsg = typeof f.Message === "string" ? f.Message : "";
      const fcode = typeof f.Code === "string" ? f.Code : "";
      const seg = [field, fmsg].filter((s) => s.length > 0).join(": ");
      const withCode = fcode.length > 0 ? `${seg} (${fcode})`.trim() : seg;
      if (withCode.length > 0) fieldParts.push(withCode);
    }
  }
  const detail = fieldParts.join("; ");

  // The SDK fills `.message` with "UnknownError" when the modeled message
  // is empty — treat that as no-signal so we prefer the field-level detail.
  const usefulBase = baseMsg && baseMsg !== "UnknownError" ? baseMsg : "";

  if (detail) {
    return usefulBase ? `${usefulBase} — ${detail}` : detail;
  }
  if (usefulBase) return usefulBase;
  if (reason) return reason;
  // Last resort: the raw (unhelpful) message or the exception name, so we
  // never return an empty string.
  return baseMsg || name || "unknown error";
}

/** Await-able sleep for the inter-retry delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Public interface of the wrapper. Expressed as a plain object type so
 * call sites can mock it with a simple record in Vitest without
 * subclassing the SDK's command/client machinery.
 */
export type AceClient = {
  createOpportunity(
    input: CreateOpportunityCommandInput
  ): Promise<CreateOpportunityCommandOutput>;
  associateOpportunity(
    input: AssociateOpportunityCommandInput
  ): Promise<AssociateOpportunityCommandOutput>;
  disassociateOpportunity(
    input: DisassociateOpportunityCommandInput
  ): Promise<DisassociateOpportunityCommandOutput>;
  startEngagementFromOpportunityTask(
    input: StartEngagementFromOpportunityTaskCommandInput
  ): Promise<StartEngagementFromOpportunityTaskCommandOutput>;
  listEngagementFromOpportunityTasks(
    input: ListEngagementFromOpportunityTasksCommandInput
  ): Promise<ListEngagementFromOpportunityTasksCommandOutput>;
  updateOpportunity(
    input: UpdateOpportunityCommandInput
  ): Promise<UpdateOpportunityCommandOutput>;
  getOpportunity(
    input: GetOpportunityCommandInput
  ): Promise<GetOpportunityCommandOutput>;
  getAwsOpportunitySummary(
    input: GetAwsOpportunitySummaryCommandInput
  ): Promise<GetAwsOpportunitySummaryCommandOutput>;
};

/**
 * Build an `AceClient` from `AppConfig`.
 *
 * The underlying `PartnerCentralSellingClient` is injectable via the
 * optional `sdk` parameter so unit tests can pass a mocked SDK without
 * touching the real constructor (which does network-y things at init
 * time on Node 20).
 *
 * @param config AppConfig carrying the AWS credentials + region.
 * @param sdk    Optional pre-built SDK client (test seam).
 */
export function createAceClient(
  config: AppConfig,
  sdk?: PartnerCentralSellingClient
): AceClient {
  // When the operator left the static AWS keys out of Secrets Manager,
  // fall through to the SDK's default credential provider chain. In
  // production that resolves to the Lambda execution role, which the
  // CloudFormation template grants `partnercentral-selling:*` on. Use
  // static keys only as an explicit override.
  const useStaticCredentials =
    !!config.awsAccessKeyId && !!config.awsSecretAccessKey;

  const client =
    sdk ??
    new PartnerCentralSellingClient({
      region: config.aceRegion,
      ...(useStaticCredentials
        ? {
            credentials: {
              accessKeyId: config.awsAccessKeyId as string,
              secretAccessKey: config.awsSecretAccessKey as string,
            },
          }
        : {}),
    });

  /**
   * Run `invoke`. On a throttling error, wait `RETRY_DELAY_MS` and run it
   * once more. A second throttling error becomes an `ACEThrottledError`;
   * any other error (including non-throttling errors on the retry)
   * propagates unchanged so the caller can map it to the appropriate
   * `ACE_*` error code.
   */
  async function sendWithRetry<T>(
    invoke: () => Promise<T>,
    opName: string
  ): Promise<T> {
    try {
      return await invoke();
    } catch (err) {
      if (!isThrottlingError(err)) {
        throw err;
      }
      await sleep(RETRY_DELAY_MS);
      try {
        return await invoke();
      } catch (retryErr) {
        if (isThrottlingError(retryErr)) {
          throw new ACEThrottledError(
            `${opName} throttled after retry`,
            retryErr
          );
        }
        throw retryErr;
      }
    }
  }

  return {
    createOpportunity: (input) =>
      sendWithRetry(
        () => client.send(new CreateOpportunityCommand(input)),
        "CreateOpportunity"
      ),
    associateOpportunity: (input) =>
      sendWithRetry(
        () => client.send(new AssociateOpportunityCommand(input)),
        "AssociateOpportunity"
      ),
    disassociateOpportunity: (input) =>
      sendWithRetry(
        () => client.send(new DisassociateOpportunityCommand(input)),
        "DisassociateOpportunity"
      ),
    startEngagementFromOpportunityTask: (input) =>
      sendWithRetry(
        () => client.send(new StartEngagementFromOpportunityTaskCommand(input)),
        "StartEngagementFromOpportunityTask"
      ),
    listEngagementFromOpportunityTasks: (input) =>
      sendWithRetry(
        () => client.send(new ListEngagementFromOpportunityTasksCommand(input)),
        "ListEngagementFromOpportunityTasks"
      ),
    updateOpportunity: (input) =>
      sendWithRetry(
        () => client.send(new UpdateOpportunityCommand(input)),
        "UpdateOpportunity"
      ),
    getOpportunity: (input) =>
      sendWithRetry(
        () => client.send(new GetOpportunityCommand(input)),
        "GetOpportunity"
      ),
    getAwsOpportunitySummary: (input) =>
      sendWithRetry(
        () => client.send(new GetAwsOpportunitySummaryCommand(input)),
        "GetAwsOpportunitySummary"
      ),
  };
}
