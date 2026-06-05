/**
 * EventBridge-driven AWS → HubSpot pull orchestration.
 *
 * Routes a single Partner Central event (`Opportunity Created` or
 * `Opportunity Updated`) into the right side-effect:
 *
 *   - If a HubSpot deal already carries `ace_opportunity_id ==
 *     <opportunity.identifier>`, run the same logic the Refresh button
 *     runs (`runRefresh`) so the deal picks up the latest AWS state
 *     without the rep having to click anything.
 *
 *   - If no deal carries that id, create a new HubSpot deal seeded
 *     with the AWS-side state (title, close date, monthly amount,
 *     Solutions list, OtherSolutionDescription, etc.) at the
 *     reverse-mapped HubSpot stage.
 *
 * The Lambda handler in `handlers/pull.ts` is the only caller. Tests
 * use `runPull(event, deps)` directly with literal-record mocks for
 * the ACE / HubSpot wrappers.
 *
 * ## Idempotency
 *
 * Two distinct races can produce duplicate HubSpot deals; both are
 * defended at the DynamoDB lock layer (`PullLockTable` /
 * `lib/pull-lock.ts`):
 *
 *   1. **Concurrent invocations.** Two events for the same opp land
 *      simultaneously. The second `PutItem` fails the conditional
 *      check; `acquireLock` returns either a `cache_hit` (if the
 *      first invocation already wrote a `dealId`) or throws
 *      `LockHeldError`, which the handler converts to a Lambda
 *      failure so EventBridge retries with backoff.
 *
 *   2. **Sequential invocations within HubSpot's search-index lag.**
 *      Invocation 1 finishes (creates deal A, releases lock with
 *      dealId cached). Invocation 2 starts a few seconds later —
 *      HubSpot's eventually-consistent search hasn't propagated the
 *      `ace_opportunity_id` value yet. Without the cache, invocation
 *      2 would search HubSpot, miss, and create a duplicate. With
 *      the cache, the conditional `PutItem` on the still-live row
 *      fails, the peek returns the cached `dealId`, and runPull
 *      runs Refresh directly. The cache row TTLs out an hour later,
 *      well past HubSpot's worst observed lag.
 *
 * Different opportunities run wide open: the lock is keyed on
 * `oppId` so two events for two different opps never contend. That
 * preserves throughput across a busy multi-tenant deployment.
 *
 * ## Why the Refresh path on Updated events
 *
 * Each `Opportunity Updated` event carries only the opp identifier;
 * the full AWS state is fetched via `GetOpportunity` /
 * `GetAwsOpportunitySummary`. That's the same pair of reads `runRefresh`
 * already orchestrates, plus the snapshot → HubSpot write-back. So
 * we delegate to `runRefresh` rather than duplicating the snapshot
 * logic.
 */

import { ACE_CATALOG } from "../lib/config";
import type { AppConfig } from "../lib/config";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import { ErrorCode, makeError } from "../lib/errors";
import type { FunctionResponse } from "../lib/errors";
import { resolveStatus } from "../lib/resolve-status";
import { runRefresh } from "./run-refresh";
import { snapshotFromOpportunity, snapshotToProps } from "./run-share";
import { acquireLock, LockHeldError } from "../lib/pull-lock";
import type { LockDeps } from "../lib/pull-lock";

/**
 * Trimmed shape of the EventBridge event we accept. Defined here so this
 * module doesn't pull in `aws-lambda` types and stays unit-testable with
 * literal records. The handler does the boundary parsing — every field
 * here is required (`detail.opportunity.identifier`, `detail.catalog`,
 * `detail-type`).
 */
export type AcePullEvent = {
  /** "Opportunity Created" | "Opportunity Updated". */
  detailType: string;
  detail: {
    catalog: string;
    opportunity: { identifier: string };
  };
};

export type PullDeps = {
  config: AppConfig;
  ace: AceClient;
  hs: HubspotClient;
  /**
   * Per-opportunity lock dependencies. Pulled into the deps bag so
   * tests can supply a stub DynamoDB client without booting the SDK.
   * The handler in `handlers/pull.ts` populates this from the
   * `PULL_LOCK_TABLE` env var; tests can pass a literal stub.
   */
  lock: LockDeps;
};

export type PullOutcome =
  | { ok: true; action: "refreshed" | "created" | "skipped" | "lock_held"; dealId?: number; reason?: string }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> };

/**
 * Orchestrate one EventBridge event:
 *
 *   1. Reject events that don't target our catalog (`Sandbox` /
 *      `AWS`) — partners that misconfigure the rule should fail loudly.
 *   2. Acquire the per-opportunity DynamoDB lock. If held, return a
 *      structured `lock_held` outcome — the handler turns this into a
 *      Lambda failure so EventBridge retries with backoff.
 *   3. Look up the HubSpot deal by `ace_opportunity_id`.
 *   4. Branch:
 *        present → `runRefresh(dealId, deps)`
 *        absent  → fetch the opp, build a HubSpot deal, create it.
 *   5. Release the lock.
 */
export async function runPull(
  event: AcePullEvent,
  deps: PullDeps
): Promise<PullOutcome> {
  const oppId = event.detail.opportunity.identifier?.trim();
  if (!oppId) {
    return {
      ok: false,
      code: ErrorCode.INTERNAL,
      message: "EventBridge event is missing detail.opportunity.identifier",
    };
  }

  if (event.detail.catalog !== ACE_CATALOG) {
    // The rule should be filtering on catalog already, but defend in
    // depth — a misconfigured rule that forwarded production events
    // to the Sandbox-bound Lambda would otherwise silently process
    // them with the wrong credentials.
    return {
      ok: true,
      action: "skipped",
      reason: `event catalog ${event.detail.catalog} ≠ stack catalog ${ACE_CATALOG}`,
    };
  }

  // Acquire the per-opportunity lock + dealId cache. Three outcomes:
  //   - `acquired`  → run the orchestration; on success call
  //                   `release(dealId)` to convert the row into a
  //                   1-hour cache entry so subsequent invocations
  //                   skip the HubSpot search index.
  //   - `cache_hit` → another invocation already created this deal.
  //                   Skip search, run Refresh against the cached
  //                   dealId. Solves the HubSpot search-index lag
  //                   that lets sequential invocations duplicate.
  //   - LockHeldError → contention with no cache yet. Surface as
  //                   lock_held so EventBridge retries.
  let lockResult;
  try {
    lockResult = await acquireLock(oppId, deps.lock);
  } catch (err) {
    if (err instanceof LockHeldError) {
      return {
        ok: true,
        action: "lock_held",
        reason: `another invocation is processing ${oppId}; EventBridge will retry`,
      };
    }
    return {
      ok: false,
      code: ErrorCode.INTERNAL,
      message: `Failed to acquire pull lock for ${oppId}: ${(err as Error).message}`,
    };
  }

  if (lockResult.kind === "cache_hit") {
    // Hot path: another pull invocation created the deal recently.
    // Skip HubSpot search (its index may still be lagging) and run
    // Refresh directly against the cached dealId.
    const response = await runRefresh(lockResult.dealId, deps);
    if (!response.ok) {
      return {
        ok: false,
        code: response.code,
        message: response.message,
        details: response.details,
      };
    }
    logPull("refreshed", oppId, lockResult.dealId);
    return {
      ok: true,
      action: "refreshed",
      dealId: lockResult.dealId,
      reason: "cache_hit",
    };
  }

  try {
    const outcome = await runPullLocked(oppId, event, deps);
    // Cache the dealId on success so subsequent invocations skip the
    // HubSpot search-index lag entirely. Only `created` / `refreshed`
    // outcomes carry a dealId.
    if (outcome.ok && outcome.dealId !== undefined) {
      await lockResult.release(outcome.dealId);
    }
    return outcome;
  } catch (err) {
    // Rethrow so the outer handler sees the failure. The lock row
    // will TTL out after the lease window (60s).
    throw err;
  }
}

/**
 * Body of the pull orchestration, executed under the per-opportunity
 * lock. Split out from `runPull` so the lock acquire/release wraps a
 * single try/finally and the orchestration logic stays linear.
 */
async function runPullLocked(
  oppId: string,
  event: AcePullEvent,
  deps: PullDeps
): Promise<PullOutcome> {
  const { ace, hs } = deps;

  // Look up the existing HubSpot deal. If found → Refresh; else → Create.
  let existingDealId: number | undefined;
  try {
    existingDealId = await hs.findDealByAceOpportunityId(oppId);
  } catch (err) {
    return {
      ok: false,
      code: ErrorCode.HUBSPOT_WRITE,
      message: `HubSpot search for opp ${oppId} failed: ${(err as Error).message}`,
    };
  }

  if (existingDealId !== undefined) {
    // Auto-refresh — same logic the user-driven Refresh button runs.
    const response = await runRefresh(existingDealId, deps);
    if (!response.ok) {
      return {
        ok: false,
        code: response.code,
        message: response.message,
        details: response.details,
      };
    }
    logPull("refreshed", oppId, existingDealId);
    return { ok: true, action: "refreshed", dealId: existingDealId };
  }

  // Auto-create — no HubSpot deal carries this id yet.
  let opp;
  try {
    opp = await ace.getOpportunity({
      Catalog: ACE_CATALOG,
      Identifier: oppId,
    } as never);
  } catch (err) {
    return {
      ok: false,
      code: ErrorCode.ACE_GET,
      message: `ACE GetOpportunity ${oppId} failed: ${(err as Error).message}`,
    };
  }

  // Pull the AWS summary (best-effort) so the snapshot picks up
  // InvolvementType / Visibility / Solutions just like Refresh does.
  let summary: unknown;
  try {
    summary = await ace.getAwsOpportunitySummary({
      Catalog: ACE_CATALOG,
      RelatedOpportunityIdentifier: oppId,
    } as never);
  } catch {
    summary = undefined;
  }

  const lifeCycle =
    (opp as { LifeCycle?: { Stage?: string; ReviewStatus?: string } })
      .LifeCycle ?? {};
  const status = resolveStatus(lifeCycle.ReviewStatus, lifeCycle.Stage);
  const snapshot = snapshotFromOpportunity(opp, status, summary);
  // No deal on file yet → pass `undefined` so `snapshotToProps` skips
  // the `closedate` / `amount` math that needs an existing deal.
  const props: Record<string, string> = {
    ...snapshotToProps(snapshot),
    ace_opportunity_id: oppId,
    ace_last_sync: new Date().toISOString(),
    ace_sync_error: "",
  };

  // Override snapshot-derived fields with sensible AWS-sourced
  // defaults that only make sense on Create.
  applyCreateOverrides(props, opp);

  let dealId: number;
  try {
    dealId = await hs.createDeal(props);
  } catch (err) {
    return {
      ok: false,
      code: ErrorCode.HUBSPOT_WRITE,
      message: `HubSpot deal create for opp ${oppId} failed: ${(err as Error).message}`,
    };
  }

  logPull("created", oppId, dealId);
  return { ok: true, action: "created", dealId };
}

/**
 * Decorate the property bag with fields that don't come from the
 * `snapshotFromOpportunity` view but are useful to seed on a freshly
 * created deal:
 *
 *   - `dealname` — fall back to AWS `Project.Title` → `Customer.Account.CompanyName`
 *     → "ACE <opportunityId>" so the rep sees something useful in the
 *     pipeline without having to open the deal.
 *   - `pipeline` — defaults to HubSpot's `default` pipeline. Operators
 *     who use a different pipeline should set the env override on the
 *     Lambda (HUBSPOT_PIPELINE_ID).
 *   - `dealstage` — left to `snapshotToProps` when it produces one
 *     (currently it doesn't; the caller picks the stage downstream).
 *     We set it here to `PULL_DEFAULT_STAGE` (env override; defaults
 *     to `appointmentscheduled`) when the snapshot didn't set one.
 */
function applyCreateOverrides(
  props: Record<string, string>,
  opp: unknown
): void {
  const proj =
    (opp as { Project?: { Title?: string } }).Project ?? {};
  const customer =
    (opp as { Customer?: { Account?: { CompanyName?: string } } }).Customer ??
    {};
  const account = customer.Account ?? {};
  const oppId =
    (opp as { Id?: string; OpportunityId?: string }).Id ??
    (opp as { Id?: string; OpportunityId?: string }).OpportunityId ??
    "";

  // dealname: snapshotToProps already wrote `dealname` from
  // `snapshot.awsProjectTitle` (which mirrors `Project.Title`).
  // Patch only when blank.
  if (!props.dealname || !props.dealname.trim()) {
    props.dealname = proj.Title || account.CompanyName || `ACE ${oppId}`;
  }

  const pipelineId = process.env.HUBSPOT_PIPELINE_ID ?? "default";
  props.pipeline = pipelineId;

  // Snapshot doesn't carry a HubSpot dealstage — only AWS stage. The
  // Refresh path leaves dealstage alone (HubSpot is the source of
  // truth on dealstage). For Create, we need a starting stage;
  // PULL_DEFAULT_STAGE lets the operator pick the entry stage that
  // matches their pipeline.
  if (!props.dealstage || !props.dealstage.trim()) {
    props.dealstage =
      process.env.PULL_DEFAULT_STAGE ?? "appointmentscheduled";
  }
}

/**
 * Single structured log line per pull invocation. Stays grep-able in
 * CloudWatch (`event:pull.*`) and never carries any payload data.
 */
function logPull(
  action: "created" | "refreshed",
  oppId: string,
  dealId: number
): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "pull",
      event: `pull.${action}`,
      oppId,
      dealId,
    })
  );
}

// `FunctionResponse` re-export so the handler can map outcomes back
// onto the existing error-code envelope without re-importing.
export type { FunctionResponse };
export { makeError };
