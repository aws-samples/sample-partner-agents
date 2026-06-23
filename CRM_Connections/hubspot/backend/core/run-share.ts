/**
 * Share orchestration (Requirements 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1,
 * 3.2, 3.3, 3.4, 3.5, 3.6, 10.1, 10.2, 11.2, 11.3).
 *
 * Orchestrates the create and update paths for a single Share button click.
 *
 *   1. Parse STAGE_MAPPING from the injected config.
 *   2. Read the deal and its primary associated company.
 *   3. Validate preconditions (R2.2).
 *   4. Branch on `deal.ace_opportunity_id`:
 *        - present → UpdateOpportunity with LastModifiedDate, with a single
 *          `GetOpportunity` → fresh `UpdateOpportunity` retry on stale
 *          `LastModifiedDate` (R11.2). A second conflict surfaces as
 *          STALE_OPPORTUNITY (R11.3). The deal's `ace_solutions` field is
 *          then reconciled against AWS's current `RelatedEntityIdentifiers.Solutions`
 *          via attach-then-detach.
 *        - absent  → CreateOpportunity, write `ace_opportunity_id` to
 *          HubSpot, then for each `;`-separated value of the deal's
 *          `ace_solutions` field run `AssociateOpportunity` (with a 1000ms
 *          inter-write delay), then `StartEngagementFromOpportunityTask`
 *          (R10.1, R10.2).
 *   5. Return a typed `SuccessResponse` or `ErrorResponse` envelope.
 *
 * ## Design choices
 *
 * **Dependency injection.** `runShare(dealId, deps)` takes its clients as
 * arguments so unit tests can substitute literal object mocks for the ACE
 * and HubSpot wrappers without having to stub `process.env` or the SDK
 * constructors. The Lambda handler wrapper (`handlers/share.ts`) wires real
 * dependencies from Secrets Manager + the real SDK clients.
 *
 * **Three-step create → single ACE_CREATE code.** The design document
 * originally sketched three distinct error codes
 * (`ACE_CREATE` / `ACE_ASSOCIATE` / `ACE_ENGAGE`). tasks.md's `errors.ts`
 * enum collapsed that to a single `ACE_CREATE` code; we preserve the
 * step-level debugging information by putting the failing step name
 * (`CreateOpportunity` / `AssociateOpportunity` / `StartEngagement`) in
 * `details.step`.
 *
 * **Best-effort error write-back.** Whenever an ACE call fails we try to
 * write `ace_sync_status = "Sync Error"` + `ace_sync_error = "<step>: <msg>"`
 * back to the deal so the card can render the Error state on re-read. If
 * that write itself fails we swallow the secondary error — the user still
 * sees the primary ACE failure through the card alert, and the next
 * Refresh / EventBridge auto-pull will reconcile on its next run.
 *
 * **ClientToken scope.** `generateClientToken(dealId)` is used at both the
 * `CreateOpportunity` step (via `buildCreatePayload`) and the
 * `StartEngagementFromOpportunityTask` step. The same deterministic token
 * is valid as an idempotency key for both calls: ACE keys idempotency per
 * (operation, token), not per operation alone. Re-running the flow for the
 * same deal therefore no-ops at both steps.
 */

import { ACE_CATALOG } from "../lib/config";
import type { AppConfig } from "../lib/config";
import { randomUUID } from "node:crypto";
import { parseStageMapping } from "../lib/stage-mapping";
import type { StageMapping } from "../lib/stage-mapping";
import { validatePreconditions, parseSolutionIds, parseAwsProductIds } from "../lib/preconditions";
import type { CompanyProps, DealProps } from "../lib/preconditions";
import { buildCreatePayload, buildUpdatePayload } from "../lib/payload";
import { generateClientToken, generateEngagementClientToken } from "../lib/client-token";
import { classifySubmissionMode } from "../lib/submission-mode";
import { ACEThrottledError } from "../lib/ace";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import { ErrorCode, makeError } from "../lib/errors";
import { resolveStatus } from "../lib/resolve-status";
import type { SyncStatus } from "../lib/resolve-status";
import type {
  ErrorResponse,
  FunctionResponse,
  SuccessResponse,
} from "../lib/errors";

/** Inter-write delay between the three ACE create-flow steps (R10.1, R10.2). */
const WRITE_DELAY_MS = 1000;

/**
 * Deal properties we read from HubSpot on every Share click. The payload
 * builder and precondition validator consume a subset of these; we request
 * them all in a single round-trip.
 */
const DEAL_PROPERTY_NAMES = [
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "contract_term__months_",
  "description",
  "ace_customer_use_case",
  "ace_marketing_source",
  "ace_industry",
  "ace_opportunity_type",
  "ace_primary_need_from_aws",
  "ace_delivery_model",
  "ace_sales_activities",
  "ace_currency_code",
  "ace_aws_funding_used",
  "ace_involvement_type",
  "ace_visibility",
  "ace_national_security",
  "hs_next_step",
  "ace_additional_comments",
  "ace_competitor_name",
  "ace_other_competitor_names",
  "ace_other_solution_description",
  "ace_apn_programs",
  "ace_aws_partition",
  "ace_closed_lost_reason",
  "ace_aws_account_id",
  "ace_duns",
  "ace_street_address",
  "ace_solutions",
  "ace_aws_products",
  "ace_opportunity_id",
  "ace_sync_status",
  "ace_last_sync",
  "ace_sync_error",
  // Deal-level mirrors of company-sourced Customer.Account.* fields.
  // The deal's primary associated company is still the canonical
  // source — when populated, its value wins (HubSpot is the system
  // of record for company data). These deal-level fields are the
  // fallback for two cases:
  //   (a) Deals reverse-synced from AWS via EventBridge that have no
  //       associated HubSpot company yet but already carry the
  //       customer info from the AWS opportunity payload.
  //   (b) Operators who maintain customer info per-deal rather than
  //       per-company (rare, but supported).
  // A HubSpot workflow on the operator side can copy these from the
  // associated company on association — see hubspot-card/README.md.
  "ace_company_name",
  "ace_country_code",
  "ace_postal_code",
  "ace_state_or_region",
  "ace_city",
  "ace_website_url",
  // Marketing.* sub-fields surfaced when ace_marketing_source = "Yes"
  // (i.e. Marketing.Source = "Marketing Activity"). All optional;
  // sent as Marketing.{CampaignName,UseCases[],Channels[]}.
  "ace_marketing_campaign_name",
  "ace_marketing_use_cases",
  "ace_marketing_channels",
];

/** Await-able sleep for the inter-write delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Current time as an ISO-8601 UTC string — format expected by `ace_last_sync`. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Emit a single JSON line per orchestration step so CloudWatch shows the
 * sequence Create → Associate → StartEngagement → finalize. Secrets and
 * payloads are NEVER logged — just the step name, dealId, oppId, and
 * outcome marker. Useful for diagnosing partial-failure cases where the
 * Lambda exits cleanly but ACE side-effects didn't all land.
 */
function logStep(
  step: string,
  outcome: "begin" | "ok" | "skip",
  dealId: number,
  extra: Record<string, string | number | undefined> = {}
): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "share",
      event: `share.step.${step}.${outcome}`,
      dealId,
      ...extra,
    })
  );
}

/**
 * Snapshot of the ACE-side state we surface to HubSpot at the end of a
 * Share. `syncStatus` is the closed-enum value used for card-state
 * rendering; the remaining fields carry the raw ACE state and are
 * written to free-text mirror properties so HubSpot users see exactly
 * what AWS thinks of the opportunity.
 *
 * Each mirror field is either a string (single-value) or a `;`-joined
 * string (multi-value, matching HubSpot's checkbox serialisation).
 *
 * Exported so the Refresh flow can build the same shape and produce
 * the same set of `aws_*` writes.
 */
export type AceSnapshot = {
  syncStatus: SyncStatus;
  awsReviewStatus: string;
  awsStage: string;
  awsNextSteps: string;
  /**
   * `LifeCycle.TargetCloseDate` from AWS as a `YYYY-MM-DD` string.
   * Empty when AWS has no close date set.
   */
  awsTargetCloseDate: string;
  /**
   * `Project.ExpectedCustomerSpend[0].Amount` from AWS — MONTHLY revenue.
   * Empty when no spend is set. The Refresh path multiplies this by the
   * deal's contract term (months) to compute HubSpot's `amount` (which is
   * the total contract value, not monthly).
   */
  awsExpectedMonthlyAmount: string;
  // Project mirrors
  awsProjectTitle: string;
  awsCustomerBusinessProblem: string;
  awsAdditionalComments: string;
  awsCompetitorName: string;
  awsOtherCompetitorNames: string;
  awsOtherSolutionDescription: string;
  awsApnPrograms: string;
  awsAwsPartition: string;
  awsCustomerUseCase: string;
  awsDeliveryModels: string;
  /**
   * `Project.SalesActivities` from AWS — `;`-joined HubSpot
   * multi-select shape. ACE accepts a closed enum with 8 values
   * ranging from "Initialized discussions with customer" to
   * "SOW Signed"; the Share path currently picks a stage-default
   * subset (`STAGE_TO_SALES_ACTIVITIES`) but can also accept a
   * per-deal override via the new `ace_sales_activities`
   * multi-select picklist.
   */
  awsSalesActivities: string;
  awsCurrencyCode: string;
  awsPrimaryNeedFromAws: string;
  awsOpportunityType: string;
  // Marketing mirrors
  awsMarketingSource: string;
  awsAwsFundingUsed: string;
  /**
   * `Marketing.CampaignName` — set only when the partner ran a
   * tagged marketing activity. Empty when AWS doesn't have a
   * campaign name. Round-trips back to `ace_marketing_campaign_name`.
   */
  awsMarketingCampaignName: string;
  /**
   * `Marketing.UseCases` — `;`-joined for HubSpot's multi-select.
   * Round-trips to `ace_marketing_use_cases`.
   */
  awsMarketingUseCases: string;
  /**
   * `Marketing.Channels` — `;`-joined for HubSpot's multi-select.
   * Round-trips to `ace_marketing_channels`.
   */
  awsMarketingChannels: string;
  awsNationalSecurity: string;
  // LifeCycle mirrors
  awsClosedLostReason: string;
  awsReviewComments: string;
  awsReviewStatusReason: string;
  // Customer mirrors
  awsCompanyName: string;
  awsIndustry: string;
  awsAwsAccountId: string;
  awsDuns: string;
  awsWebsiteUrl: string;
  awsCity: string;
  awsStateOrRegion: string;
  awsPostalCode: string;
  awsStreetAddress: string;
  awsCountryCode: string;
  /**
   * `;`-joined list of solution identifiers from
   * `RelatedEntityIdentifiers.Solutions`. AWS holds this as an array;
   * HubSpot stores the multi-select as a `;`-separated string.
   */
  awsSolutions: string;
  /**
   * `;`-joined list of AWS Product Codes from
   * `RelatedEntityIdentifiers.AwsProducts`. Same model as
   * `awsSolutions` — AWS array → HubSpot `;`-separated multi-select.
   * Round-trips to `ace_aws_products` on the deal.
   */
  awsAwsProducts: string;
  /**
   * `InvolvementType` from the AwsOpportunitySummary endpoint. Empty
   * when the summary is unavailable (the AWS-acceptance window before
   * AWS has reviewed the opportunity).
   */
  awsInvolvementType: string;
  /**
   * `Visibility` from the AwsOpportunitySummary endpoint. Empty when
   * the summary is unavailable.
   */
  awsVisibility: string;

  /**
   * AWS-assigned reviewers for this opportunity, sourced from
   * `AwsOpportunitySummary.OpportunityTeam[]` and keyed by the role's
   * `BusinessTitle` (`AWSAccountOwner` / `AWSSalesRep` / `PSM` / `PDM`).
   * Each role surfaces as `"<first> <last> (<email>)"` (or just the
   * name when no email is on the record). Empty string when AWS hasn't
   * assigned that role yet — typical during the acceptance window.
   *
   * Mirror of the Python batch's `_reverse_sync_aws_contacts` so a
   * Refresh click / EventBridge auto-pull populates the same four
   * deal properties without waiting for the next batch run.
   */
  awsAccountManager: string;
  awsAccountManagerEmail: string;
  awsSalesRep: string;
  awsSalesRepEmail: string;
  awsPartnerSalesManager: string;
  awsPartnerDevelopmentManager: string;
};

/**
 * Empty snapshot used when GetOpportunity fails. All mirror fields are
 * empty strings so the subsequent HubSpot write doesn't accidentally
 * blank out previously-mirrored values (HubSpot interprets empty
 * string as "leave property unchanged" only when the field is absent
 * — for present empty strings the field is set to empty). We choose
 * the safer "let Refresh reconcile later" path on the rare case
 * GetOpportunity itself fails after a successful create/update.
 */
const EMPTY_SNAPSHOT: AceSnapshot = {
  syncStatus: "Synced",
  awsReviewStatus: "",
  awsStage: "",
  awsNextSteps: "",
  awsTargetCloseDate: "",
  awsExpectedMonthlyAmount: "",
  awsProjectTitle: "",
  awsCustomerBusinessProblem: "",
  awsAdditionalComments: "",
  awsCompetitorName: "",
  awsOtherCompetitorNames: "",
  awsOtherSolutionDescription: "",
  awsApnPrograms: "",
  awsAwsPartition: "",
  awsCustomerUseCase: "",
  awsDeliveryModels: "",
  awsSalesActivities: "",
  awsCurrencyCode: "",
  awsPrimaryNeedFromAws: "",
  awsOpportunityType: "",
  awsMarketingSource: "",
  awsAwsFundingUsed: "",
  awsMarketingCampaignName: "",
  awsMarketingUseCases: "",
  awsMarketingChannels: "",
  awsNationalSecurity: "",
  awsClosedLostReason: "",
  awsReviewComments: "",
  awsReviewStatusReason: "",
  awsCompanyName: "",
  awsIndustry: "",
  awsAwsAccountId: "",
  awsDuns: "",
  awsWebsiteUrl: "",
  awsCity: "",
  awsStateOrRegion: "",
  awsPostalCode: "",
  awsStreetAddress: "",
  awsCountryCode: "",
  awsSolutions: "",
  awsAwsProducts: "",
  awsInvolvementType: "",
  awsVisibility: "",
  awsAccountManager: "",
  awsAccountManagerEmail: "",
  awsSalesRep: "",
  awsSalesRepEmail: "",
  awsPartnerSalesManager: "",
  awsPartnerDevelopmentManager: "",
};

/** Join an array of strings with `;` for HubSpot multi-select serialisation. */
function joinMulti(arr: string[] | undefined): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((v) => v?.trim?.() ?? "")
    .filter((v) => v.length > 0)
    .join(";");
}

/** Trim a string-ish value defensively, returning "" for missing / non-string. */
function trimStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Translate ACE's `Marketing.Source` wire value back to the
 * operator-friendly Yes/No surface used by `ace_marketing_source` in
 * HubSpot. Mirror of `translateMarketingSource` in `lib/payload.ts`.
 *
 * `"Marketing Activity"` → `"Yes"`
 * `"None"` → `"No"`
 * empty / unknown → empty string (don't clobber the deal field with garbage)
 */
function reverseMarketingSource(raw: string): string {
  if (raw === "Marketing Activity") return "Yes";
  if (raw === "None") return "No";
  return raw;
}

/**
 * Build an `AceSnapshot` from a GetOpportunity response. Walks the
 * full Project / Customer / LifeCycle subtrees so every editable
 * field flows back to its HubSpot mirror property.
 *
 * `summary` is the optional `GetAwsOpportunitySummary` response. When
 * provided, we surface `InvolvementType`, `Visibility`, and
 * `RelatedEntityIds.Solutions` from it — those fields are NOT on the
 * `GetOpportunity` response and would otherwise never round-trip back
 * to HubSpot. The Refresh path always passes the summary because it
 * already fetches it for the APN CRM ID.
 *
 * Exported because `core/run-refresh.ts` reuses it on the Refresh
 * path — the snapshot shape is the same in both directions.
 */
export function snapshotFromOpportunity(
  opp: unknown,
  syncStatus: SyncStatus,
  summary?: unknown
): AceSnapshot {
  const o = (opp ?? {}) as Record<string, unknown>;
  const lifeCycle = (o.LifeCycle ?? {}) as Record<string, unknown>;
  const project = (o.Project ?? {}) as Record<string, unknown>;
  const customer = (o.Customer ?? {}) as Record<string, unknown>;
  const account = (customer.Account ?? {}) as Record<string, unknown>;
  const address = (account.Address ?? {}) as Record<string, unknown>;
  const marketing = (o.Marketing ?? {}) as Record<string, unknown>;
  const spendList = (project.ExpectedCustomerSpend ?? []) as Array<
    Record<string, unknown>
  >;
  const firstSpend = spendList[0] ?? {};
  // Prefer Solutions from the GetOpportunity response; fall back to
  // the summary when available. Operators sometimes change the
  // associated solutions via Partner Central UI between Share/Refresh
  // cycles.
  const oppRelated = (o.RelatedEntityIdentifiers ?? {}) as Record<
    string,
    unknown
  >;
  const sum = (summary ?? {}) as Record<string, unknown>;
  const sumRelated = (sum.RelatedEntityIds ?? {}) as Record<string, unknown>;
  const sumLifeCycle = (sum.LifeCycle ?? {}) as Record<string, unknown>;
  const solutions =
    (oppRelated.Solutions as string[] | undefined) ??
    (sumRelated.Solutions as string[] | undefined) ??
    undefined;
  // AWS Products are also stored on the opp's RelatedEntityIdentifiers
  // (and on the AwsOpportunitySummary as RelatedEntityIds.AwsProducts).
  // Same precedence as Solutions: opp wins, summary as fallback.
  const awsProducts =
    (oppRelated.AwsProducts as string[] | undefined) ??
    (sumRelated.AwsProducts as string[] | undefined) ??
    undefined;
  // NextSteps: prefer the GetOpportunity value (the editable
  // partner-side LifeCycle.NextSteps that both Share and the agent
  // write to). The summary's NextSteps is the AWS-reviewer-authored
  // annotation — useful when the partner-side value is empty (e.g.
  // pre-agent-update flows where AWS set it during review), but
  // it lags edits made through the agent. So opp wins; summary is
  // the fallback.
  const nextStepsFromSummary = trimStr(sumLifeCycle.NextSteps);
  const nextStepsFromOpp = trimStr(lifeCycle.NextSteps);
  const nextSteps =
    nextStepsFromOpp.length > 0 ? nextStepsFromOpp : nextStepsFromSummary;
  return {
    syncStatus,
    awsReviewStatus: trimStr(lifeCycle.ReviewStatus),
    awsStage: trimStr(lifeCycle.Stage),
    awsNextSteps: nextSteps,
    awsTargetCloseDate: trimStr(lifeCycle.TargetCloseDate),
    awsExpectedMonthlyAmount: trimStr(firstSpend.Amount),
    awsClosedLostReason: trimStr(lifeCycle.ClosedLostReason),
    awsReviewComments: trimStr(lifeCycle.ReviewComments),
    awsReviewStatusReason: trimStr(lifeCycle.ReviewStatusReason),
    awsProjectTitle: trimStr(project.Title),
    awsCustomerBusinessProblem: trimStr(project.CustomerBusinessProblem),
    awsAdditionalComments: trimStr(project.AdditionalComments),
    awsCompetitorName: trimStr(project.CompetitorName),
    awsOtherCompetitorNames: trimStr(project.OtherCompetitorNames),
    awsOtherSolutionDescription: trimStr(project.OtherSolutionDescription),
    awsApnPrograms: joinMulti(project.ApnPrograms as string[] | undefined),
    awsAwsPartition: trimStr(project.AwsPartition),
    awsCustomerUseCase: trimStr(project.CustomerUseCase),
    awsDeliveryModels: joinMulti(project.DeliveryModels as string[] | undefined),
    awsSalesActivities: joinMulti(project.SalesActivities as string[] | undefined),
    awsCurrencyCode: trimStr(firstSpend.CurrencyCode),
    awsPrimaryNeedFromAws: joinMulti(o.PrimaryNeedsFromAws as string[] | undefined),
    awsOpportunityType: trimStr(o.OpportunityType),
    awsMarketingSource: reverseMarketingSource(trimStr(marketing.Source)),
    awsAwsFundingUsed: trimStr(marketing.AwsFundingUsed),
    awsMarketingCampaignName: trimStr(marketing.CampaignName),
    awsMarketingUseCases: joinMulti(marketing.UseCases as string[] | undefined),
    awsMarketingChannels: joinMulti(marketing.Channels as string[] | undefined),
    awsNationalSecurity: trimStr(o.NationalSecurity),
    awsCompanyName: trimStr(account.CompanyName),
    awsIndustry: trimStr(account.Industry),
    awsAwsAccountId: trimStr(account.AwsAccountId),
    awsDuns: trimStr(account.Duns),
    awsWebsiteUrl: trimStr(account.WebsiteUrl),
    awsCity: trimStr(address.City),
    awsStateOrRegion: trimStr(address.StateOrRegion),
    awsPostalCode: trimStr(address.PostalCode),
    awsStreetAddress: trimStr(address.StreetAddress),
    awsCountryCode: trimStr(address.CountryCode),
    awsSolutions: joinMulti(solutions),
    awsAwsProducts: joinMulti(awsProducts),
    awsInvolvementType: trimStr(sum.InvolvementType),
    awsVisibility: trimStr(sum.Visibility),
    // OpportunityTeam can live on EITHER the GetOpportunity response or
    // the AwsOpportunitySummary depending on the catalog and lifecycle
    // state. Live observation (May 2026, Sandbox catalog): the summary
    // returns `OpportunityTeam: []` while `GetOpportunity` carries the
    // populated array. Prefer summary when it has entries (matches the
    // documented shape), fall back to the opp-level array.
    ...extractAwsTeam(
      pickPopulatedTeam(
        sum.OpportunityTeam as unknown[] | undefined,
        o.OpportunityTeam as unknown[] | undefined
      )
    ),
  };
}

/**
 * Choose whichever `OpportunityTeam` array is populated. The two
 * sources can disagree (summary returns `[]` while GetOpportunity
 * carries the assignments), so prefer non-empty over empty rather
 * than blindly trusting one source.
 */
function pickPopulatedTeam(
  fromSummary: unknown[] | undefined,
  fromOpp: unknown[] | undefined
): unknown[] | undefined {
  if (Array.isArray(fromSummary) && fromSummary.length > 0) return fromSummary;
  if (Array.isArray(fromOpp) && fromOpp.length > 0) return fromOpp;
  return fromSummary ?? fromOpp;
}

/**
 * Pull the AWS-assigned reviewers off the AwsOpportunitySummary's
 * `OpportunityTeam[]`. Each entry's `BusinessTitle` (one of
 * `AWSAccountOwner` / `AWSSalesRep` / `PSM` / `PDM` / `ISVSM` /
 * `WWPSPDM`) determines which HubSpot mirror property the entry feeds.
 *
 * Display format mirrors the Python batch's `_reverse_sync_aws_contacts`:
 *   `"<First> <Last> (<email>)"`, falling back to just the name when
 *   no email is on the record. Empty strings for any role AWS hasn't
 *   assigned yet — typical during the post-share acceptance window.
 */
function extractAwsTeam(team: unknown[] | undefined): {
  awsAccountManager: string;
  awsAccountManagerEmail: string;
  awsSalesRep: string;
  awsSalesRepEmail: string;
  awsPartnerSalesManager: string;
  awsPartnerDevelopmentManager: string;
} {
  const out = {
    awsAccountManager: "",
    awsAccountManagerEmail: "",
    awsSalesRep: "",
    awsSalesRepEmail: "",
    awsPartnerSalesManager: "",
    awsPartnerDevelopmentManager: "",
  };
  if (!Array.isArray(team)) return out;

  for (const member of team) {
    if (member === null || typeof member !== "object") continue;
    const m = member as {
      BusinessTitle?: string;
      FirstName?: string;
      LastName?: string;
      Email?: string;
    };
    const role = (m.BusinessTitle ?? "").trim();
    const first = (m.FirstName ?? "").trim();
    const last = (m.LastName ?? "").trim();
    const email = (m.Email ?? "").trim();
    const display = email
      ? `${`${first} ${last}`.trim()} (${email})`.trim()
      : `${first} ${last}`.trim();
    if (!display) continue;

    switch (role) {
      case "AWSAccountOwner":
      case "OpportunityOwner":
        // `OpportunityOwner` is what AWS uses on the live wire when
        // the AWS-side rep is the opportunity's owner of record.
        // `AWSAccountOwner` is the documented value. Both feed the
        // partner's "AWS Account Manager" surface.
        out.awsAccountManager = display;
        out.awsAccountManagerEmail = email;
        break;
      case "AWSSalesRep":
        out.awsSalesRep = display;
        out.awsSalesRepEmail = email;
        break;
      case "PSM":
      case "WWPSPDM":
      case "PartnerAccountManager":
        // PSM is the standard Partner Sales Manager title;
        // WWPSPDM is the public-sector flavour; PartnerAccountManager
        // is what shows up on the Partner Central UI for the
        // partner-side rep tied to this opp. All three feed the
        // partner's "Partner Sales Manager" mirror.
        out.awsPartnerSalesManager = display;
        break;
      case "PDM":
      case "ISVSM":
        // ISVSM (ISV Success Manager) covers the same partner-side
        // role as PDM for ISV partners; collapse for HubSpot.
        out.awsPartnerDevelopmentManager = display;
        break;
      // Other AWS roles (e.g. legacy values) are intentionally
      // ignored — the partner only cares about the four
      // primary contact roles.
    }
  }
  return out;
}

/**
 * Convert an `AceSnapshot` to the HubSpot deal-property write map.
 *
 * Bidirectional model: every editable ACE field has a SINGLE HubSpot
 * deal property (the `ace_*` field). Share writes the operator's value
 * to AWS; Refresh writes AWS's current value back to the SAME field.
 * The "last writer wins" — whichever direction ran most recently is
 * what the deal reflects.
 *
 * Exceptions to the single-field rule (kept as `aws_*` because there
 * is no operator-controlled equivalent):
 *   - `aws_review_status`        — `LifeCycle.ReviewStatus` (state machine)
 *   - `aws_stage`                — `LifeCycle.Stage` (distinct from
 *                                   HubSpot `dealstage`, which maps
 *                                   indirectly via `STAGE_MAPPING`)
 *   - `aws_review_comments`      — AWS reviewer feedback (read-only)
 *   - `aws_review_status_reason` — AWS reviewer feedback (read-only)
 *
 * Customer / company fields (CompanyName, Industry, WebsiteUrl,
 * Address.*) are sourced from the HubSpot company association, NOT
 * the deal — so they're never written back here. The exceptions
 * surfaced as deal-level overrides (`ace_industry`,
 * `ace_aws_account_id`, `ace_duns`, `ace_street_address`) DO get
 * round-tripped because they live on the deal in HubSpot.
 *
 * Exported for use from `core/run-refresh.ts` so Share and Refresh
 * write the exact same set of HubSpot fields.
 */
export type SnapshotProps = {
  ace_sync_status: SyncStatus;
  // Pure AWS-side state — no operator-controlled equivalent.
  aws_review_status: string;
  aws_stage: string;
  aws_review_comments: string;
  aws_review_status_reason: string;
  // Editable ACE fields — round-tripped to the same `ace_*` HubSpot
  // property the operator edits.
  hs_next_step: string;
  dealname: string;
  description: string;
  ace_additional_comments: string;
  ace_competitor_name: string;
  ace_other_competitor_names: string;
  ace_other_solution_description: string;
  ace_apn_programs: string;
  ace_aws_partition: string;
  ace_customer_use_case: string;
  ace_delivery_model: string;
  ace_sales_activities: string;
  ace_currency_code: string;
  ace_primary_need_from_aws: string;
  ace_opportunity_type: string;
  ace_marketing_source: string;
  ace_aws_funding_used: string;
  /**
   * `Marketing.CampaignName` round-trip. Empty when AWS has none —
   * the partner can populate this on the deal and it's sent on the
   * next Share when `ace_marketing_source = "Yes"`.
   */
  ace_marketing_campaign_name: string;
  /**
   * `Marketing.UseCases` round-trip — `;`-joined HubSpot multi-select.
   */
  ace_marketing_use_cases: string;
  /**
   * `Marketing.Channels` round-trip — `;`-joined HubSpot multi-select.
   */
  ace_marketing_channels: string;
  ace_national_security: string;
  ace_closed_lost_reason: string;
  ace_industry: string;
  ace_aws_account_id: string;
  ace_duns: string;
  ace_street_address: string;
  /**
   * Deal-level mirrors of `Customer.Account.*` fields. The Share
   * path uses these as fallbacks when the deal has no associated
   * HubSpot company; Refresh writes them so reverse-synced deals
   * carry the customer info on the deal directly. Empty when AWS
   * doesn't have the field.
   */
  ace_company_name: string;
  ace_country_code: string;
  ace_postal_code: string;
  ace_state_or_region: string;
  ace_city: string;
  ace_website_url: string;
  /**
   * AWSSubmission.InvolvementType from the Engagement task. Surfaced
   * as `ace_involvement_type` so Share's AwsSubmission and Refresh's
   * mirror agree on a single property.
   */
  ace_involvement_type: string;
  /**
   * AWSSubmission.Visibility from the Engagement task. Same model as
   * `ace_involvement_type`.
   */
  ace_visibility: string;
  /**
   * `RelatedEntityIdentifiers.Solutions` — `;`-joined array of
   * Partner Central Solution Offering IDs (e.g. `S-XXXXXXX`). The
   * field is HubSpot-side authoritative on Share: every
   * `;`-separated value becomes an `AssociateOpportunity` call on
   * the create path, and on the update path the diff between the
   * deal's value and AWS's current associations is reconciled
   * (attach-then-detach). Refresh writes the live AWS value back so
   * external Partner-Central edits surface in HubSpot.
   */
  ace_solutions: string;
  /**
   * `RelatedEntityIdentifiers.AwsProducts` — `;`-joined list of
   * AWS Product Codes (e.g. `AmazonEC2P5;S3IntelligentTiering`).
   * Same model as `ace_solutions`: HubSpot-side authoritative on
   * Share, AWS-side authoritative on Refresh, last-writer-wins.
   * Optional from AWS's perspective — opps can ship with zero
   * products.
   */
  ace_aws_products: string;
  /**
   * AWS-assigned reviewers from `AwsOpportunitySummary.OpportunityTeam[]`.
   * Each role surfaces as `"<First> <Last> (<email>)"` (display) plus a
   * separate email-only mirror for the two roles that get explicit
   * email fields in the partner's HubSpot setup. The Python batch
   * sync writes the same six fields out-of-band; this brings the TS
   * Lambdas (Refresh + EventBridge auto-pull + Share post-engagement
   * read) into parity so partners don't need to wait for the next
   * Python run for the AWS-team contacts to populate.
   */
  ace_aws_account_manager: string;
  ace_aws_account_manager_email: string;
  ace_aws_sales_rep: string;
  ace_aws_sales_rep_email: string;
  ace_aws_partner_sales_manager: string;
  ace_aws_partner_development_manager: string;
  // Canonical HubSpot deal fields that AWS owns the truth on.
  // `closedate` accepts `YYYY-MM-DD` (HubSpot's date type). `amount` is
  // the total contract value computed as monthly × contract-term-months.
  closedate?: string;
  amount?: string;
};

/** Default contract term used when the deal has no `contract_term__months_`. */
const DEFAULT_CONTRACT_MONTHS = 12;

/**
 * Convert the AWS-side monthly spend back to HubSpot's total contract
 * value by multiplying by the deal's contract term (months). The Share
 * path divides total ÷ months to get monthly, so this reverses that
 * exact transformation. Returns `""` when either input is non-numeric
 * so the caller skips the write rather than blanking the deal.
 */
function monthlyToContractTotal(
  monthlyRaw: string,
  contractMonthsRaw: string | undefined
): string {
  const monthly = Number(monthlyRaw);
  if (!Number.isFinite(monthly) || monthly <= 0) return "";
  let months =
    contractMonthsRaw !== undefined ? Number(contractMonthsRaw) : DEFAULT_CONTRACT_MONTHS;
  if (!Number.isFinite(months) || months <= 0) months = DEFAULT_CONTRACT_MONTHS;
  const total = monthly * months;
  if (total === Math.floor(total)) return String(Math.floor(total));
  return total.toFixed(2);
}

/**
 * Convert an `AceSnapshot` to the HubSpot deal-property write map.
 *
 * Pass the current deal so we can reverse the Share path's monthly
 * spend math (total ÷ months → monthly) using the same contract term
 * the operator has on file. When the deal is omitted, `closedate` and
 * `amount` are NOT written — the caller falls back to whatever HubSpot
 * already has.
 */
export function snapshotToProps(
  snapshot: AceSnapshot,
  deal?: DealProps
): SnapshotProps {
  const props: SnapshotProps = {
    ace_sync_status: snapshot.syncStatus,
    aws_review_status: snapshot.awsReviewStatus,
    aws_stage: snapshot.awsStage,
    aws_review_comments: snapshot.awsReviewComments,
    aws_review_status_reason: snapshot.awsReviewStatusReason,
    hs_next_step: snapshot.awsNextSteps,
    dealname: snapshot.awsProjectTitle,
    description: snapshot.awsCustomerBusinessProblem,
    ace_additional_comments: snapshot.awsAdditionalComments,
    ace_competitor_name: snapshot.awsCompetitorName,
    ace_other_competitor_names: snapshot.awsOtherCompetitorNames,
    ace_other_solution_description: snapshot.awsOtherSolutionDescription,
    ace_apn_programs: snapshot.awsApnPrograms,
    ace_aws_partition: snapshot.awsAwsPartition,
    ace_customer_use_case: snapshot.awsCustomerUseCase,
    ace_delivery_model: snapshot.awsDeliveryModels,
    ace_sales_activities: snapshot.awsSalesActivities,
    ace_currency_code: snapshot.awsCurrencyCode,
    ace_primary_need_from_aws: snapshot.awsPrimaryNeedFromAws,
    ace_opportunity_type: snapshot.awsOpportunityType,
    ace_marketing_source: snapshot.awsMarketingSource,
    ace_aws_funding_used: snapshot.awsAwsFundingUsed,
    ace_marketing_campaign_name: snapshot.awsMarketingCampaignName,
    ace_marketing_use_cases: snapshot.awsMarketingUseCases,
    ace_marketing_channels: snapshot.awsMarketingChannels,
    ace_national_security: snapshot.awsNationalSecurity,
    ace_closed_lost_reason: snapshot.awsClosedLostReason,
    ace_industry: snapshot.awsIndustry,
    ace_aws_account_id: snapshot.awsAwsAccountId,
    ace_duns: snapshot.awsDuns,
    ace_street_address: snapshot.awsStreetAddress,
    // Deal-level overrides for the customer-info fields. Populated
    // by Refresh from AWS so deals reverse-synced from Partner
    // Central carry the customer info even when no HubSpot company
    // is associated. The Share path falls back to these when the
    // company association is empty.
    ace_company_name: snapshot.awsCompanyName,
    ace_country_code: snapshot.awsCountryCode,
    ace_postal_code: snapshot.awsPostalCode,
    ace_state_or_region: snapshot.awsStateOrRegion,
    ace_city: snapshot.awsCity,
    ace_website_url: snapshot.awsWebsiteUrl,
    ace_involvement_type: snapshot.awsInvolvementType,
    ace_visibility: snapshot.awsVisibility,
    ace_solutions: snapshot.awsSolutions,
    ace_aws_products: snapshot.awsAwsProducts,
    ace_aws_account_manager: snapshot.awsAccountManager,
    ace_aws_account_manager_email: snapshot.awsAccountManagerEmail,
    ace_aws_sales_rep: snapshot.awsSalesRep,
    ace_aws_sales_rep_email: snapshot.awsSalesRepEmail,
    ace_aws_partner_sales_manager: snapshot.awsPartnerSalesManager,
    ace_aws_partner_development_manager:
      snapshot.awsPartnerDevelopmentManager,
  };
  // closedate: AWS owns the truth — write `YYYY-MM-DD` straight back.
  if (snapshot.awsTargetCloseDate.length > 0) {
    props.closedate = snapshot.awsTargetCloseDate;
  }
  // amount: reverse the monthly-spend math when we have a deal to pull
  // the contract term off. Skipped when `deal` is undefined or when AWS
  // has no spend value — the existing HubSpot `amount` stays put rather
  // than getting clobbered to 0.
  if (deal && snapshot.awsExpectedMonthlyAmount.length > 0) {
    const total = monthlyToContractTotal(
      snapshot.awsExpectedMonthlyAmount,
      deal.contract_term__months_
    );
    if (total.length > 0) props.amount = total;
  }
  return props;
}

/**
 * Resolve the AwsSubmission InvolvementType and Visibility for the
 * StartEngagement call. Same precedence as payload-level overrides:
 * per-deal HubSpot property → env-default secret → hardcoded fallback.
 */
export function buildAwsSubmission(
  deal: DealProps,
  config: AppConfig
): { InvolvementType: string; Visibility: string } {
  const dealInvolvement = deal["ace_involvement_type"]?.trim();
  const envInvolvement = config.aceDefaultInvolvementType?.trim();
  const dealVisibility = deal["ace_visibility"]?.trim();
  const envVisibility = config.aceDefaultVisibility?.trim();
  return {
    InvolvementType:
      (dealInvolvement && dealInvolvement.length > 0 ? dealInvolvement : undefined) ??
      (envInvolvement && envInvolvement.length > 0 ? envInvolvement : undefined) ??
      "Co-Sell",
    Visibility:
      (dealVisibility && dealVisibility.length > 0 ? dealVisibility : undefined) ??
      (envVisibility && envVisibility.length > 0 ? envVisibility : undefined) ??
      "Full",
  };
}

/**
 * Fetch the latest ACE state for an opportunity and return both:
 *   - the closed-enum `syncStatus` (for `ace_sync_status`)
 *   - the raw `awsReviewStatus` / `awsStage` / etc. (for the mirror fields)
 *
 * Issues two reads in parallel:
 *   - `GetOpportunity`           — stage / review status / project /
 *                                   customer / lifecycle.
 *   - `GetAwsOpportunitySummary` — InvolvementType / Visibility /
 *                                   Solutions. These are NOT on the
 *                                   GetOpportunity response.
 *
 * The summary read is best-effort: AWS may not populate it until
 * after the AWS-acceptance window closes. When it fails, we still
 * return the partial snapshot so the rest of Share's write-back
 * lands.
 *
 * Returns a safe fallback if GetOpportunity itself fails — the rest of
 * the Share flow already succeeded so a status read failure shouldn't
 * mask that.
 */
export async function fetchAceSnapshot(
  ace: AceClient,
  oppId: string
): Promise<AceSnapshot> {
  try {
    const [opp, summary] = await Promise.all([
      ace.getOpportunity({
        Catalog: ACE_CATALOG,
        Identifier: oppId,
      } as never),
      ace
        .getAwsOpportunitySummary({
          Catalog: ACE_CATALOG,
          RelatedOpportunityIdentifier: oppId,
        } as never)
        .catch(() => undefined),
    ]);
    const lifeCycle = (
      opp as {
        LifeCycle?: { Stage?: string; ReviewStatus?: string };
      }
    ).LifeCycle;
    const syncStatus = resolveStatus(
      lifeCycle?.ReviewStatus,
      lifeCycle?.Stage
    );
    return snapshotFromOpportunity(opp, syncStatus, summary);
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Dependencies injected into `runShare`. The Lambda handler wrapper wires
 * these from Secrets Manager + the real SDK clients; tests substitute
 * in-memory mocks so the full orchestration can be exercised without
 * touching any external service.
 */
export type ShareDeps = {
  config: AppConfig;
  ace: AceClient;
  hs: HubspotClient;
  /**
   * Optional pull-lock cache deps. When present, `runShare` seeds the
   * dealId cache after a successful CreateOpportunity so the next
   * EventBridge `Opportunity Created` event (which the Pull Lambda
   * receives almost immediately) can short-circuit the HubSpot
   * search-index lag. The handler in `handlers/share.ts` populates
   * this from `PULL_LOCK_TABLE`; tests can leave it undefined.
   */
  lock?: import("../lib/pull-lock").LockDeps;
};

/**
 * Main share orchestration, parameterised by its dependencies for
 * testability. The Lambda handler in `handlers/share.ts` constructs the
 * real dependencies and delegates to this function.
 */
export async function runShare(
  dealId: number,
  deps: ShareDeps
): Promise<FunctionResponse> {
  const { config, hs } = deps;

  // 1. Parse STAGE_MAPPING. Off-list ACE stages are a config error (R9.4).
  const { mapping, invalidEntries } = parseStageMapping(config.stageMappingRaw);
  if (invalidEntries.length > 0) {
    return makeError(
      ErrorCode.STAGE_UNMAPPABLE,
      undefined,
      `STAGE_MAPPING contains off-list ACE stages: ${invalidEntries.join(", ")}`,
      { invalidStageMappings: invalidEntries }
    );
  }
  if (Object.keys(mapping).length === 0) {
    return makeError(
      ErrorCode.STAGE_UNMAPPABLE,
      undefined,
      "STAGE_MAPPING is empty — no HubSpot stages are mapped to ACE stages."
    );
  }

  // 2. Read the deal and its primary associated company in parallel.
  let deal: DealProps;
  let company: CompanyProps;
  try {
    [deal, company] = await Promise.all([
      hs.readDealProperties(dealId, DEAL_PROPERTY_NAMES),
      hs.readAssociatedCompany(dealId),
    ]);
  } catch (err) {
    // Reading from HubSpot failed — surface as a HUBSPOT_WRITE-class error
    // (the code covers the whole HubSpot-IO failure class in errors.ts).
    return makeError(
      ErrorCode.HUBSPOT_WRITE,
      "readDeal",
      `Failed to read deal ${dealId} from HubSpot: ${(err as Error).message}`
    );
  }

  // 3. Branch on whether the deal already carries an ACE opportunity ID.
  const existingOppId = deal.ace_opportunity_id?.trim();
  if (existingOppId) {
    return updatePath(dealId, existingOppId, deal, company, mapping, deps);
  }
  return createPath(dealId, deal, company, mapping, deps);
}

/**
 * Three-step create flow: CreateOpportunity → write
 * `ace_opportunity_id` → AssociateOpportunity → StartEngagement. Each
 * ACE step is separated from the next by a 1000ms inter-write delay
 * (R10.1, R10.2).
 */
async function createPath(
  dealId: number,
  deal: DealProps,
  company: CompanyProps,
  mapping: StageMapping,
  deps: ShareDeps
): Promise<FunctionResponse> {
  const { config, ace, hs } = deps;

  const failures = validatePreconditions(deal, company, mapping);
  if (failures.length > 0) {
    return makeError(
      ErrorCode.PRECONDITION,
      undefined,
      `Cannot share: ${failures.join(", ")}`,
      { preconditionFailures: failures }
    );
  }

  // Submission_Mode classification (R1.2, R1.3, R3.5). The classifier
  // downgrades to `Create_Only` when any Submission_Required_Field
  // (`ace_involvement_type`, `ace_visibility`) is empty — those fields
  // are NOT precondition failures, they only gate the StartEngagement
  // step below. R3.5: missing values do not fail the create, they
  // defer submission to a deliberate Submit_Action click.
  //
  // `deal as never` because `DealProps` and `SubmissionInputs` have
  // different named fields but identical `Record<string, string |
  // undefined>` shape — TS's weak-type detection rejects the direct
  // assignment despite the shapes being structurally compatible.
  const mode = classifySubmissionMode(deal as never);

  const createInput = buildCreatePayload(dealId, deal, company, config);

  // Step 1: CreateOpportunity. ACE keys idempotency on (operation,
  // ClientToken, body). If a previous create with the same ClientToken
  // landed a DIFFERENT body (e.g. older payload format from before a
  // `PAYLOAD_VERSION` bump), ACE returns ConflictException. Retry once
  // with a randomized ClientToken so the user isn't permanently locked
  // out of creating a new opp for the deal. The trade-off: this retry
  // breaks Python-batch ↔ TypeScript-Lambda determinism for THIS specific
  // deal, but only for the duration of the recovery — once written back
  // to HubSpot the new OppId becomes the source of truth and subsequent
  // syncs use the update path which doesn't depend on ClientToken.
  logStep("create", "begin", dealId);
  let createResp;
  try {
    createResp = await ace.createOpportunity(createInput as never);
  } catch (err) {
    if (isConflict(err)) {
      try {
        const retryInput = {
          ...createInput,
          ClientToken: randomUUID(),
        };
        createResp = await ace.createOpportunity(retryInput as never);
      } catch (retryErr) {
        return aceFailure(
          "CreateOpportunity",
          ErrorCode.ACE_CREATE,
          retryErr,
          dealId,
          hs
        );
      }
    } else {
      return aceFailure("CreateOpportunity", ErrorCode.ACE_CREATE, err, dealId, hs);
    }
  }
  const aceOppId = (createResp as { Id?: string }).Id;
  if (!aceOppId) {
    return makeError(
      ErrorCode.ACE_CREATE,
      "CreateOpportunity",
      "CreateOpportunity returned no Id"
    );
  }
  logStep("create", "ok", dealId, { oppId: aceOppId });

  // Persist the new ACE ID immediately so a subsequent retry (after a
  // mid-flow failure) resumes as an update instead of creating a duplicate.
  // The status here is `Synced` because we did successfully reach ACE
  // and got an opportunity id back; if the engagement step that
  // follows fails, the failure handler overwrites with `Sync Error`.
  // The richer "where in the lifecycle is this opp" detail lives in
  // `aws_review_status` / `aws_stage` once the post-engagement read
  // completes.
  const createTs = nowIso();
  try {
    await hs.writeDealProperties(dealId, {
      ace_opportunity_id: aceOppId,
      ace_sync_status: "Synced",
      ace_last_sync: createTs,
      ace_sync_error: "",
    });
  } catch (err) {
    // Writing back to HubSpot failed. ACE has the new opportunity but
    // HubSpot doesn't know its ID — the card will show "Not Synced" on
    // re-read and the user will need to click Share again. That re-click
    // will CreateOpportunity with the same ClientToken and ACE will
    // idempotently return the same ID, at which point this write may
    // succeed. Surface the failure plainly.
    return makeError(
      ErrorCode.HUBSPOT_WRITE,
      "writeDealProperties",
      `CreateOpportunity succeeded (${aceOppId}) but writing back to HubSpot failed: ${(err as Error).message}. Click Share again to reconcile.`
    );
  }

  // Seed the per-opp dealId cache so the immediately-following
  // EventBridge `Opportunity Created` event can short-circuit
  // HubSpot's search-index lag and skip straight to Refresh
  // (avoiding duplicate-create). Best-effort — failure is logged
  // but doesn't fail the Share. Wrapped in try so a missing
  // `deps.lock` (tests, or stacks built before the lock table
  // existed) doesn't crash the handler.
  if (deps.lock) {
    try {
      const { seedCache } = await import("../lib/pull-lock");
      await seedCache(aceOppId, dealId, deps.lock);
    } catch {
      // best-effort; the cache miss just means the Pull event will
      // search HubSpot directly and likely find the deal once the
      // index catches up.
    }
  }

  // Step 2: AssociateOpportunity for both Solution Offerings AND AWS
  // Products. Both are `;`-separated picklist fields on the deal,
  // both go through the same AssociateOpportunity surface, and both
  // are deduped + trimmed by `parseRelatedEntityIds`.
  //
  // Solutions are required by `validatePreconditions` (R-precondition
  // 8) — there must be at least one valid Solution Offering OR an
  // `ace_other_solution_description`. AWS Products are entirely
  // optional; the deal can ship with zero products and AWS accepts
  // it.
  //
  // Latency note: associations are independent (no entity depends on
  // another). We run the whole batch in parallel under a single
  // 1000ms inter-write delay to keep total Share latency under the
  // 22s HubSpot client-side fetch timeout when many AWS Products are
  // selected. Failures are collected per-entity so the error envelope
  // still names the specific failing id.
  const solutionIds = parseSolutionIds(deal.ace_solutions);
  const awsProductIds = parseAwsProductIds(deal.ace_aws_products);
  type AssociateBatchItem = {
    type: "Solutions" | "AwsProducts";
    id: string;
  };
  const associateBatch: AssociateBatchItem[] = [
    ...solutionIds.map((id): AssociateBatchItem => ({ type: "Solutions", id })),
    ...awsProductIds.map(
      (id): AssociateBatchItem => ({ type: "AwsProducts", id }),
    ),
  ];
  if (associateBatch.length > 0) {
    await sleep(WRITE_DELAY_MS);
    const results = await Promise.allSettled(
      associateBatch.map(async (item) => {
        logStep("associate", "begin", dealId, {
          oppId: aceOppId,
          relatedEntityType: item.type,
          entityId: item.id,
        });
        await ace.associateOpportunity({
          Catalog: ACE_CATALOG,
          OpportunityIdentifier: aceOppId,
          RelatedEntityType: item.type,
          RelatedEntityIdentifier: item.id,
        } as never);
        logStep("associate", "ok", dealId, {
          oppId: aceOppId,
          relatedEntityType: item.type,
          entityId: item.id,
        });
      }),
    );
    // Surface the FIRST failure in iteration order so the error step
    // is deterministic across runs (Promise.allSettled preserves
    // input order in `results`).
    const firstFailureIdx = results.findIndex((r) => r.status === "rejected");
    if (firstFailureIdx !== -1) {
      const failed = associateBatch[firstFailureIdx];
      const reason = (results[firstFailureIdx] as PromiseRejectedResult).reason;
      return aceFailure(
        `AssociateOpportunity[${failed.type}:${failed.id}]`,
        ErrorCode.ACE_CREATE,
        reason,
        dealId,
        hs,
      );
    }
  }

  // Step 3: StartEngagementFromOpportunityTask, after the inter-write delay.
  // R2.1, R2.2: only fire on `Create_And_Submit`. R3.1, R3.5: in
  // `Create_Only` mode the engagement step is deferred to a deliberate
  // Submit_Action click (handled by `core/run-submit.ts`); the
  // ace_opportunity_id was already written to HubSpot above so the
  // partner has a recoverable opp.
  if (mode === "Create_And_Submit") {
    await sleep(WRITE_DELAY_MS);
    logStep("start_engagement", "begin", dealId, { oppId: aceOppId });
    try {
      await ace.startEngagementFromOpportunityTask({
        Catalog: ACE_CATALOG,
        Identifier: aceOppId,
        // Use a SEPARATE ClientToken from CreateOpportunity. Reusing the
        // same token across operations causes ACE to silently dedupe
        // the task; the engagement never starts and ReviewStatus stays
        // blank. See `lib/client-token.ts`.
        ClientToken: generateEngagementClientToken(dealId),
        AwsSubmission: buildAwsSubmission(deal, config),
      } as never);
    } catch (err) {
      // R8.3: `ace_opportunity_id` was already written by the
      // post-create writeback above, so a StartEngagement failure here
      // leaves the partner with a recoverable opp — they can retry via
      // the Submit_Action button without producing a duplicate.
      return aceFailure(
        "StartEngagement",
        ErrorCode.ACE_CREATE,
        err,
        dealId,
        hs
      );
    }
    logStep("start_engagement", "ok", dealId, { oppId: aceOppId });
  } else {
    logStep("start_engagement", "skip", dealId, { oppId: aceOppId });
  }

  // Step 4: Read back the post-engagement state and surface it as
  // `ace_sync_status` (closed enum) plus the raw `aws_*` mirror fields
  // so the deal carries the real ACE state for every editable field.
  const snapshot = await fetchAceSnapshot(ace, aceOppId);
  const finalTs = nowIso();
  const finalProps = {
    ace_opportunity_id: aceOppId,
    ...snapshotToProps(snapshot, deal),
    ace_last_sync: finalTs,
    ace_sync_error: "" as const,
  };
  try {
    await hs.writeDealProperties(dealId, { ...finalProps });
  } catch {
    // Best-effort: the early-create write already landed the
    // ace_opportunity_id, so a Refresh click will reconcile the
    // status. Don't fail the whole Share for this.
  }

  // R2.4 / R3.4: success message reflects whether the click also
  // submitted the opportunity. The literal `submitted for review` /
  // `saved as draft` substrings are required by the requirements doc
  // (case-sensitive — they appear verbatim in the message body) for
  // the card and any downstream consumers to disambiguate the two
  // success modes from the message text alone.
  const message =
    mode === "Create_And_Submit"
      ? `ACE opportunity ${aceOppId} created and submitted for review.`
      : `ACE opportunity ${aceOppId} saved as draft. Click "Submit for AWS Review" to submit.`;
  const success: SuccessResponse = {
    ok: true,
    message,
    properties: finalProps,
  };
  return success;
}

/**
 * Update flow: GetOpportunity → buildUpdatePayload → UpdateOpportunity,
 * with a single retry on `ConflictException` (stale LastModifiedDate, R11.2).
 * A second conflict surfaces as `STALE_OPPORTUNITY` and the card prompts
 * the user to Refresh first (R11.3).
 */
async function updatePath(
  dealId: number,
  existingOppId: string,
  deal: DealProps,
  company: CompanyProps,
  mapping: StageMapping,
  deps: ShareDeps
): Promise<FunctionResponse> {
  const { ace, hs, config } = deps;

  const failures = validatePreconditions(deal, company, mapping);
  if (failures.length > 0) {
    return makeError(
      ErrorCode.PRECONDITION,
      undefined,
      `Cannot share: ${failures.join(", ")}`,
      { preconditionFailures: failures }
    );
  }

  // Fetch the current opportunity so we have a LastModifiedDate to pass
  // through UpdateOpportunity — ACE requires it for optimistic concurrency.
  let opp;
  try {
    opp = await ace.getOpportunity({
      Catalog: ACE_CATALOG,
      Identifier: existingOppId,
    } as never);
  } catch (err) {
    return aceFailure("GetOpportunity", ErrorCode.ACE_GET, err, dealId, hs);
  }
  const lastModified = (opp as { LastModifiedDate?: string }).LastModifiedDate;
  if (!lastModified) {
    return makeError(
      ErrorCode.ACE_GET,
      "GetOpportunity",
      "Missing LastModifiedDate on GetOpportunity response"
    );
  }
  // Per AWS docs (working-with-opportunity-updates.html):
  //
  //   - Pending Submission → fully editable (draft mode). No
  //     restrictions; the partner can update Stage and any other
  //     field freely until StartEngagementFromOpportunityTask
  //     submits the opp for review.
  //   - Submitted / In Review → all updates BLOCKED. AWS is
  //     reviewing the opportunity and rejects every UpdateOpportunity
  //     during that window. We fail fast here so the partner sees a
  //     clear message instead of a generic ACE rejection.
  //   - Action Required → AWS opens a documented subset of fields
  //     for edits. We treat this like the editable path; AWS will
  //     reject any out-of-subset changes individually with
  //     ACTION_NOT_PERMITTED.
  //   - Approved → most fields editable, but several are locked.
  //     The documented list (Country, PostalCode, Industry,
  //     WebsiteUrl, CustomerBusinessProblem, PartnerOpportunityIdentifier,
  //     Title) is incomplete — empirically, `CompanyName` and the
  //     entire `SoftwareRevenue` block are also locked. We use the
  //     verbatim-passthrough strategy: send AWS's existing values
  //     for the Customer + SoftwareRevenue blocks so AWS sees no
  //     change. The post-Share Refresh re-syncs HubSpot from AWS,
  //     reverting any partner edits to locked fields silently. The
  //     card's locked-state Alert warns users about this beforehand.
  //   - Disqualified / null → treated like Approved: pass through
  //     locked blocks verbatim. AWS may or may not accept the
  //     update; if it doesn't, the error surfaces in
  //     ace_sync_error.
  //
  // Note: opportunities with `ReviewStatus = null` AND an engagement
  // already created are PERMANENTLY ORPHANED. ACE's SubmitOpportunity
  // (called inside StartEngagementFromOpportunityTask) only accepts
  // opps whose ReviewStatus is "Pending Submission" or "Action Required";
  // null is rejected. We can't recover those via the API.
  const reviewStatus =
    (opp as { LifeCycle?: { ReviewStatus?: string } }).LifeCycle
      ?.ReviewStatus;

  // Block fast on Submitted / In Review — every update is rejected
  // by AWS during the review window. Failing fast saves a round-trip
  // and surfaces a clear, actionable message instead of AWS's
  // generic rejection cascade.
  if (reviewStatus === "Submitted" || reviewStatus === "In Review") {
    try {
      await hs.writeDealProperties(dealId, {
        ace_sync_status: "Sync Error",
        ace_sync_error: `Cannot update: AWS is reviewing this opportunity (status: ${reviewStatus}). Updates are blocked until status moves to Approved or Action Required.`,
      });
    } catch {
      // best-effort — error envelope below is the canonical surface
    }
    return makeError(
      ErrorCode.PRECONDITION,
      "checkReviewStatus",
      `Cannot update: AWS is reviewing this opportunity (status: ${reviewStatus}). Updates are blocked until status moves to Approved or Action Required.`
    );
  }

  // Lift the existing Customer block so `buildUpdatePayload` can
  // re-send it verbatim when ACE has locked the opp (Approved /
  // Disqualified / Action Required, where some sub-fields are
  // locked). The Pending Submission / Action Required path can also
  // include lockedCustomer harmlessly — buildUpdatePayload only
  // applies it when the state is in the locked set.
  const lockedCustomer =
    (opp as { Customer?: unknown }).Customer ?? undefined;
  // Same problem applies to SoftwareRevenue — AWS locks every
  // sub-field once ReviewStatus crosses out of Pending Submission,
  // and treats the block's absence as "user wants to clear it"
  // (ACTION_NOT_PERMITTED on every sub-field). Pass the live value
  // through verbatim when present.
  const lockedSoftwareRevenue =
    (opp as { SoftwareRevenue?: unknown }).SoftwareRevenue ?? undefined;
  // Track whether the opp arrived in Pending Submission so the
  // success message below can include the `draft updated` literal
  // (R7.4) and so the `forceStage` workaround on the
  // `UpdateOpportunity` payload can fire.
  //
  // AWS docs state Pending Submission is "fully editable", but the
  // Sandbox catalog empirically rejects ANY `LifeCycle.Stage` change
  // in this state with `ACTION_NOT_PERMITTED: You can not update the
  // stage when Opportunity status is Pending Submission`. Other
  // fields ARE editable — just not Stage. So when we see Pending
  // Submission, force-send AWS's current Stage value. The mapped
  // HubSpot stage that the partner is trying to push is preserved
  // on the deal; once the partner clicks Submit (R7.2 — Share no
  // longer auto-submits) the opp moves out of Pending Submission and
  // the next Share click will pass the real stage through.
  const isPendingSubmission = reviewStatus === "Pending Submission";
  const currentStage =
    (opp as { LifeCycle?: { Stage?: string } }).LifeCycle?.Stage;
  const stageOption: {
    forceStage?: string;
    reviewStatus?: string;
    lockedCustomer?: unknown;
    lockedSoftwareRevenue?: unknown;
  } = {
    // Force the existing Stage when Pending Submission — AWS rejects
    // any change in that state. Outside Pending Submission (Approved,
    // Action Required), Stage is editable and we let the mapped
    // HubSpot stage flow through.
    ...(isPendingSubmission && currentStage
      ? { forceStage: currentStage }
      : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(lockedCustomer ? { lockedCustomer } : {}),
    ...(lockedSoftwareRevenue
      ? { lockedSoftwareRevenue }
      : {}),
  };

  // First UpdateOpportunity attempt.
  try {
    const payload = buildUpdatePayload(
      dealId,
      deal,
      company,
      existingOppId,
      lastModified,
      mapping,
      config,
      stageOption
    );
    await ace.updateOpportunity(payload as never);
  } catch (err) {
    if (isConflict(err)) {
      // Single retry (R11.2): re-fetch the opportunity, rebuild the
      // payload against the fresh LastModifiedDate, and try once more.
      try {
        const fresh = await ace.getOpportunity({
          Catalog: ACE_CATALOG,
          Identifier: existingOppId,
        } as never);
        const freshLm =
          (fresh as { LastModifiedDate?: string }).LastModifiedDate ?? "";
        const freshLifeCycle = (
          fresh as { LifeCycle?: { ReviewStatus?: string; Stage?: string } }
        ).LifeCycle;
        const freshReviewStatus = freshLifeCycle?.ReviewStatus;
        // Same Submitted / In Review fail-fast as the initial path —
        // a Refresh between calls might have flipped the opp into
        // review while we were retrying.
        if (
          freshReviewStatus === "Submitted" ||
          freshReviewStatus === "In Review"
        ) {
          try {
            await hs.writeDealProperties(dealId, {
              ace_sync_status: "Sync Error",
              ace_sync_error: `Cannot update: AWS is reviewing this opportunity (status: ${freshReviewStatus}). Updates are blocked until status moves to Approved or Action Required.`,
            });
          } catch {
            // best-effort
          }
          return makeError(
            ErrorCode.PRECONDITION,
            "checkReviewStatus",
            `Cannot update: AWS is reviewing this opportunity (status: ${freshReviewStatus}). Updates are blocked until status moves to Approved or Action Required.`
          );
        }
        const freshLockedCustomer =
          (fresh as { Customer?: unknown }).Customer ?? undefined;
        const freshLockedSoftwareRevenue =
          (fresh as { SoftwareRevenue?: unknown }).SoftwareRevenue ??
          undefined;
        // Same Pending-Submission stage-lock workaround as the
        // initial attempt — see the comment block above isPendingSubmission.
        const freshIsPending = freshReviewStatus === "Pending Submission";
        const freshStageOption: {
          forceStage?: string;
          reviewStatus?: string;
          lockedCustomer?: unknown;
          lockedSoftwareRevenue?: unknown;
        } = {
          ...(freshIsPending && freshLifeCycle?.Stage
            ? { forceStage: freshLifeCycle.Stage }
            : {}),
          ...(freshReviewStatus ? { reviewStatus: freshReviewStatus } : {}),
          ...(freshLockedCustomer
            ? { lockedCustomer: freshLockedCustomer }
            : {}),
          ...(freshLockedSoftwareRevenue
            ? { lockedSoftwareRevenue: freshLockedSoftwareRevenue }
            : {}),
        };
        const retryPayload = buildUpdatePayload(
          dealId,
          deal,
          company,
          existingOppId,
          freshLm,
          mapping,
          config,
          freshStageOption
        );
        await ace.updateOpportunity(retryPayload as never);
      } catch (retryErr) {
        if (isConflict(retryErr)) {
          // R11.3: a second stale response means the deal really is drifting
          // under us. Tell the user to Refresh, then Share again.
          try {
            await hs.writeDealProperties(dealId, {
              ace_sync_status: "Sync Error",
              ace_sync_error:
                "Deal changed in ACE. Click Refresh, then try Share again.",
            });
          } catch {
            // Swallow secondary HubSpot-write failures — the primary
            // STALE_OPPORTUNITY envelope already carries the message.
          }
          return makeError(
            ErrorCode.STALE_OPPORTUNITY,
            "UpdateOpportunity",
            "This deal changed in ACE since you last synced. Click Refresh, then click Share again."
          );
        }
        // Non-conflict error on the retry — map to ACE_UPDATE.
        return aceFailure(
          "UpdateOpportunity",
          ErrorCode.ACE_UPDATE,
          retryErr,
          dealId,
          hs
        );
      }
    } else {
      return aceFailure(
        "UpdateOpportunity",
        ErrorCode.ACE_UPDATE,
        err,
        dealId,
        hs
      );
    }
  }

  // R7.2: an editable pass-through update against a Pending Submission
  // opp must NOT auto-submit. The previous auto-recovery
  // `StartEngagementFromOpportunityTask` call that lived here is gone —
  // submission is now a deliberate click on the new Submit button
  // (see `core/run-submit.ts`). The Pending-Submission stage-lock
  // workaround (`forceStage`) above stays — it is still required for
  // the UpdateOpportunity itself to succeed against AWS in that state.

  // Reconcile per-deal Solution Offering AND AWS Product associations.
  // The HubSpot-side `ace_solutions` and `ace_aws_products` fields
  // are the source of truth on Share; AWS holds the same sets in
  // `RelatedEntityIdentifiers.{Solutions,AwsProducts}`. Diff each
  // independently and: associate any new IDs first, THEN disassociate
  // any removed IDs (per AWS guidance — see DisassociateOpportunity
  // API docs). The 1000ms inter-write delay is honoured between every
  // attach/detach call so we never trip the create-flow throttle.
  // Failures here are surfaced via `ace_sync_error` and an envelope
  // error code; the UpdateOpportunity itself has already landed, so
  // we don't roll that back.
  const desiredSolutions = parseSolutionIds(deal.ace_solutions);
  const currentSolutions = extractRelatedEntityIds(opp, "Solutions");
  const solutionsErr = await reconcileRelatedEntities(
    dealId,
    existingOppId,
    "Solutions",
    desiredSolutions,
    currentSolutions,
    deps
  );
  if (solutionsErr) return solutionsErr;

  const desiredAwsProducts = parseAwsProductIds(deal.ace_aws_products);
  const currentAwsProducts = extractRelatedEntityIds(opp, "AwsProducts");
  const productsErr = await reconcileRelatedEntities(
    dealId,
    existingOppId,
    "AwsProducts",
    desiredAwsProducts,
    currentAwsProducts,
    deps
  );
  if (productsErr) return productsErr;

  // UpdateOpportunity succeeded. Read back the post-update state from
  // ACE: closed-enum status for `ace_sync_status`, plus raw mirror
  // fields for every editable Project / Customer / LifeCycle field.
  // Mirrors what Refresh writes so the two flows stay consistent.
  const snapshot = await fetchAceSnapshot(ace, existingOppId);
  const writtenProps = {
    ...snapshotToProps(snapshot, deal),
    ace_last_sync: nowIso(),
    ace_sync_error: "" as const,
  };
  try {
    await hs.writeDealProperties(dealId, { ...writtenProps });
  } catch (err) {
    return makeError(
      ErrorCode.HUBSPOT_WRITE,
      "writeDealProperties",
      `ACE updated successfully, but writing back to HubSpot failed: ${(err as Error).message}. Click Refresh to reconcile.`
    );
  }

  // R7.4: when the opp arrived in `Pending Submission` (i.e. this was
  // an editable pass-through update against a draft), the success
  // message must include the literal `draft updated` substring so the
  // card can render the draft-mode confirmation and the partner is
  // reminded to click Submit when ready. Other states keep the
  // existing generic message shape. The literal is case-sensitive —
  // it appears verbatim in the message body.
  const message = isPendingSubmission
    ? `ACE opportunity ${existingOppId} draft updated. Click "Submit for AWS Review" to submit.`
    : `Updated ACE opportunity ${existingOppId}`;

  return {
    ok: true,
    message,
    properties: {
      ace_opportunity_id: existingOppId,
      ...writtenProps,
    },
  };
}

/**
 * Identify an ACE `ConflictException` — the error we retry once on the
 * update path (R11.2). The AWS SDK surfaces service errors with their
 * service-defined `name`; we key off that directly rather than the
 * message so translated/localised error strings never break the check.
 */
function isConflict(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "name" in err) {
    return (err as { name: unknown }).name === "ConflictException";
  }
  return false;
}

/**
 * Pull the current related-entity IDs off a `GetOpportunity` response.
 * AWS holds the value at `RelatedEntityIdentifiers.<EntityType>` as a
 * string array; missing / empty values become an empty array.
 */
function extractRelatedEntityIds(
  opp: unknown,
  entityType: "Solutions" | "AwsProducts",
): string[] {
  if (opp === null || typeof opp !== "object") return [];
  const related = (opp as { RelatedEntityIdentifiers?: unknown })
    .RelatedEntityIdentifiers;
  if (related === null || typeof related !== "object") return [];
  const entries = (related as Record<string, unknown>)[entityType];
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const s of entries) {
    if (typeof s === "string" && s.trim()) {
      out.push(s.trim());
    }
  }
  return out;
}

/**
 * Reconcile a per-deal related-entity association set with the
 * live AWS-side `RelatedEntityIdentifiers.<Type>` on Update.
 *
 * Generalised to handle both `Solutions` (Partner Central Solution
 * Offerings — the `S-…` IDs) and `AwsProducts` (the AWS service
 * catalog entries from `SampleAWSProducts.csv`). Both follow the
 * same `AssociateOpportunity` / `DisassociateOpportunity` shape
 * with the only variant being `RelatedEntityType`.
 *
 * Order:
 *   1. Compute `toAdd = desired \ current` and `toRemove = current \ desired`.
 *   2. Run every Associate first, then every Disassociate. AWS recommends
 *      attaching the replacement before detaching the original so the
 *      opportunity is never momentarily without a related entity.
 *   3. Insert a 1000ms sleep before each call (consistent with the
 *      create-path step delay) to keep us under the ACE write rate.
 *
 * Return `undefined` on success. On failure, write a `Sync Error` row to
 * HubSpot and return a fully-formed `ErrorResponse` so the caller can
 * short-circuit. The UpdateOpportunity has already landed by this point,
 * so we don't try to roll it back — partial-success is reported to the
 * user with enough context to retry the share.
 */
async function reconcileRelatedEntities(
  dealId: number,
  existingOppId: string,
  relatedEntityType: "Solutions" | "AwsProducts",
  desired: readonly string[],
  current: readonly string[],
  deps: ShareDeps
): Promise<ErrorResponse | undefined> {
  const desiredSet = new Set(desired);
  const currentSet = new Set(current);
  const toAdd = desired.filter((s) => !currentSet.has(s));
  const toRemove = current.filter((s) => !desiredSet.has(s));
  if (toAdd.length === 0 && toRemove.length === 0) return undefined;

  const { ace, hs } = deps;

  // Latency note: associations and disassociations within each phase
  // are independent of each other (the only ordering constraint is
  // that ALL adds finish before ANY remove fires, per AWS guidance).
  // We parallelize within each phase to keep total Share latency
  // under HubSpot's ~22s client-side fetch timeout when reconciling
  // many entities. Failures are collected per-entity so the error
  // envelope still names the specific failing id.

  // Step 1: associate the additions, all in parallel under one
  // inter-write delay.
  if (toAdd.length > 0) {
    await sleep(WRITE_DELAY_MS);
    const addResults = await Promise.allSettled(
      toAdd.map(async (entityId) => {
        logStep("associate", "begin", dealId, {
          oppId: existingOppId,
          relatedEntityType,
          entityId,
        });
        await ace.associateOpportunity({
          Catalog: ACE_CATALOG,
          OpportunityIdentifier: existingOppId,
          RelatedEntityType: relatedEntityType,
          RelatedEntityIdentifier: entityId,
        } as never);
        logStep("associate", "ok", dealId, {
          oppId: existingOppId,
          relatedEntityType,
          entityId,
        });
      }),
    );
    const firstAddFailure = addResults.findIndex((r) => r.status === "rejected");
    if (firstAddFailure !== -1) {
      const failedId = toAdd[firstAddFailure];
      const reason = (addResults[firstAddFailure] as PromiseRejectedResult).reason;
      return aceFailure(
        `AssociateOpportunity[${relatedEntityType}:${failedId}]`,
        ErrorCode.ACE_UPDATE,
        reason,
        dealId,
        hs,
      );
    }
  }

  // Step 2: disassociate the removals (after all additions, per AWS
  // guidance), again in parallel under one inter-write delay.
  if (toRemove.length > 0) {
    await sleep(WRITE_DELAY_MS);
    const removeResults = await Promise.allSettled(
      toRemove.map(async (entityId) => {
        logStep("disassociate", "begin", dealId, {
          oppId: existingOppId,
          relatedEntityType,
          entityId,
        });
        await ace.disassociateOpportunity({
          Catalog: ACE_CATALOG,
          OpportunityIdentifier: existingOppId,
          RelatedEntityType: relatedEntityType,
          RelatedEntityIdentifier: entityId,
        } as never);
        logStep("disassociate", "ok", dealId, {
          oppId: existingOppId,
          relatedEntityType,
          entityId,
        });
      }),
    );
    const firstRemoveFailure = removeResults.findIndex(
      (r) => r.status === "rejected",
    );
    if (firstRemoveFailure !== -1) {
      const failedId = toRemove[firstRemoveFailure];
      const reason = (removeResults[firstRemoveFailure] as PromiseRejectedResult)
        .reason;
      return aceFailure(
        `DisassociateOpportunity[${relatedEntityType}:${failedId}]`,
        ErrorCode.ACE_UPDATE,
        reason,
        dealId,
        hs,
      );
    }
  }

  return undefined;
}

/**
 * Build a human-readable message from an AWS Partner Central SDK error.
 *
 * Partner Central `ValidationException`s carry the actionable detail in a
 * structured `ErrorList` (each entry: `FieldName`, `Code`, `Message`) and/or
 * a `Reason` field — NOT in the top-level `.message`, which is frequently the
 * unhelpful literal `"UnknownError"` for validation failures. Prefer the
 * structured field-level detail, then `Reason`, then a meaningful `.message`,
 * then the exception name as a last resort.
 *
 * Example output:
 *   "ValidationException: ExpectedCustomerSpend.CurrencyCode: ESC cloud
 *    partition requires EUR currency [INVALID_VALUE]"
 */
export function formatAceError(err: unknown): string {
  if (err === null || typeof err !== "object") {
    return typeof err === "string" && err.length > 0 ? err : "unknown error";
  }
  const e = err as {
    name?: string;
    message?: string;
    Reason?: string;
    ErrorList?: Array<{
      FieldName?: string;
      Code?: string;
      Message?: string;
    }>;
  };
  const name = typeof e.name === "string" ? e.name : "";
  const namePrefix = name && name !== "UnknownError" ? `${name}: ` : "";

  // 1. Field-level detail from ErrorList (the most actionable).
  if (Array.isArray(e.ErrorList) && e.ErrorList.length > 0) {
    const parts: string[] = [];
    for (const item of e.ErrorList) {
      if (item === null || typeof item !== "object") continue;
      const field = item.FieldName?.trim();
      const m = item.Message?.trim();
      const codeRaw = item.Code?.trim();
      const head = [field, m].filter((s) => s && s.length > 0).join(": ");
      const seg = codeRaw ? `${head} [${codeRaw}]`.trim() : head;
      if (seg && seg !== "[]") parts.push(seg);
    }
    if (parts.length > 0) return `${namePrefix}${parts.join("; ")}`;
  }

  // 2. Reason string.
  if (typeof e.Reason === "string" && e.Reason.trim().length > 0) {
    return `${namePrefix}${e.Reason.trim()}`;
  }

  // 3. A meaningful top-level message (skip the "UnknownError" noise).
  if (
    typeof e.message === "string" &&
    e.message.trim().length > 0 &&
    e.message.trim() !== "UnknownError"
  ) {
    return e.message.trim();
  }

  // 4. Last resort: at least name the exception type.
  return name.length > 0 ? name : "unknown error";
}

/**
 * Shared error-handling tail for any ACE failure: promote
 * `ACEThrottledError` to `ACE_THROTTLED`, surface the structured AWS error
 * detail via `formatAceError`, log it for operators, attempt to write a
 * `Sync Error` status back to HubSpot (swallowing secondary failures), and
 * return a fully-formed `ErrorResponse`.
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
  const msg = formatAceError(err);
  // Log the structured AWS error to CloudWatch so operators can see the
  // real cause (field-level ErrorList, Reason, $metadata) — not just the
  // collapsed envelope. Best-effort; never throws.
  try {
    const e = err as {
      name?: string;
      message?: string;
      Reason?: string;
      $fault?: unknown;
      $metadata?: unknown;
      ErrorList?: unknown;
    };
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "error",
        fn: "share",
        event: `share.step.${step}.error`,
        dealId,
        errName: e?.name,
        errReason: e?.Reason,
        errList: e?.ErrorList,
        errFault: e?.$fault,
        errMetadata: e?.$metadata,
        formatted: msg,
      })
    );
  } catch {
    // ignore logging failures
  }
  try {
    await hs.writeDealProperties(dealId, {
      ace_sync_status: "Sync Error",
      ace_sync_error: `${step}: ${msg}`,
      ace_last_sync: nowIso(),
    });
  } catch {
    // Swallow — the user sees the primary ACE error in the card
    // alert; the next Refresh / EventBridge auto-pull will
    // reconcile.
  }
  return makeError(outCode, step, `${step} failed: ${msg}`);
}
