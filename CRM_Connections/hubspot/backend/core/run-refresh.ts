/**
 * Refresh orchestration (Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8).
 *
 * Orchestrates the read-only Refresh flow: pull the current ACE-side state
 * for an already-shared deal, translate it into the HubSpot status /
 * display model, and write the result back to the deal.
 *
 *   1.  Parse STAGE_MAPPING / STAGE_DISPLAY_NAMES from the injected config.
 *   2.  Read the deal. Require `ace_opportunity_id`; if absent the deal
 *       was never shared and the UI should show Share first.
 *   3.  `GetOpportunity` → capture `LifeCycle.Stage` + `ReviewStatus`,
 *       reverse-map to a HubSpot stage ID, and derive the user-facing
 *       stage label via `STAGE_DISPLAY_NAMES` (R4.2, R4.3).
 *   4.  `GetAwsOpportunitySummary` (best-effort) → `InvolvementType`,
 *       `Visibility`, `RelatedEntityIds.Solutions`,
 *       `LifeCycle.NextSteps`. The summary is unavailable during the
 *       AWS-acceptance window; failures are swallowed so the rest of
 *       the refresh proceeds.
 *   5.  `resolveStatus(reviewStatus, aceStage)` → `"Synced"` for the
 *       `ace_sync_status` health flag (the AWS-side state lives in
 *       `aws_review_status` / `aws_stage` mirror fields written from
 *       the same snapshot).
 *   6.  PATCH the full snapshot (every editable Project / Customer /
 *       LifeCycle field via `snapshotToProps`) plus
 *       `ace_sync_status`, `ace_last_sync`, `ace_sync_error=""`.
 *   7.  Return a typed `SuccessResponse` whose `message` narrates the
 *       stage label.
 *
 * ## Design choices
 *
 * **Not-shared-yet precondition.** There is no dedicated `NOT_SHARED`
 * code in `errors.ts`; reuse `PRECONDITION` because "must be shared
 * before refresh" is a precondition on the Refresh action, and the card
 * can treat the message text as the user-facing instruction ("Share
 * this deal first.").
 *
 * **APN CRM ID retired.** Earlier versions extracted an
 * `ApnCrmUniqueIdentifier` from `GetAwsOpportunitySummary` and wrote
 * it to `apn_crm_id` on the deal. AWS only assigns that identifier
 * after a formal acceptance step that the Sandbox catalog rarely
 * exercises, and this deployment doesn't need the field, so it was
 * removed. `resolveStatus` no longer takes the APN CRM ID argument.
 *
 * **Best-effort error write-back.** Any ACE failure writes
 * `ace_sync_status = "Sync Error"` + `ace_sync_error = "<step>: <msg>"`
 * back to the deal so the card renders the Error state on re-read
 * (R4.8). If that secondary write itself fails we swallow the error —
 * the primary ACE failure is already surfaced through the response
 * envelope.
 *
 * **Dependency injection.** `runRefresh(dealId, deps)` takes its
 * clients as arguments so unit tests can substitute literal object
 * mocks for the ACE and HubSpot wrappers without having to stub any
 * SDK constructors. The Lambda handler wrapper (`handlers/refresh.ts`)
 * wires real dependencies from Secrets Manager.
 */

import { ACE_CATALOG } from "../lib/config";
import type { AppConfig } from "../lib/config";
import {
  parseStageMapping,
  parseStageDisplayNames,
  reverseMap,
} from "../lib/stage-mapping";
import { resolveStatus } from "../lib/resolve-status";
import { ACEThrottledError, describeAceError } from "../lib/ace";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import { ErrorCode, makeError } from "../lib/errors";
import { snapshotFromOpportunity, snapshotToProps } from "./run-share";
import type {
  ErrorResponse,
  FunctionResponse,
  SuccessResponse,
} from "../lib/errors";

/**
 * Deal properties we read from HubSpot on every Refresh click. Only
 * `ace_opportunity_id` is strictly required by the flow; the rest are
 * included so the response envelope can echo current state back to the
 * UI for re-rendering without a second HubSpot round-trip.
 */
const DEAL_PROPERTY_NAMES = [
  "dealname",
  "ace_opportunity_id",
  "ace_sync_status",
  "ace_last_sync",
  "ace_sync_error",
  // Read the contract term so `snapshotToProps` can reverse the Share
  // path's monthly-spend math when writing AWS's ExpectedCustomerSpend
  // back into HubSpot's `amount` (which is the contract total, not
  // monthly).
  "contract_term__months_",
];

/** Current time as an ISO-8601 UTC string — format expected by `ace_last_sync`. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Dependencies injected into `runRefresh`. Mirrors the shape used by
 * `run-share.ts:ShareDeps` so tests can share fixture factories.
 */
export type RefreshDeps = {
  config: AppConfig;
  ace: AceClient;
  hs: HubspotClient;
};

/**
 * Main refresh orchestration, parameterised by its dependencies for
 * testability. The Lambda handler in `handlers/refresh.ts` constructs
 * the real dependencies and delegates to this function.
 */
export async function runRefresh(
  dealId: number,
  deps: RefreshDeps
): Promise<FunctionResponse> {
  const { config, ace, hs } = deps;

  // 1. Parse STAGE_MAPPING. Off-list ACE stages are a config error
  // (R9.4) — refuse to run Refresh against a misconfigured mapping so
  // the reverse-map never returns garbage.
  const { mapping, invalidEntries } = parseStageMapping(config.stageMappingRaw);
  if (invalidEntries.length > 0) {
    return makeError(
      ErrorCode.STAGE_UNMAPPABLE,
      undefined,
      `STAGE_MAPPING contains off-list ACE stages: ${invalidEntries.join(", ")}`,
      { invalidStageMappings: invalidEntries }
    );
  }

  // `STAGE_DISPLAY_NAMES` is optional (R9.2). An empty map falls back
  // to the HubSpot stage ID, then the raw ACE stage, per R4.3.
  const displayNames = parseStageDisplayNames(config.stageDisplayNamesRaw);

  // 2. Read the deal. Surface a HubSpot-IO failure as HUBSPOT_WRITE
  // (the code covers the whole HubSpot-IO failure class in errors.ts).
  let deal;
  try {
    deal = await hs.readDealProperties(dealId, DEAL_PROPERTY_NAMES);
  } catch (err) {
    return makeError(
      ErrorCode.HUBSPOT_WRITE,
      "readDeal",
      `Failed to read deal ${dealId} from HubSpot: ${(err as Error).message}`
    );
  }

  // Require `ace_opportunity_id`. An unshared deal cannot be refreshed —
  // point the user at the Share button instead.
  const aceOppId = deal.ace_opportunity_id?.trim();
  if (!aceOppId) {
    return makeError(
      ErrorCode.PRECONDITION,
      undefined,
      "This deal has not been shared yet. Click Share first."
    );
  }

  // 3. GetOpportunity → stage + review status.
  let opp;
  try {
    opp = await ace.getOpportunity({
      Catalog: ACE_CATALOG,
      Identifier: aceOppId,
    } as never);
  } catch (err) {
    return aceFailure("GetOpportunity", ErrorCode.ACE_GET, err, dealId, hs);
  }
  const lifeCycle = (
    opp as {
      LifeCycle?: { Stage?: string; ReviewStatus?: string };
    }
  ).LifeCycle;
  const aceStage = lifeCycle?.Stage ?? "";
  const reviewStatus = lifeCycle?.ReviewStatus;

  // Derive the user-facing stage label. Priority (R4.2, R4.3):
  //   STAGE_DISPLAY_NAMES[hs_stage_id]  (preferred)
  //   hs_stage_id                        (if no display name entry)
  //   ace_stage                          (if no reverse mapping at all)
  const hsStageId = reverseMap(aceStage, mapping);
  const stageLabel =
    (hsStageId !== undefined ? displayNames[hsStageId] : undefined) ??
    hsStageId ??
    aceStage;

  // 4. GetAwsOpportunitySummary (best-effort) — used only to surface
  // InvolvementType / Visibility / Solutions / NextSteps in the
  // snapshot. Failures are swallowed because the summary is
  // unavailable during the AWS-acceptance window.
  let summary: unknown;
  try {
    summary = await ace.getAwsOpportunitySummary({
      Catalog: ACE_CATALOG,
      RelatedOpportunityIdentifier: aceOppId,
    } as never);
  } catch {
    summary = undefined;
  }

  // 5. Resolve the HubSpot `ace_sync_status` enum value. The HubSpot
  // property is a closed enum (see `lib/resolve-status.ts`); we map the
  // richer ACE state into one of the documented values.
  const status = resolveStatus(reviewStatus, aceStage);

  // 6. Build the property write — `snapshotToProps` produces the
  // same map the Share flow writes, keeping the two flows
  // consistent. Pass `deal` so the helper can reverse the
  // monthly-spend math (AWS holds monthly, HubSpot.amount holds
  // the contract total).
  const lastSync = nowIso();
  const snapshot = snapshotFromOpportunity(opp, status, summary);
  const propsToWrite: Record<string, string> = {
    ...snapshotToProps(snapshot, deal),
    ace_last_sync: lastSync,
    ace_sync_error: "",
  };

  try {
    await hs.writeDealProperties(dealId, propsToWrite);
  } catch (err) {
    return makeError(
      ErrorCode.HUBSPOT_WRITE,
      "writeDealProperties",
      `Refresh succeeded against ACE, but writing back to HubSpot failed: ${(err as Error).message}. Click Refresh again to reconcile.`
    );
  }

  // 7. Build the user-visible success message (R6.4). The message
  // surfaces what AWS THINKS of the opportunity (raw ReviewStatus),
  // not the sync-health enum — those are now separate concepts.
  const message = buildMessage(stageLabel, reviewStatus, aceStage);

  const response: SuccessResponse = {
    ok: true,
    message,
    properties: {
      ace_opportunity_id: aceOppId,
      ...snapshotToProps(snapshot, deal),
      ace_last_sync: lastSync,
      ace_sync_error: "",
    },
  };
  return response;
}

/**
 * Build the user-facing message displayed by the Custom Card on a
 * successful Refresh (R6.4). Three shapes:
 *
 *   - Rejected               → `"Refreshed — stage <Label> (Rejected)"`
 *   - Closed Lost            → `"Refreshed — stage <Label> (Closed Lost)"`
 *   - otherwise              → `"Refreshed — stage <Label>, <ReviewStatus>"`
 *
 * `reviewStatus` is the raw `LifeCycle.ReviewStatus` from AWS — the
 * same value that lands in the deal's `aws_review_status` mirror
 * field. When AWS hasn't returned a review status yet (engagement
 * still pending), the message falls back to just the stage label.
 */
function buildMessage(
  stageLabel: string,
  reviewStatus: string | undefined,
  aceStage: string
): string {
  const trimmed = reviewStatus?.trim();
  if (trimmed === "Rejected") {
    return `Refreshed — stage ${stageLabel} (Rejected)`;
  }
  if (aceStage === "Closed Lost") {
    return `Refreshed — stage ${stageLabel} (Closed Lost)`;
  }
  if (trimmed) {
    return `Refreshed — stage ${stageLabel}, ${trimmed}`;
  }
  return `Refreshed — stage ${stageLabel}`;
}

/**
 * Shared error-handling tail for any ACE failure on the Refresh path:
 * promote `ACEThrottledError` to `ACE_THROTTLED`, attempt to write a
 * `Sync Error` status back to HubSpot (swallowing secondary failures,
 * R4.8), and return a fully-formed `ErrorResponse`.
 */
async function aceFailure(
  step: string,
  code: ErrorCode,
  err: unknown,
  dealId: number,
  hs: HubspotClient
): Promise<ErrorResponse> {
  const isThrottled = err instanceof ACEThrottledError;
  const outCode = isThrottled ? ErrorCode.ACE_THROTTLED : code;
  const msg = describeAceError(err);
  try {
    await hs.writeDealProperties(dealId, {
      ace_sync_status: "Sync Error",
      ace_sync_error: `${step}: ${msg}`,
      ace_last_sync: nowIso(),
    });
  } catch {
    // Swallow — the user sees the primary ACE error in the card
    // alert; the next Refresh / EventBridge auto-pull will
    // re-attempt the write-back.
  }
  return makeError(outCode, step, `${step} failed: ${msg}`);
}
