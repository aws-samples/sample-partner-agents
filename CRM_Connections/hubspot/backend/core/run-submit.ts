/**
 * Submit_Function orchestration (Requirements 4.1–4.6, 6.1–6.4, 8.1, 8.2,
 * 8.5, 9.5, 11.3).
 *
 * Submit is the deliberate "send this opportunity to AWS for review" half
 * of the decoupled Share/Submit pair. It runs ONLY against an opportunity
 * that already has `ace_opportunity_id` set, and ONLY when AWS's
 * `aws_review_status` is one of `{"Pending Submission", ""}`. Any other
 * state fails fast — there is no fallback path that creates / updates
 * the AWS opportunity from this entry point.
 *
 * Steps:
 *   1. Read the deal's narrow Submit property set from HubSpot.
 *      A read failure surfaces as a `HUBSPOT_WRITE` envelope (the code
 *      covers the whole HubSpot-IO failure class).
 *   2. R4.1: fail fast with PRECONDITION when `ace_opportunity_id` is
 *      empty.
 *   3. R4.2: fail fast with PRECONDITION when any
 *      `Submission_Required_Field` (`ace_involvement_type`,
 *      `ace_visibility`) is empty / whitespace-only.
 *   4. R6.4 + R11.3: fail fast with PRECONDITION when
 *      `aws_review_status` ∈ NON_SUBMITTABLE_STATES. Empty state and
 *      `"Pending Submission"` both fall through.
 *   5. Best-effort `ListEngagementFromOpportunityTasks`. Pick the most
 *      recent task by `StartTime` desc.
 *        - IN_PROGRESS → return success "Submission already in progress."
 *          with no AWS write (R6.2, R9.5).
 *        - FAILED → use a fresh `randomUUID()` ClientToken on retry
 *          (R6.3) so AWS's idempotency cache doesn't silently re-return
 *          the prior failure.
 *        - Otherwise (none, or COMPLETE) → use the deterministic
 *          `generateEngagementClientToken(dealId)` (R6.1).
 *      A list throw is treated as "no prior task" so transient list
 *      failures don't block recovery.
 *   6. `StartEngagementFromOpportunityTask` with the chosen ClientToken
 *      and the existing `buildAwsSubmission(deal, config)` payload.
 *      On synchronous failure: write only `ace_sync_status="Sync Error"`,
 *      `ace_sync_error="StartEngagement: <msg>"`, `ace_last_sync=nowIso()`.
 *      We NEVER include `ace_opportunity_id` or `aws_review_status` in
 *      the failure write (R4.4, R8.1, R8.2, R8.5) so the deal stays
 *      recoverable.
 *   7. Read back via `fetchAceSnapshot` + `snapshotToProps` and write the
 *      full snapshot plus `ace_sync_status="Synced"`, `ace_last_sync=nowIso()`,
 *      `ace_sync_error=""`. Return success envelope with message
 *      containing `submitted for review` (R4.6).
 */

import { randomUUID } from "node:crypto";

import { ACE_CATALOG } from "../lib/config";
import type { AppConfig } from "../lib/config";
import { generateEngagementClientToken } from "../lib/client-token";
import { ACEThrottledError } from "../lib/ace";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import { ErrorCode, makeError } from "../lib/errors";
import type { FunctionResponse, SuccessResponse } from "../lib/errors";
import type { DealProps } from "../lib/preconditions";
import { missingSubmissionFields } from "../lib/submission-mode";
import type { SubmissionInputs } from "../lib/submission-mode";
import {
  buildAwsSubmission,
  fetchAceSnapshot,
  snapshotToProps,
} from "./run-share";

/**
 * Deal properties Submit needs. Narrower than `runShare` because Submit
 * never builds a Create / Update payload — it only inspects gating
 * fields, calls StartEngagement, and writes back the post-engagement
 * snapshot. The post-engagement read pulls everything else from AWS
 * directly via `fetchAceSnapshot`.
 *
 * `dealname` and `contract_term__months_` are included so
 * `snapshotToProps(snapshot, deal)` can reverse the monthly-spend math
 * to compute HubSpot's `amount` (total contract value).
 */
const SUBMIT_DEAL_PROPERTY_NAMES = [
  "dealname",
  "contract_term__months_",
  "ace_opportunity_id",
  "ace_involvement_type",
  "ace_visibility",
  "aws_review_status",
  "ace_sync_status",
  "ace_last_sync",
  "ace_sync_error",
] as const;

/**
 * `aws_review_status` values where Submit refuses to call AWS at all
 * (R6.4 + R11.3). `"Pending Submission"` and the empty-string legacy
 * state are NOT in this set — both fall through to the engagement
 * task path. `"Disqualified"` is included defensively even though
 * the requirements list five values; AWS rejects StartEngagement
 * against a Disqualified opp, and surfacing the same fail-fast
 * message here saves a round-trip.
 */
const NON_SUBMITTABLE_STATES = new Set([
  "Submitted",
  "In Review",
  "Action Required",
  "Approved",
  "Rejected",
  "Disqualified",
]);

/** Documented AWS task statuses surfaced by `ListEngagementFromOpportunityTasks`. */
type AceTaskStatus = "IN_PROGRESS" | "COMPLETE" | "FAILED";

/** Subset of the AWS task summary shape we read from the list response. */
type AceTaskSummary = {
  TaskStatus?: AceTaskStatus | string;
  StartTime?: Date | string;
  Message?: string;
  ReasonCode?: string;
};

/** Current time as an ISO-8601 UTC string — format expected by `ace_last_sync`. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Walk the AWS task list, sort by `StartTime` descending, and return the
 * head. AWS populates `StartTime` on every task summary so ordering is
 * well-defined; non-Date values are coerced via `Date.parse` (the SDK
 * usually returns `Date` instances but the wire shape can be a string in
 * some replay scenarios). Tasks missing a `StartTime` sort last.
 *
 * Returns `undefined` when the list is empty / undefined.
 */
function pickMostRecentTask(
  tasks: AceTaskSummary[] | undefined
): AceTaskSummary | undefined {
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
  const toMillis = (v: Date | string | undefined): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? parsed : -Infinity;
    }
    return -Infinity;
  };
  // Stable copy so we don't mutate the caller's array.
  const sorted = [...tasks].sort(
    (a, b) => toMillis(b.StartTime) - toMillis(a.StartTime)
  );
  return sorted[0];
}

/**
 * Dependencies injected into `runSubmit`. The Lambda handler wrapper
 * (`handlers/submit.ts`) wires real dependencies from Secrets Manager +
 * the real SDK clients; tests substitute in-memory mocks.
 *
 * Submit does NOT take the pull-lock cache — Create-side dedup is the
 * lock's only consumer and Submit never creates an opportunity.
 */
export type SubmitDeps = {
  config: AppConfig;
  ace: AceClient;
  hs: HubspotClient;
};

/**
 * Main submit orchestration. Pure of side effects until step 6
 * (StartEngagement); preconditions are checked locally so AWS never
 * sees a request the deal is unequipped to satisfy.
 */
export async function runSubmit(
  dealId: number,
  deps: SubmitDeps
): Promise<FunctionResponse> {
  const { config, ace, hs } = deps;

  // 1. Read deal.
  let deal: DealProps;
  try {
    deal = (await hs.readDealProperties(
      dealId,
      // Cast to a mutable string[] — `readDealProperties` accepts any
      // string array, but our constant is `readonly` for safety.
      [...SUBMIT_DEAL_PROPERTY_NAMES]
    )) as DealProps;
  } catch (err) {
    return makeError(
      ErrorCode.HUBSPOT_WRITE,
      "readDeal",
      `Failed to read deal ${dealId} from HubSpot: ${(err as Error).message}`
    );
  }

  // 2. R4.1: ace_opportunity_id present.
  const oppId = (deal.ace_opportunity_id ?? "").trim();
  if (!oppId) {
    return makeError(
      ErrorCode.PRECONDITION,
      "checkOpportunityId",
      "Cannot submit: deal has no AWS opportunity yet. Click Share first."
    );
  }

  // 3. R4.2: Submission_Required_Fields populated. `DealProps` carries
  //    the same loose `Record<string, string | undefined>` shape under
  //    its index signature; cast through `unknown` to satisfy the
  //    classifier's narrower `SubmissionInputs` view.
  const missing = missingSubmissionFields(
    deal as unknown as SubmissionInputs
  );
  if (missing.length > 0) {
    return makeError(
      ErrorCode.PRECONDITION,
      "checkSubmissionFields",
      `Cannot submit: missing ${missing.join(", ")}. Set these on the deal then click Submit again.`,
      { preconditionFailures: missing }
    );
  }

  // 4. R6.4 + R11.3: aws_review_status gating. Empty / "Pending
  //    Submission" fall through; everything else fails fast.
  const reviewStatus = (deal.aws_review_status ?? "").trim();
  if (NON_SUBMITTABLE_STATES.has(reviewStatus)) {
    return makeError(
      ErrorCode.PRECONDITION,
      "checkReviewStatus",
      `Cannot submit: opportunity is already ${reviewStatus} on AWS.`
    );
  }

  // 5. Best-effort task list. A throw here doesn't block recovery —
  //    we just fall through to the deterministic engagement token.
  let mostRecentTask: AceTaskSummary | undefined;
  try {
    const listResp = await ace.listEngagementFromOpportunityTasks({
      Catalog: ACE_CATALOG,
      OpportunityIdentifier: [oppId],
    } as never);
    mostRecentTask = pickMostRecentTask(
      (listResp as { TaskSummaries?: AceTaskSummary[] }).TaskSummaries
    );
  } catch {
    mostRecentTask = undefined;
  }

  if (mostRecentTask?.TaskStatus === "IN_PROGRESS") {
    // R6.2 + R9.5: a duplicate Submit click while AWS is still chewing
    // on the prior task should be a no-op success rather than a second
    // StartEngagement call.
    const successProps = {
      ace_sync_status: "Synced" as const,
      ace_last_sync: nowIso(),
      ace_sync_error: "" as const,
    };
    return {
      ok: true,
      message: "Submission already in progress.",
      properties: successProps,
    };
  }

  // 6. StartEngagement. R6.3: fresh randomUUID() on FAILED retry so
  //    AWS's idempotency cache doesn't silently re-return the prior
  //    failure. R6.1: deterministic token otherwise so a duplicate
  //    Submit click for a never-attempted opp is a no-op idempotent
  //    re-issue rather than a duplicate task.
  const clientToken =
    mostRecentTask?.TaskStatus === "FAILED"
      ? randomUUID()
      : generateEngagementClientToken(dealId);

  try {
    await ace.startEngagementFromOpportunityTask({
      Catalog: ACE_CATALOG,
      Identifier: oppId,
      ClientToken: clientToken,
      AwsSubmission: buildAwsSubmission(deal, config),
    } as never);
  } catch (err) {
    // R4.4 + R8.1 + R8.2 + R8.5: leave ace_opportunity_id and
    // aws_review_status untouched. Only ace_sync_status / ace_sync_error /
    // ace_last_sync change so the partner can recover via another
    // Submit click after fixing the underlying issue (typically an
    // AWS-rejected involvement type / visibility / solution permission).
    const isThrottled = err instanceof ACEThrottledError;
    const msg =
      err instanceof Error && err.message ? err.message : "unknown error";
    try {
      await hs.writeDealProperties(dealId, {
        ace_sync_status: "Sync Error",
        ace_sync_error: `StartEngagement: ${msg}`,
        ace_last_sync: nowIso(),
      });
    } catch {
      // Swallow — the user sees the primary AWS error in the card
      // alert; the next Refresh / EventBridge auto-pull reconciles.
    }
    return makeError(
      isThrottled ? ErrorCode.ACE_THROTTLED : ErrorCode.ACE_CREATE,
      "StartEngagement",
      `Submit failed: ${msg}`
    );
  }

  // 7. Read back the post-engagement state and write the full snapshot
  //    plus the success-state health flags. R4.5 / R4.6.
  const snapshot = await fetchAceSnapshot(ace, oppId);
  const finalTs = nowIso();
  const finalProps = {
    ...snapshotToProps(snapshot, deal),
    ace_sync_status: "Synced" as const,
    ace_last_sync: finalTs,
    ace_sync_error: "" as const,
  };
  try {
    await hs.writeDealProperties(dealId, { ...finalProps });
  } catch {
    // Best-effort: AWS state is canonical; the next Refresh click /
    // EventBridge auto-pull reconciles.
  }

  const success: SuccessResponse = {
    ok: true,
    message: `Opportunity ${oppId} submitted for review.`,
    properties: finalProps,
  };
  return success;
}
