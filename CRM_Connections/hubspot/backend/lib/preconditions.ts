/**
 * Create-path precondition validation (Requirements 2.2, 2.3).
 *
 * Before the Share flow calls the ACE Opportunity create endpoint, the deal
 * and its primary associated company must satisfy these rules:
 *
 *   1. `closedate`                       — set (non-empty after trim)
 *   2. `amount`                          — parses as a positive finite number
 *   3. company `hs_country_code`         — set (non-empty after trim)
 *   4. company `state`                   — set (non-empty after trim) **only
 *                                          when `hs_country_code === "US"`**
 *                                          (see note below)
 *   5. company `zip`                     — set (non-empty after trim) *
 *   6. `description`                     — ≥ 20 characters after trim
 *                                          (HubSpot's built-in deal
 *                                          description; sent to ACE as
 *                                          `Project.CustomerBusinessProblem`)
 *   7. `dealstage`                       — maps to a known ACE stage via
 *                                          `stageMapping`
 *   8. `ace_solutions` OR `ace_other_solution_description` — the deal
 *                                          must declare what's being sold.
 *                                          Either path satisfies the rule:
 *                                            (a) `ace_solutions` lists at
 *                                                least one Partner Central
 *                                                Solution Offering ID
 *                                                matching `S-[0-9]+`. The
 *                                                value(s) get passed to
 *                                                `AssociateOpportunity`.
 *                                                Multiple IDs are
 *                                                `;`-separated; whitespace
 *                                                and non-matching entries
 *                                                (e.g. the literal "Other")
 *                                                are dropped before the
 *                                                count check.
 *                                            (b) `ace_other_solution_description`
 *                                                is non-blank — the deal
 *                                                rides on `Project.OtherSolutionDescription`
 *                                                and `AssociateOpportunity`
 *                                                is skipped. This mirrors
 *                                                the "Other" choice in the
 *                                                Partner Central UI.
 *   9. `ace_closed_lost_reason`           — set (non-empty after trim)
 *                                          **only when the mapped ACE
 *                                          stage is `Closed Lost`**. ACE
 *                                          requires `LifeCycle.ClosedLostReason`
 *                                          for any opportunity in that
 *                                          stage and rejects an
 *                                          UpdateOpportunity payload
 *                                          without it. Outside Closed
 *                                          Lost the field is ignored
 *                                          (and the payload builder
 *                                          omits it on the wire).
 *
 * (*) Rule 5 exists because ACE's `SubmitOpportunity` step (run inside
 * `StartEngagementFromOpportunityTask`) requires
 * `Customer.Account.Address.PostalCode`. The earlier `CreateOpportunity`
 * call accepts the opp without it, but the submission then fails async
 * with a less actionable error. Failing preconditions up-front gives
 * the user a clear list of what to fix.
 *
 * (**) Rule 4 — StateOrRegion — is conditionally required:
 *   - When `hs_country_code === "US"`: ACE requires it for SubmitOpportunity.
 *   - When `hs_country_code !== "US"`: ACE silently drops the StateOrRegion
 *     value on the wire, so demanding it from operators would be busy-work.
 *     The payload builder still sends `state` if present, in case ACE's
 *     non-US handling changes; we just don't fail-fast on its absence.
 *
 * `validatePreconditions` returns the violated rule keys in a stable order
 * (`PRECONDITION_KEYS`), which lets the UI render a predictable checklist and
 * lets the property test assert determinism.
 *
 * Empty-string and whitespace-only values are treated the same as missing —
 * HubSpot surfaces unset properties as either `undefined` or `""` depending on
 * how the property was last written, so both cases need to fail validation.
 */

import type { StageMapping } from "./stage-mapping";
import { forwardMap } from "./stage-mapping";
import { normalizeCountryCode } from "./country";

/**
 * HubSpot deal property bag as read via the CRM API. Values are strings in
 * HubSpot (even numeric and datetime fields), which mirrors how the Python
 * sync sees them. All fields are optional here because HubSpot returns missing
 * fields as `undefined` rather than throwing.
 */
export type DealProps = {
  dealstage?: string;
  closedate?: string; // ISO8601 string from HubSpot
  amount?: string; // numeric-valued string from HubSpot
  description?: string; // HubSpot's built-in deal description; sent to ACE as Project.CustomerBusinessProblem
  [k: string]: string | undefined;
};

/**
 * HubSpot company property bag for the deal's primary associated company.
 * `undefined` when the deal has no associated company.
 */
export type CompanyProps =
  | {
      name?: string;
      hs_country_code?: string;
      state?: string;
      zip?: string;
      city?: string;
      website?: string;
      domain?: string;
      [k: string]: string | undefined;
    }
  | undefined;

/** Keys identifying each precondition rule. Appear in the result array when violated. */
export type PreconditionKey =
  | "dealName"
  | "closedate"
  | "closeDateFuture"
  | "amount"
  | "currencyCode"
  | "countryCode"
  | "stateOrRegion"
  | "postalCode"
  | "websiteUrl"
  | "descriptionLength"
  | "industry"
  | "stageMappable"
  | "solutions"
  | "closedLostReason";

/**
 * Canonical ordering of precondition keys. `validatePreconditions` returns
 * violations in this order so callers (UI checklist, property tests) can rely
 * on determinism.
 */
export const PRECONDITION_KEYS: readonly PreconditionKey[] = [
  "dealName",
  "closedate",
  "closeDateFuture",
  "amount",
  "currencyCode",
  "countryCode",
  "stateOrRegion",
  "postalCode",
  "websiteUrl",
  "descriptionLength",
  "industry",
  "stageMappable",
  "solutions",
  "closedLostReason",
] as const;

/** Minimum trimmed length for `description` (Requirement 2.2 rule 4). */
const MIN_DESCRIPTION_LENGTH = 20;

/**
 * Parse a HubSpot `closedate` value into epoch milliseconds for the
 * future-date check. HubSpot surfaces dates either as an ISO 8601 string
 * (`"2026-12-31"` / `"2026-12-31T00:00:00.000Z"`) or, for datetime-typed
 * properties via the UI-extensions API, as epoch-ms numeric strings.
 * Returns `undefined` when the value can't be parsed — callers skip the
 * future check in that case and let AWS surface the error.
 */
function parseCloseDateMs(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  // ISO date-like prefix — anchor on the date portion at UTC midnight so
  // the comparison is timezone-stable.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const ms = Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(ms) ? undefined : ms;
  }
  // Epoch-ms fallback (numeric string).
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * True iff `closeMs` falls on a UTC calendar date strictly after `now`'s
 * UTC date. AWS requires a *future* TargetCloseDate, so today does not
 * qualify. Compares date-only (UTC midnight) to avoid intra-day and
 * timezone flakiness.
 */
function isCloseDateFuture(closeMs: number, now: Date): boolean {
  const close = new Date(closeMs);
  const closeUtc = Date.UTC(
    close.getUTCFullYear(),
    close.getUTCMonth(),
    close.getUTCDate()
  );
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return closeUtc > todayUtc;
}

/**
 * Validate the five create-path preconditions. Returns the list of violated
 * rule keys in `PRECONDITION_KEYS` order — an empty array means the deal is
 * ready to share.
 */
export function validatePreconditions(
  deal: DealProps,
  company: CompanyProps,
  stageMapping: StageMapping,
  now: Date = new Date()
): PreconditionKey[] {
  const violations: PreconditionKey[] = [];

  // 0. dealname must be set — AWS requires Project.Title (non-empty) and
  //    the deal name is its only source now that the canned "Partner
  //    Opportunity" default is removed.
  const dealName = deal.dealname?.trim();
  if (!dealName) {
    violations.push("dealName");
  }

  // 1. closedate must be set (non-empty, non-whitespace) AND, when set,
  //    resolve to a date strictly in the future. AWS Partner Central's
  //    CreateOpportunity rejects a past/today TargetCloseDate with
  //    `BUSINESS_VALIDATION_EXCEPTION ... should be a future date`
  //    (confirmed against the Sandbox API), so we fail fast here rather
  //    than round-tripping. An unparseable-but-present value skips the
  //    future check (presence already passed); AWS handles that edge.
  const closedate = deal.closedate?.trim();
  if (!closedate) {
    violations.push("closedate");
  } else {
    const closeMs = parseCloseDateMs(closedate);
    if (closeMs !== undefined && !isCloseDateFuture(closeMs, now)) {
      violations.push("closeDateFuture");
    }
  }

  // 2. amount must parse as a positive, finite number. HubSpot stores amounts
  //    as strings; Number("") === 0 and Number("abc") === NaN, so Number.isFinite
  //    plus a `> 0` check covers missing, malformed, zero, and negative values.
  const amountRaw = deal.amount;
  const amount = amountRaw !== undefined ? Number(amountRaw) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    violations.push("amount");
  }

  // 2b. Currency code — AWS requires ExpectedCustomerSpend.CurrencyCode
  //     (no silent default anymore). Sourced from the deal's
  //     `ace_currency_code`; the rep sets it per deal.
  const currencyCode = deal.ace_currency_code?.trim();
  if (!currencyCode) {
    violations.push("currencyCode");
  }

  // 3. Customer country code must resolve to a valid ISO 3166-1 alpha-2
  //    code AWS accepts. Source order: deal-level override
  //    (`ace_country_code`) -> primary associated company
  //    (`hs_country_code`). The value is normalised (e.g. "United
  //    States" -> "US") because the field is free-text and AWS rejects
  //    non-enum values with `INVALID_ENUM_VALUE`. A present-but-
  //    unresolvable value (e.g. "Atlantis") is treated the same as
  //    missing. The normalised code also drives the US-only state rule
  //    below — without normalisation, "United States" would silently
  //    skip that check and then fail at AWS submission.
  const rawCountry =
    deal.ace_country_code?.trim() ||
    company?.hs_country_code?.trim() ||
    "";
  const normalizedCountry = normalizeCountryCode(rawCountry);
  if (!normalizedCountry) {
    violations.push("countryCode");
  }

  // 4. State must be set when country is US. ACE requires
  //    StateOrRegion for SubmitOpportunity in the US, but silently
  //    drops the value for non-US addresses (Ireland, etc.), so
  //    demanding it from operators outside the US would be busy-work
  //    that doesn't change ACE's behaviour. Same source order as the
  //    other customer fields: deal override → company.
  if (normalizedCountry === "US") {
    const stateOrRegion =
      deal.ace_state_or_region?.trim() ||
      company?.state?.trim() ||
      "";
    if (!stateOrRegion) {
      violations.push("stateOrRegion");
    }
  }

  // 5. Postal code must be set somewhere — required by ACE's
  //    SubmitOpportunity but accepted by CreateOpportunity, so we
  //    surface it up-front. Same fallback as the other fields.
  const postalCode =
    deal.ace_postal_code?.trim() ||
    company?.zip?.trim() ||
    "";
  if (!postalCode) {
    violations.push("postalCode");
  }

  // 5b. Website URL — AWS requires Customer.Account.WebsiteUrl. Source
  //     order mirrors the payload builder: deal `ace_website_url`, then
  //     the associated company's `website` / `domain`.
  const websiteUrl =
    deal.ace_website_url?.trim() ||
    company?.website?.trim() ||
    company?.domain?.trim() ||
    "";
  if (!websiteUrl) {
    violations.push("websiteUrl");
  }

  // 6. description trimmed length ≥ 20 (HubSpot's built-in deal
  //    description; sent to ACE as `Project.CustomerBusinessProblem`).
  const description = deal.description ?? "";
  if (description.trim().length < MIN_DESCRIPTION_LENGTH) {
    violations.push("descriptionLength");
  }

  // 6b. Industry — AWS requires Customer.Account.Industry (no silent
  //     default anymore). Sourced from the deal's `ace_industry`.
  const industry = deal.ace_industry?.trim();
  if (!industry) {
    violations.push("industry");
  }

  // 7. dealstage must map to a known ACE stage via stageMapping.
  const stageId = deal.dealstage?.trim();
  const mappedStage = stageId
    ? forwardMap(stageId, stageMapping)
    : undefined;
  if (!stageId || mappedStage === undefined) {
    violations.push("stageMappable");
  }

  // 8. The deal must declare WHAT's being sold via one of two paths:
  //    a) `ace_solutions` lists at least one Partner Central Solution
  //       Offering ID matching `S-[0-9]+` — each ID is passed to
  //       AssociateOpportunity (one call per ID).
  //    b) `ace_other_solution_description` is non-blank — the deal
  //       rides on `Project.OtherSolutionDescription`, no
  //       AssociateOpportunity needed.
  //
  //    The literal "Other" (any non-`S-…` string) is dropped from
  //    `ace_solutions` because AWS rejects it with `INVALID_VALUE`.
  //    A partner using the UI's "Other" path satisfies the rule via
  //    `ace_other_solution_description`.
  const hasSolutionId = parseSolutionIds(deal.ace_solutions).length > 0;
  const hasOtherDescription =
    (deal.ace_other_solution_description?.trim().length ?? 0) > 0;
  if (!hasSolutionId && !hasOtherDescription) {
    violations.push("solutions");
  }

  // 9. ace_closed_lost_reason must be set when the mapped ACE stage is
  //    Closed Lost. ACE requires `LifeCycle.ClosedLostReason` on any
  //    update where Stage is "Closed Lost"; sending the payload without
  //    it returns ValidationException. The HubSpot picklist's allowed
  //    values mirror the ACE enum (see scripts/setup_ace_bidirectional_fields.py).
  if (mappedStage === "Closed Lost") {
    const reason = deal["ace_closed_lost_reason"]?.trim();
    if (!reason) {
      violations.push("closedLostReason");
    }
  }

  return violations;
}

/**
 * Parse the `;`-separated `ace_solutions` deal property into a
 * deduplicated, trimmed list of Partner Central Solution Offering IDs.
 *
 * Only entries matching the AWS-documented pattern `S-[0-9]+` are kept.
 * Empty / whitespace-only entries are dropped. The literal "Other" and
 * any other free-text value is dropped here too — those are partner
 * mistakes (or HubSpot-side picklist artefacts) that AWS would reject
 * with `INVALID_VALUE` if forwarded. Free-text "Other" descriptions
 * belong in the separate `ace_other_solution_description` deal field
 * which maps to `Project.OtherSolutionDescription`.
 *
 * Order is preserved so callers can rely on the first ID being the
 * "primary" solution — useful when downstream logic needs a
 * single-solution fallback.
 */
const SOLUTION_ID_PATTERN = /^S-\d+$/;

export function parseSolutionIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Accept any of `;`, `,`, or whitespace as separators. HubSpot
  // multi-select pickists produce `;`-separated values natively;
  // free-text fields where the rep types multiple IDs commonly
  // use commas or spaces. Accepting all three keeps the rep
  // experience forgiving without changing the on-wire shape sent
  // to AWS (each ID becomes its own AssociateOpportunity call).
  for (const part of raw.split(/[;,\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!SOLUTION_ID_PATTERN.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Parse the `;`-separated `ace_aws_products` deal property into a
 * deduplicated, trimmed list of AWS Product Codes (e.g.
 * `AmazonEC2P5`, `S3IntelligentTiering`, `AWSPrivateCA`).
 *
 * The AWS Product Code surface is documented in
 * `aws-samples/partner-crm-integration-samples/resources/SampleAWSProducts.csv`.
 * Codes are alphanumeric tokens with occasional dots / spaces (e.g.
 * `CODE.AWS`, `Amazon GameCast`), so we deliberately avoid a strict
 * regex like `^[A-Za-z0-9]+$` — it would reject legitimate values.
 * Instead we filter out only the empty / whitespace-only tokens and
 * trust AWS's `INVALID_VALUE` rejection at AssociateOpportunity time
 * for malformed entries. HubSpot multi-checkbox picklists are the
 * recommended deal-property type so reps pick from a curated list of
 * valid codes rather than typing.
 *
 * Order-preserving + dedup mirrors `parseSolutionIds` so downstream
 * logic that walks the array sees a stable order.
 */
export function parseAwsProductIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[;,]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
