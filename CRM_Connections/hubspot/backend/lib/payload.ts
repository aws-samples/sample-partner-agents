/**
 * ACE Opportunity payload builders (Requirements 2.5, 2.6, 3.2, 3.3).
 *
 * `buildCreatePayload` and `buildUpdatePayload` translate a HubSpot deal and
 * its primary associated company into the minimum ACE Partner Central Sandbox
 * payload surface described in design.md §Data Models → Payload mapping table.
 *
 * Intentional v1 simplifications (Python batch sync fills these in later):
 *   - `Customer.Account.Industry` is hardcoded to `"Software and Internet"`.
 *     The TS port does not carry `INDUSTRY_TO_AWS`.
 *   - `OpportunityType` is hardcoded to `"Net New Business"` — no port of
 *     `DEALTYPE_TO_ACE_OPPORTUNITY_TYPE`.
 *   - `Origin`, `Marketing`, and `PrimaryNeedsFromAws` are hardcoded to the
 *     same constants the Python sync uses.
 *   - Create always starts at `"Qualified"` regardless of the deal's current
 *     stage (matches the Python batch's create-path behaviour).
 *   - Update path forwards the stage-mapped value as-is; stage-regression
 *     detection is left to the Python batch.
 *   - No contacts / OpportunityTeam population — those are optional in ACE and
 *     are filled in by the Python batch's next run.
 *
 * The caller MUST have validated preconditions via
 * `validatePreconditions` before invoking `buildCreatePayload` or
 * `buildUpdatePayload`; the builders assume `amount`, `closedate`,
 * `hs_country_code`, description length, and stage-mappability have all
 * already passed. `buildUpdatePayload` throws if the deal's current
 * `dealstage` cannot be forward-mapped, as a last-line safety check.
 */

import {
  ACE_CATALOG,
  DEFAULT_ACE_USE_CASE,
  DEFAULT_MARKETING_SOURCE,
  DEFAULT_ACE_INDUSTRY,
  DEFAULT_ACE_OPPORTUNITY_TYPE,
  DEFAULT_ACE_PRIMARY_NEED_FROM_AWS,
  DEFAULT_ACE_DELIVERY_MODEL,
  DEFAULT_ACE_CURRENCY_CODE,
  DEFAULT_ACE_AWS_FUNDING_USED,
  DEFAULT_ACE_NATIONAL_SECURITY,
} from "./config";
import type { AppConfig } from "./config";
import type { AceStage, StageMapping } from "./stage-mapping";
import { forwardMap } from "./stage-mapping";
import { generateClientToken } from "./client-token";
import type { CompanyProps, DealProps } from "./preconditions";
import { normalizeCountryCode } from "./country";

/**
 * Generic precedence resolver for an ACE-payload override:
 *   1. Per-deal HubSpot property (`deal[dealKey]`)
 *   2. Env-level secret (`config[configKey]`, sourced from `ACE_DEFAULT_*`)
 *   3. Hardcoded fallback (`fallback`)
 *
 * Empty strings and whitespace-only values count as "absent" so missing
 * HubSpot properties fall through cleanly.
 */
function resolveOverride<K extends keyof AppConfig>(
  deal: DealProps,
  dealKey: string,
  config: Pick<AppConfig, K> | Record<string, never>,
  configKey: K,
  fallback: string
): string {
  const dealVal = deal[dealKey]?.trim();
  if (dealVal && dealVal.length > 0) return dealVal;
  const cfgVal = (config as Record<string, unknown>)[configKey as string];
  if (typeof cfgVal === "string" && cfgVal.trim().length > 0) {
    return cfgVal.trim();
  }
  return fallback;
}

/**
 * Multi-select variant of `resolveOverride`. HubSpot serialises
 * checkbox enumerations as `;`-separated strings (e.g.
 * `"SaaS or PaaS;Managed Services"`). We split, trim, and drop empty
 * tokens. Same precedence as the singleton helper:
 *   1. Per-deal HubSpot multi-select → array of trimmed values
 *   2. Env-level secret (also `;`-separated when set)
 *   3. Hardcoded fallback array
 *
 * The fallback array is returned by reference; callers must not mutate.
 */
function resolveMultiOverride<K extends keyof AppConfig>(
  deal: DealProps,
  dealKey: string,
  config: Pick<AppConfig, K> | Record<string, never>,
  configKey: K,
  fallback: readonly string[]
): string[] {
  const split = (raw: string): string[] =>
    raw
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const dealRaw = deal[dealKey]?.trim();
  if (dealRaw && dealRaw.length > 0) {
    const parts = split(dealRaw);
    if (parts.length > 0) return parts;
  }
  const cfgRaw = (config as Record<string, unknown>)[configKey as string];
  if (typeof cfgRaw === "string" && cfgRaw.trim().length > 0) {
    const parts = split(cfgRaw);
    if (parts.length > 0) return parts;
  }
  return [...fallback];
}

/**
 * Resolve an OPTIONAL override that must be omitted entirely when
 * neither the per-deal property nor the env-default is set. Used for
 * fields ACE rejects when sent as empty strings (e.g. enum-validated
 * `Project.CompetitorName`, regex-validated `Customer.Account.Duns`).
 *
 * Returns `undefined` when both sources are absent / blank, signalling
 * to the caller "do not include this key in the payload at all".
 *
 * Same precedence as `resolveOverride`:
 *   1. Per-deal HubSpot property
 *   2. Env-level secret
 *   3. `undefined` (omit)
 */
function resolveOptionalOverride<K extends keyof AppConfig>(
  deal: DealProps,
  dealKey: string,
  config: Pick<AppConfig, K> | Record<string, never>,
  configKey: K
): string | undefined {
  const dealVal = deal[dealKey]?.trim();
  if (dealVal && dealVal.length > 0) return dealVal;
  const cfgVal = (config as Record<string, unknown>)[configKey as string];
  if (typeof cfgVal === "string" && cfgVal.trim().length > 0) {
    return cfgVal.trim();
  }
  return undefined;
}

/**
 * Multi-select OPTIONAL override. Returns `undefined` when both
 * sources are absent / blank, so callers can omit the key entirely.
 * Mirrors `resolveOptionalOverride` for `;`-separated multi-selects
 * like `Project.ApnPrograms`.
 */
function resolveOptionalMultiOverride<K extends keyof AppConfig>(
  deal: DealProps,
  dealKey: string,
  config: Pick<AppConfig, K> | Record<string, never>,
  configKey: K
): string[] | undefined {
  const split = (raw: string): string[] =>
    raw
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const dealRaw = deal[dealKey]?.trim();
  if (dealRaw && dealRaw.length > 0) {
    const parts = split(dealRaw);
    if (parts.length > 0) return parts;
  }
  const cfgRaw = (config as Record<string, unknown>)[configKey as string];
  if (typeof cfgRaw === "string" && cfgRaw.trim().length > 0) {
    const parts = split(cfgRaw);
    if (parts.length > 0) return parts;
  }
  return undefined;
}

/**
 * Subset of `AppConfig` carrying every per-call ACE-payload override.
 * Used as the typed shape for `config` parameters in the payload
 * builders so callers see exactly which fields matter without having
 * to thread the full AppConfig through.
 */
export type AcePayloadConfig = Pick<
  AppConfig,
  | "aceDefaultUseCase"
  | "aceDefaultMarketingSource"
  | "aceDefaultIndustry"
  | "aceDefaultOpportunityType"
  | "aceDefaultPrimaryNeedFromAws"
  | "aceDefaultDeliveryModel"
  | "aceDefaultCurrencyCode"
  | "aceDefaultAwsFundingUsed"
  | "aceDefaultInvolvementType"
  | "aceDefaultVisibility"
  | "aceDefaultNationalSecurity"
  | "aceDefaultCompetitorName"
  | "aceDefaultAwsPartition"
  | "aceDefaultApnPrograms"
  | "aceDefaultSalesActivities"
>;

/**
 * Translate the operator-friendly Yes/No surface into ACE's
 * `Marketing.Source` enum:
 *   - `"Yes"` → `"Marketing Activity"` (the ACE wire value)
 *   - `"No"`  → `"None"`
 *
 * Pass-through for the legacy ACE-native values (`"Marketing
 * Activity"` / `"None"`) so older deals that still hold the literal
 * enum value keep working without a backfill. Any other input is
 * coerced to `"None"` (the safe default — ACE rejects unknown
 * values).
 */
function translateMarketingSource(value: string): string {
  const v = value.trim();
  if (v === "Yes" || v === "Marketing Activity") return "Marketing Activity";
  if (v === "No" || v === "None") return "None";
  return "None";
}

/**
 * Resolve `Marketing.Source` using the per-deal property →
 * env-level secret → hard-coded default precedence, then translate
 * the surface value into ACE's enum via `translateMarketingSource`.
 *
 * Operators see a Yes/No picklist labelled "Is Opportunity from
 * Marketing Activity?" — the wire value sent to ACE is the standard
 * `"Marketing Activity"` / `"None"` pair.
 */
function resolveMarketingSource(
  deal: DealProps,
  config: AcePayloadConfig | Record<string, never>
): string | undefined {
  const raw = resolveOptionalOverride(
    deal,
    "ace_marketing_source",
    config,
    "aceDefaultMarketingSource"
  );
  if (!raw) return undefined;
  return translateMarketingSource(raw);
}

/**
 * Build the `Marketing` block honouring ACE's mutual-exclusion rules:
 *   - When `Source === "None"`, no other fields may be present.
 *   - When `Source === "Marketing Activity"`, `AwsFundingUsed` must be set.
 *
 * The default is `"None"` because the "Marketing Activity" path
 * requires a `CampaignName` we don't currently surface.
 *
 * `AwsFundingUsed` is itself overridable via the deal property
 * `ace_aws_funding_used` or the secret `ACE_DEFAULT_AWS_FUNDING_USED`.
 */
function buildMarketing(
  deal: DealProps,
  config: AcePayloadConfig | Record<string, never>
):
  | {
      Source: string;
      AwsFundingUsed?: string;
      CampaignName?: string;
      UseCases?: string[];
      Channels?: string[];
    }
  | undefined {
  const source = resolveMarketingSource(deal, config);
  // No marketing source set by the rep → omit Marketing entirely (no
  // "None" default).
  if (!source) return undefined;
  if (source === "None") {
    return { Source: source };
  }
  const out: {
    Source: string;
    AwsFundingUsed?: string;
    CampaignName?: string;
    UseCases?: string[];
    Channels?: string[];
  } = { Source: source };
  // AwsFundingUsed only when the rep set it (no "No" default).
  const fundingUsed = resolveOptionalOverride(
    deal,
    "ace_aws_funding_used",
    config,
    "aceDefaultAwsFundingUsed"
  );
  if (fundingUsed) out.AwsFundingUsed = fundingUsed;

  // Optional Marketing.* sub-fields. Only attached when set on the
  // deal so we don't trip ACE's `INVALID_ENUM_VALUE` / empty-array
  // checks. Use cases and channels are HubSpot multi-selects
  // (`;`-separated strings) — split on `;`, trim, drop empties.
  const campaignName = deal.ace_marketing_campaign_name?.trim();
  if (campaignName && campaignName.length > 0) {
    out.CampaignName = campaignName;
  }
  const useCases = splitMulti(deal.ace_marketing_use_cases);
  if (useCases.length > 0) {
    out.UseCases = useCases;
  }
  const channels = splitMulti(deal.ace_marketing_channels);
  if (channels.length > 0) {
    out.Channels = channels;
  }
  return out;
}

/**
 * Split a HubSpot multi-select string (`a;b;c`) into a trimmed,
 * non-empty array. Returns `[]` when the input is missing or only
 * whitespace.
 */
function splitMulti(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Stage → canonical NextSteps string. Port of `src/config.py:STAGE_TO_NEXT_STEPS`
 * with one entry per ACE stage so every forward-mapped stage has a NextSteps
 * value without needing a fallback.
 */
export const STAGE_TO_NEXT_STEPS: Record<AceStage, string> = {
  Qualified: "Initial qualification — discovery and requirements gathering",
  "Technical Validation": "Technical proof of value in progress",
  "Business Validation": "Business case and commercial terms under review",
  Committed: "Contract negotiations and final approvals",
  Launched: "Customer onboarded — solution deployed",
  "Closed Lost": "Opportunity closed",
};

/**
 * Stage → cumulative SalesActivities. Port of
 * `src/config.py:STAGE_TO_SALES_ACTIVITIES`. ACE expects activities to
 * accumulate as the opportunity progresses (e.g. a `Committed` opp must
 * still have the earlier "Initialized discussions" activity attached),
 * so each stage's array is a strict superset of the prior stage's.
 *
 * `Closed Lost` is intentionally absent — the Python implementation
 * doesn't define it either, and the caller falls back to the
 * `Qualified` set when the stage isn't in the map.
 */
export const STAGE_TO_SALES_ACTIVITIES: Partial<Record<AceStage, string[]>> = {
  Qualified: [
    "Initialized discussions with customer",
    "Customer has shown interest in solution",
  ],
  "Technical Validation": [
    "Initialized discussions with customer",
    "Customer has shown interest in solution",
    "Conducted POC / Demo",
  ],
  "Business Validation": [
    "Initialized discussions with customer",
    "Customer has shown interest in solution",
    "Conducted POC / Demo",
    "In evaluation / planning stage",
  ],
  Committed: [
    "Initialized discussions with customer",
    "Customer has shown interest in solution",
    "Conducted POC / Demo",
    "In evaluation / planning stage",
    "Agreed on solution to Business Problem",
  ],
  Launched: [
    "Initialized discussions with customer",
    "Customer has shown interest in solution",
    "Conducted POC / Demo",
    "In evaluation / planning stage",
    "Agreed on solution to Business Problem",
  ],
};

const DEFAULT_SALES_ACTIVITIES = STAGE_TO_SALES_ACTIVITIES.Qualified as string[];

/** New opportunities always start at Qualified (mirrors the Python batch). */
const CREATE_STAGE: AceStage = "Qualified";

/** Default project title used when `deal.dealname` is empty or whitespace. */
const DEFAULT_PROJECT_TITLE = "Partner Opportunity";

/** Default contract term used to derive monthly spend when the deal has none. */
const DEFAULT_CONTRACT_MONTHS = 12;

/**
 * Normalize `deal.closedate` (ISO8601 string or epoch-ms numeric string) to a
 * `YYYY-MM-DD` date for `LifeCycle.TargetCloseDate`. Returns `undefined` when
 * the input is missing or cannot be parsed.
 */
function parseCloseDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // Already an ISO date-like prefix — take the first ten characters as-is.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Epoch-ms fallback — HubSpot historically returned numeric timestamps.
  const n = Number(s);
  if (Number.isFinite(n)) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Best-effort truncation so we still emit *something* rather than crashing.
  return s.slice(0, 10);
}

/**
 * Compute the monthly spend string from `deal.amount` (total) and
 * `contract_term__months_` (denominator, defaults to 12). Formatted as an
 * integer when the result is whole, otherwise rounded to two decimal places.
 * Returns `"0"` when `amount` is missing or non-numeric — the create-path
 * precondition (`amount > 0`) already guards against that case in practice.
 */
function computeMonthlyAmount(
  amountRaw: string | undefined,
  contractMonthsRaw: string | undefined
): string {
  const amount = amountRaw !== undefined ? Number(amountRaw) : NaN;
  let contractMonths =
    contractMonthsRaw !== undefined ? Number(contractMonthsRaw) : DEFAULT_CONTRACT_MONTHS;
  if (!Number.isFinite(contractMonths) || contractMonths <= 0) {
    contractMonths = DEFAULT_CONTRACT_MONTHS;
  }
  if (!Number.isFinite(amount)) return "0";
  const monthly = amount / contractMonths;
  if (monthly === Math.floor(monthly)) return String(Math.floor(monthly));
  return monthly.toFixed(2);
}

/**
 * Build `Customer.Account.WebsiteUrl`. Prefer an explicit `website` value
 * (prepending `https://` when it lacks a scheme) and fall back to
 * `https://<domain>`. Returns `undefined` when neither is populated.
 */
function buildWebsiteUrl(company: CompanyProps): string | undefined {
  if (!company) return undefined;
  const website = company.website?.trim();
  if (website) {
    return /^https?:\/\//.test(website) ? website : `https://${website}`;
  }
  const domain = company.domain?.trim();
  if (domain) return `https://${domain}`;
  return undefined;
}

/**
 * Build `Customer.Account` with its optional `Address` sub-object. The
 * address is only attached when at least one address field is populated, so
 * payloads for companies with zero address data stay compact.
 *
 * Editable per-deal overrides:
 *   - `ace_aws_account_id` (regex `([0-9]{12}|\w{1,12})`) → `AwsAccountId`
 *   - `ace_duns`           (regex `[0-9]{9}`)             → `Duns`
 *   - `ace_street_address` (free-text)                    → `Address.StreetAddress`
 *
 * All three are OMITTED when blank — ACE rejects empty strings on the
 * regex-validated fields with `INVALID_STRING_FORMAT`.
 */
function buildCustomerAccount(
  company: CompanyProps,
  deal: DealProps,
  config: AcePayloadConfig | Record<string, never>
): Record<string, unknown> {
  // Industry is AWS-required (enforced by the `industry` precondition);
  // sourced from the deal's ace_industry (or env). No "Software and
  // Internet" default.
  const industry = resolveOptionalOverride(
    deal,
    "ace_industry",
    config,
    "aceDefaultIndustry"
  );

  // Source order for customer-info fields: deal-level override first
  // (populated either manually or by a HubSpot workflow that copies
  // values from the associated company on association), then the
  // primary associated company. Deal-level wins so operators can
  // tweak per-deal without changing the company record, and so deals
  // reverse-synced from AWS that haven't yet been associated with a
  // HubSpot company can still Share.
  const companyName =
    deal.ace_company_name?.trim() || company?.name?.trim() || "";
  const account: Record<string, unknown> = {
    CompanyName: companyName,
  };
  if (industry) account.Industry = industry;

  // Per-deal overrides for the regex-validated identifiers. Both must
  // be omitted entirely when blank — ACE rejects empty strings with
  // `INVALID_STRING_FORMAT`.
  const awsAccountId = deal["ace_aws_account_id"]?.trim();
  if (awsAccountId && awsAccountId.length > 0) {
    account.AwsAccountId = awsAccountId;
  }
  const duns = deal["ace_duns"]?.trim();
  if (duns && duns.length > 0) {
    account.Duns = duns;
  }

  const address: Record<string, string> = {};
  // Normalise the country to an ISO 3166-1 alpha-2 code (e.g. "United
  // States" -> "US") so AWS accepts it. Fall back to the raw value when
  // it can't be resolved — the create-path precondition already blocks
  // unresolvable countries, and AWS returns a clear `INVALID_ENUM_VALUE`
  // for anything that slips through (e.g. the update path).
  const rawCc =
    deal.ace_country_code?.trim() ||
    company?.hs_country_code?.trim() ||
    "";
  const cc = normalizeCountryCode(rawCc) ?? rawCc;
  if (cc) address.CountryCode = cc;
  const city = deal.ace_city?.trim() || company?.city?.trim() || "";
  if (city) address.City = city;
  const zip =
    deal.ace_postal_code?.trim() || company?.zip?.trim() || "";
  if (zip) address.PostalCode = zip;
  const state =
    deal.ace_state_or_region?.trim() ||
    company?.state?.trim() ||
    "";
  if (state) address.StateOrRegion = state;
  // Per-deal override for street address — falls back to absent (HubSpot
  // companies don't carry a street-address field by default).
  const street = deal["ace_street_address"]?.trim();
  if (street && street.length > 0) address.StreetAddress = street;
  if (Object.keys(address).length > 0) account.Address = address;

  // Website URL: deal-level override takes priority, then the
  // company's `domain` / `website` / `hs_company_website_url` fields
  // (handled by `buildWebsiteUrl`).
  const dealWebsite = deal.ace_website_url?.trim();
  if (dealWebsite) {
    account.WebsiteUrl = normaliseWebsiteUrl(dealWebsite);
  } else {
    const url = buildWebsiteUrl(company);
    if (url) account.WebsiteUrl = url;
  }
  return account;
}

/**
 * Coerce a free-text URL value into ACE's expected format. ACE
 * accepts `https://example.com` and bare hostnames (`example.com`);
 * we add `https://` when missing so partner-entered values like
 * `acme.com` round-trip cleanly. Trailing slashes are preserved
 * (ACE doesn't care).
 */
function normaliseWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Resolve the value sent for `Project.ExpectedCustomerSpend[*].TargetCompany`.
 *
 * AWS validates this field against `(?s).{1,80}` — a non-empty string
 * up to 80 chars. An empty string fails with `INVALID_STRING_FORMAT`.
 * Source precedence mirrors the rest of the customer-info fields:
 *
 *   1. The deal's primary associated HubSpot company name.
 *   2. The deal-level fallback `ace_company_name` (populated by Refresh
 *      from AWS, or by the partner-side workflow on association).
 *   3. The literal string `"AWS"` — last-resort fallback. This is what
 *      Partner Central displays as the default when no customer is
 *      named, and it satisfies the regex without making the deal look
 *      misleading. Better than failing the Share with a cryptic
 *      `INVALID_STRING_FORMAT` for a deal that has otherwise been
 *      legitimately reverse-synced from AWS.
 */
function resolveTargetCompany(
  company: CompanyProps,
  deal: DealProps
): string {
  const fromCompany = company?.name?.trim();
  if (fromCompany && fromCompany.length > 0) return fromCompany.slice(0, 80);
  const fromDeal = deal.ace_company_name?.trim();
  if (fromDeal && fromDeal.length > 0) return fromDeal.slice(0, 80);
  return "AWS";
}

/**
 * Build the editable subset of `Project.*` that's shared between
 * Create and Update paths. The required fields (Title, problem,
 * delivery, use case, spend, sales activities) are owned by the
 * caller; this helper attaches the additional editable fields:
 *
 *   - `Project.AdditionalComments`     (text override)
 *   - `Project.OtherCompetitorNames`   (text override)
 *   - `Project.OtherSolutionDescription` (text override)
 *   - `Project.CompetitorName`         (enum picklist override; OMIT when blank)
 *   - `Project.AwsPartition`           (enum picklist override; OMIT when blank)
 *   - `Project.ApnPrograms`            (multi-select array; OMIT when empty)
 *
 * Mutates `project` in place and returns it for chaining.
 *
 * Note: ACE rejects empty strings on the enum-validated fields
 * (`CompetitorName`, `AwsPartition`) with `INVALID_ENUM_VALUE`, so
 * those are gated behind `resolveOptionalOverride` which returns
 * `undefined` when the source is blank.
 */
function attachEditableProjectFields(
  project: Record<string, unknown>,
  deal: DealProps,
  config: AcePayloadConfig | Record<string, never>
): Record<string, unknown> {
  const additionalComments = deal["ace_additional_comments"]?.trim();
  if (additionalComments && additionalComments.length > 0) {
    project.AdditionalComments = additionalComments;
  }
  const otherCompetitor = deal["ace_other_competitor_names"]?.trim();
  if (otherCompetitor && otherCompetitor.length > 0) {
    project.OtherCompetitorNames = otherCompetitor;
  }
  const otherSolution = deal["ace_other_solution_description"]?.trim();
  if (otherSolution && otherSolution.length > 0) {
    project.OtherSolutionDescription = otherSolution;
  }
  const competitor = resolveOptionalOverride(
    deal,
    "ace_competitor_name",
    config,
    "aceDefaultCompetitorName"
  );
  if (competitor) project.CompetitorName = competitor;
  const partition = resolveOptionalOverride(
    deal,
    "ace_aws_partition",
    config,
    "aceDefaultAwsPartition"
  );
  if (partition) project.AwsPartition = partition;
  const apnPrograms = resolveOptionalMultiOverride(
    deal,
    "ace_apn_programs",
    config,
    "aceDefaultApnPrograms"
  );
  if (apnPrograms && apnPrograms.length > 0) {
    project.ApnPrograms = apnPrograms;
  }
  return project;
}

/**
 * Build the editable subset of `LifeCycle.*` that goes on the wire.
 * `LifeCycle.ClosedLostReason` is required ONLY when stage is
 * `Closed Lost`; ACE rejects the field outside that stage. Everything
 * else (`ReviewStatus`, `ReviewComments`, `ReviewStatusReason`,
 * `NextStepsHistory`) is read-only on update and intentionally absent.
 */
function attachEditableLifeCycleFields(
  lifeCycle: Record<string, unknown>,
  deal: DealProps,
  stage: string
): Record<string, unknown> {
  if (stage === "Closed Lost") {
    const reason = deal["ace_closed_lost_reason"]?.trim();
    if (reason && reason.length > 0) {
      lifeCycle.ClosedLostReason = reason;
    }
  }
  return lifeCycle;
}

/**
 * Shape of a `CreateOpportunity` input we send to ACE Partner Central. We
 * type it as a plain structural object rather than importing the SDK's
 * `CreateOpportunityInput` so the pure logic layer has zero SDK dependency —
 * the ace.ts wrapper is responsible for the final cast.
 */
export type CreatePayload = {
  Catalog: typeof ACE_CATALOG;
  ClientToken: string;
  Customer: { Account: Record<string, unknown> };
  Project: Record<string, unknown>;
  LifeCycle: Record<string, unknown>;
  OpportunityType?: string;
  Marketing?: { Source: string; AwsFundingUsed?: string };
  PrimaryNeedsFromAws?: string[];
  NationalSecurity?: string;
  /**
   * Partner-side identifier for the opportunity. We use the HubSpot
   * deal ID stringified. This field is REQUIRED for ACE to populate
   * `LifeCycle.ReviewStatus = "Pending Submission"` on Create —
   * without it, the opportunity is created in a half-initialised
   * state that blocks `StartEngagementFromOpportunityTask` later
   * (the embedded `SubmitOpportunity` step rejects with "Only
   * Pending Submission or action required opportunities can be
   * submitted"). Verified empirically against AWS Partner Central
   * Sandbox on 2026-05-15.
   */
  PartnerOpportunityIdentifier: string;
};

/** Shape of an `UpdateOpportunity` input.
 *
 * Despite the name, ACE's update API is NOT a JSON-merge-patch — it
 * expects the same business-required fields as Create on every call.
 * Omitting `OpportunityType`, `PrimaryNeedsFromAws`, `Marketing`, etc.
 * causes ACE to return `REQUIRED_FIELD_MISSING` (and worse, treats the
 * omitted `PrimaryNeedsFromAws` as "switching to For Visibility only",
 * which it rejects). So we send the full create-equivalent block plus
 * the optimistic-concurrency `LastModifiedDate` and `Identifier`.
 */
export type UpdatePayload = {
  Catalog: typeof ACE_CATALOG;
  Identifier: string;
  LastModifiedDate: string;
  LifeCycle: Record<string, unknown>;
  Project: Record<string, unknown>;
  Customer: { Account: Record<string, unknown> };
  OpportunityType?: string;
  Marketing?: { Source: string; AwsFundingUsed?: string };
  PrimaryNeedsFromAws?: string[];
  NationalSecurity?: string;
  PartnerOpportunityIdentifier: string;
  /**
   * Optional SoftwareRevenue passthrough. Present only when the opp
   * is in a locked ReviewStatus AND the caller supplied AWS's existing
   * value via `options.lockedSoftwareRevenue`. Absent otherwise.
   */
  SoftwareRevenue?: unknown;
};

/**
 * Build a full `CreateOpportunity` payload for the Share flow's create
 * branch. The caller passes the HubSpot deal ID separately so the derived
 * `ClientToken` matches the Python batch sync byte-for-byte.
 *
 * @param dealId  HubSpot deal ID — feeds `generateClientToken` for idempotency.
 * @param deal    HubSpot deal properties (already precondition-validated).
 * @param company Primary associated company's properties (may be sparse).
 * @param config  AppConfig — used here for `aceDefaultUseCase` and may carry
 *                future per-env selectors.
 */
export function buildCreatePayload(
  dealId: number,
  deal: DealProps,
  company: CompanyProps,
  stageMapping: StageMapping,
  config: AcePayloadConfig | Record<string, never>
): CreatePayload {
  const monthly = computeMonthlyAmount(deal.amount, deal.contract_term__months_);
  // Title comes solely from the deal name (enforced by the `dealName`
  // precondition — no canned "Partner Opportunity" default).
  const title = deal.dealname?.trim() ?? "";
  const closeDate = parseCloseDate(deal.closedate);

  // Create stage reflects the deal's OWN mapped stage (the
  // `stageMappable` precondition guarantees it maps) — no hard-coded
  // "Qualified". Defensive throw mirrors buildUpdatePayload.
  const mappedStage = deal.dealstage
    ? forwardMap(deal.dealstage.trim(), stageMapping)
    : undefined;
  if (!mappedStage) {
    throw new Error(
      `Cannot build create payload: dealstage "${deal.dealstage ?? ""}" does not map to an ACE stage`
    );
  }

  // Currency is required by AWS (ExpectedCustomerSpend.CurrencyCode) and
  // enforced by the `currencyCode` precondition; sourced from the deal
  // (or env). No "USD" default.
  const currencyCode = resolveOptionalOverride(
    deal,
    "ace_currency_code",
    config,
    "aceDefaultCurrencyCode"
  );

  const project: Record<string, unknown> = {
    Title: title,
    CustomerBusinessProblem: deal.description ?? "",
    ExpectedCustomerSpend: [
      {
        Amount: monthly,
        ...(currencyCode ? { CurrencyCode: currencyCode } : {}),
        // Frequency is structural: the amount is computed as a MONTHLY
        // figure (total / contract months), so the unit is fixed.
        Frequency: "Monthly",
        TargetCompany: resolveTargetCompany(company, deal),
      },
    ],
  };
  // DeliveryModels + CustomerUseCase are submit-required (gated via
  // SUBMISSION_REQUIRED_FIELDS) so they're present when submitting; for a
  // draft they may be absent — omit rather than send a default.
  const deliveryModels = resolveOptionalMultiOverride(
    deal,
    "ace_delivery_model",
    config,
    "aceDefaultDeliveryModel"
  );
  if (deliveryModels) project.DeliveryModels = deliveryModels;
  const customerUseCase = resolveOptionalOverride(
    deal,
    "ace_customer_use_case",
    config,
    "aceDefaultUseCase"
  );
  if (customerUseCase) project.CustomerUseCase = customerUseCase;
  // SalesActivities is optional at AWS — omit when blank (no canned
  // "Initialized discussions…" default).
  const salesActivities = resolveOptionalMultiOverride(
    deal,
    "ace_sales_activities",
    config,
    "aceDefaultSalesActivities"
  );
  if (salesActivities) project.SalesActivities = salesActivities;

  // Attach the additional editable Project fields (CompetitorName,
  // ApnPrograms, AwsPartition, OtherCompetitorNames,
  // OtherSolutionDescription, AdditionalComments). All are absent
  // when blank — ACE rejects empty strings on the enum-validated ones.
  attachEditableProjectFields(project, deal, config);

  // NextSteps maps to hs_next_step; AWS does not require it, so omit when
  // blank (no canned per-stage default).
  const nextStepsOverride = deal["hs_next_step"]?.trim();
  const lifeCycle: Record<string, unknown> = { Stage: mappedStage };
  if (nextStepsOverride) lifeCycle.NextSteps = nextStepsOverride;
  if (closeDate) lifeCycle.TargetCloseDate = closeDate;
  attachEditableLifeCycleFields(lifeCycle, deal, mappedStage);

  const payload: CreatePayload = {
    Catalog: ACE_CATALOG,
    ClientToken: generateClientToken(dealId),
    Customer: { Account: buildCustomerAccount(company, deal, config) },
    Project: project,
    LifeCycle: lifeCycle,
    // The dealId stringified satisfies ACE's reconciliation requirement
    // and makes the opportunity submittable.
    PartnerOpportunityIdentifier: String(dealId),
  };

  // Optional top-level fields — AWS requires none of these, so we send
  // them only when the rep set the corresponding deal property (or an env
  // default is configured). No hard-coded values. `Origin` is dropped
  // entirely (was always "Partner Referral").
  const opportunityType = resolveOptionalOverride(
    deal,
    "ace_opportunity_type",
    config,
    "aceDefaultOpportunityType"
  );
  if (opportunityType) payload.OpportunityType = opportunityType;
  const marketing = buildMarketing(deal, config);
  if (marketing) payload.Marketing = marketing;
  // PrimaryNeedsFromAws is submit-required (gated) but optional at create;
  // present when submitting, omitted for a bare draft.
  const primaryNeeds = resolveOptionalMultiOverride(
    deal,
    "ace_primary_need_from_aws",
    config,
    "aceDefaultPrimaryNeedFromAws"
  );
  if (primaryNeeds) payload.PrimaryNeedsFromAws = primaryNeeds;
  const nationalSecurity = resolveOptionalOverride(
    deal,
    "ace_national_security",
    config,
    "aceDefaultNationalSecurity"
  );
  if (nationalSecurity) payload.NationalSecurity = nationalSecurity;

  return payload;
}

/**
 * Build an `UpdateOpportunity` payload for the Share flow's update branch.
 * The caller supplies the existing ACE `Identifier` and the
 * `LastModifiedDate` read from a preceding `GetOpportunity` call so ACE can
 * enforce its optimistic-concurrency check (R11.2).
 *
 * Throws if the deal's `dealstage` cannot be forward-mapped — preconditions
 * guarantee this never happens for a valid Share click, so the throw is a
 * last-line safety net rather than a user-visible error path.
 */
export function buildUpdatePayload(
  dealId: number,
  deal: DealProps,
  company: CompanyProps,
  existingOpportunityId: string,
  lastModifiedDate: string,
  stageMapping: StageMapping,
  config: AcePayloadConfig | Record<string, never> = {},
  options: {
    forceStage?: string;
    /**
     * The opp's current `LifeCycle.ReviewStatus`. Used to detect
     * Approved / Submitted / In review / Disqualified states where
     * `Customer.Account.*` is locked from edits.
     */
    reviewStatus?: string;
    /**
     * The opp's current `Customer` block, as returned by
     * `GetOpportunity`. Used verbatim on locked-state updates so the
     * payload satisfies AWS's REQUIRED-field rules without violating
     * its no-edit rules. Caller should pass `opp.Customer` directly.
     */
    lockedCustomer?: unknown;
    /**
     * The opp's current `SoftwareRevenue` block, as returned by
     * `GetOpportunity`. AWS locks every sub-field
     * (`DeliveryModel`, `Value.{Amount,CurrencyCode}`, `EffectiveDate`,
     * `ExpirationDate`) once the opp reaches a locked ReviewStatus.
     * UpdateOpportunity treats absence as "user is clearing the
     * block", which trips the lock with ACTION_NOT_PERMITTED on every
     * sub-field. Same fix as `lockedCustomer`: send the block
     * verbatim when present so AWS sees no change. The Share path
     * has no operator-controlled equivalent for SoftwareRevenue —
     * it's set externally (Partner Central UI, agent, etc.) — so
     * we never try to build it from the deal.
     */
    lockedSoftwareRevenue?: unknown;
  } = {}
): UpdatePayload {
  const dealStage = deal.dealstage?.trim();
  const mappedStage = dealStage ? forwardMap(dealStage, stageMapping) : undefined;
  if (!mappedStage) {
    throw new Error(
      `Unable to forward-map HubSpot dealstage '${deal.dealstage}' to an ACE stage — caller must validate preconditions before calling buildUpdatePayload`
    );
  }

  const monthly = computeMonthlyAmount(deal.amount, deal.contract_term__months_);
  // Title: HubSpot's built-in `dealname` (enforced by the `dealName`
  // precondition — no canned "Partner Opportunity" default).
  const title = deal.dealname?.trim() ?? "";
  const closeDate = parseCloseDate(deal.closedate);

  // No hard-coded defaults: each operator-customisable field comes from
  // the deal property (or an env default). On UPDATE, ACE treats an
  // omitted field as "clear it", so a required field left blank surfaces
  // as REQUIRED_FIELD_MISSING — an actionable error rather than a silent
  // default. Reps repopulate via the deal (Refresh pulls AWS values back).
  const currencyCode = resolveOptionalOverride(
    deal,
    "ace_currency_code",
    config,
    "aceDefaultCurrencyCode"
  );

  const project: Record<string, unknown> = {
    Title: title,
    CustomerBusinessProblem: deal.description ?? "",
    ExpectedCustomerSpend: [
      {
        Amount: monthly,
        ...(currencyCode ? { CurrencyCode: currencyCode } : {}),
        Frequency: "Monthly",
        // TargetCompany must be 1-80 chars (AWS regex `(?s).{1,80}`).
        TargetCompany: resolveTargetCompany(company, deal),
      },
    ],
  };
  const deliveryModels = resolveOptionalMultiOverride(
    deal,
    "ace_delivery_model",
    config,
    "aceDefaultDeliveryModel"
  );
  if (deliveryModels) project.DeliveryModels = deliveryModels;
  const customerUseCase = resolveOptionalOverride(
    deal,
    "ace_customer_use_case",
    config,
    "aceDefaultUseCase"
  );
  if (customerUseCase) project.CustomerUseCase = customerUseCase;
  const salesActivities = resolveOptionalMultiOverride(
    deal,
    "ace_sales_activities",
    config,
    "aceDefaultSalesActivities"
  );
  if (salesActivities) project.SalesActivities = salesActivities;

  // Attach additional editable Project fields (CompetitorName,
  // ApnPrograms, AwsPartition, OtherCompetitorNames,
  // OtherSolutionDescription, AdditionalComments). Same gating rules
  // as the create path.
  attachEditableProjectFields(project, deal, config);

  // LifeCycle.Stage is REQUIRED on every UpdateOpportunity (omitting
  // it returns `lifeCycle.stage is required`). Per AWS docs, Stage
  // is editable in Approved and Action Required, and the docs
  // describe Pending Submission as "fully editable".
  //
  // **Empirically (Sandbox catalog, May 2026): Stage is NOT editable
  // in Pending Submission.** Sending a different stage returns
  // `ACTION_NOT_PERMITTED: You can not update the stage when
  // Opportunity status is Pending Submission`. Other fields ARE
  // editable in this state — just Stage is locked. So when the
  // caller knows the opp is pending, it passes `forceStage` set to
  // the current ACE stage; sending the same value back satisfies
  // the "required" rule without tripping the "can't change" rule.
  //
  // Once StartEngagementFromOpportunityTask runs (handled by
  // `core/run-share.ts` after the Update), the opp leaves Pending
  // Submission and the next Share click can advance Stage freely.
  //
  // Submitted / In Review block all updates entirely (caught by
  // the orchestrator before reaching here).
  //
  // NextSteps: HubSpot's built-in `hs_next_step` is the single
  // source of truth. Share reads it; Refresh writes the AWS value
  // back to the same field. When the operator hasn't set it, fall
  // back to the canned string keyed off the (possibly forced)
  // lifecycle stage.
  const lifeCycleStage = options.forceStage ?? mappedStage;
  const nextStepsOverride = deal["hs_next_step"]?.trim();
  const lifeCycle: Record<string, unknown> = { Stage: lifeCycleStage };
  if (nextStepsOverride) lifeCycle.NextSteps = nextStepsOverride;
  if (closeDate) lifeCycle.TargetCloseDate = closeDate;
  // ClosedLostReason picks up the deal-level override — only emitted
  // when the (possibly forced) stage is Closed Lost so ACE doesn't
  // reject it as not-applicable.
  attachEditableLifeCycleFields(lifeCycle, deal, lifeCycleStage);

  // R-PREVENT-NULL-REVIEW-STATUS: pass `LifeCycle.ReviewStatus`
  // back to AWS verbatim when we know the current value, so the
  // Sandbox catalog's UpdateOpportunity doesn't strip it to null.
  //
  // Empirically (May 2026, Sandbox catalog): omitting
  // `LifeCycle.ReviewStatus` on UpdateOpportunity resets the value
  // to null, which permanently blocks the opportunity from being
  // submitted (StartEngagementFromOpportunityTask requires
  // ReviewStatus ∈ {"Pending Submission", "Action Required"}). The
  // AWS docs describe ReviewStatus as read-only on update, but the
  // API accepts a same-value passthrough — sending the current
  // value back is the safe no-op that avoids the strip.
  //
  // We send it only when we have a concrete current value. Empty
  // string / null / undefined would either be rejected by AWS
  // (transitioning from null to "Pending Submission" is forbidden)
  // or have no effect on already-orphaned opps. The orchestrator
  // in `core/run-share.ts` blocks Submitted/In Review before this
  // function runs, so we only ever pass back states AWS treats as
  // editable: Pending Submission, Action Required, Approved,
  // Rejected, Disqualified.
  const currentReviewStatus = (options.reviewStatus ?? "").trim();
  if (currentReviewStatus.length > 0) {
    lifeCycle.ReviewStatus = currentReviewStatus;
  }

  // ACE locks portions of the `Customer` block once an opportunity
  // crosses out of Pending Submission. Per AWS docs
  // (working-with-opportunity-updates.html), Approved opportunities
  // lock `Address.Country`, `Address.PostalCode`, `Industry`,
  // `WebsiteUrl`, plus several Project fields. Empirically (May 2026)
  // `CompanyName` and the entire `SoftwareRevenue` block are also
  // locked even though the docs don't list them.
  //
  // States we treat as "Customer-locked" (i.e. send AWS's existing
  // Customer block verbatim rather than rebuilding from the deal):
  //
  //   - `Approved`     — partial lock per docs; expanded by AWS.
  //   - `Disqualified` — defensive: opp cannot be re-submitted, but
  //                      a partner-edit retry shouldn't blow up.
  //   - `Action Required` — AWS opens a documented subset for edits;
  //                      sending the rest verbatim avoids ACTION_NOT_PERMITTED
  //                      on the rest of the Customer block.
  //
  // `Submitted` / `In Review` never reach this point — the
  // orchestrator in `core/run-share.ts` fails fast before
  // calling buildUpdatePayload because AWS blocks every update
  // during the review window.
  //
  // `Pending Submission` is fully editable per AWS docs (draft mode),
  // so we don't engage the passthrough — buildCustomerAccount runs
  // and the partner's HubSpot edits flow through cleanly.
  const lockedStates = new Set([
    "Approved",
    "Disqualified",
    "Action Required",
  ]);
  const customerLocked = lockedStates.has(
    (options.reviewStatus ?? "").trim()
  );

  const customerBlock =
    customerLocked && options.lockedCustomer
      ? (options.lockedCustomer as { Account: Record<string, unknown> })
      : { Account: buildCustomerAccount(company, deal, config) };

  // SoftwareRevenue is owned by AWS / the agent — Share has no
  // operator-controlled equivalent for it. AWS locks the block once
  // ReviewStatus is past Pending Submission and rejects "absent" as
  // a clear attempt. So when we have a snapshot from GetOpportunity,
  // pass it through verbatim. Otherwise omit (the API accepts an
  // absent SoftwareRevenue when there's nothing to lock).
  const softwareRevenuePassthrough =
    customerLocked && options.lockedSoftwareRevenue !== undefined
      ? options.lockedSoftwareRevenue
      : undefined;

  const payload: UpdatePayload = {
    Catalog: ACE_CATALOG,
    Identifier: existingOpportunityId,
    LastModifiedDate: lastModifiedDate,
    LifeCycle: lifeCycle,
    Project: project,
    Customer: customerBlock,
    PartnerOpportunityIdentifier: String(dealId),
    ...(softwareRevenuePassthrough !== undefined
      ? { SoftwareRevenue: softwareRevenuePassthrough }
      : {}),
    // Fields we deliberately do NOT send (and which third-party update
    // tools sometimes round-trip as empty strings, causing
    // `INVALID_ENUM_VALUE` / `INVALID_STRING_FORMAT` rejections):
    //
    //   - Customer.Account.AwsAccountId — empty string fails the
    //     `([0-9]{12}|\w{1,12})` pattern. Either omit, or send the
    //     customer's 12-digit AWS account number.
    //   - Customer.Account.Duns — empty string fails the `[0-9]{9}`
    //     pattern. Either omit, or send the 9-digit DUNS number.
    //   - Marketing.AwsFundingUsed when Marketing.Source = "None" —
    //     ACE rejects empty / any value other than "Yes"/"No". The
    //     `buildMarketing` helper handles this by omitting the field
    //     entirely when Source is None.
    //   - LifeCycle.ReviewStatus when no current value is known.
    //     We DO emit it when the preceding GetOpportunity returned a
    //     concrete value — see the `currentReviewStatus` block
    //     above. AWS docs say ReviewStatus is read-only on update,
    //     but the Sandbox API silently strips it to null when the
    //     field is absent on the wire. Passing the current value
    //     back as a same-value passthrough is the safe no-op that
    //     prevents new opportunities from being permanently
    //     orphaned in null-ReviewStatus state.
  };

  // Optional top-level fields — sent only when the rep set the deal
  // property (or an env default exists). No hard-coded values; `Origin`
  // is dropped entirely.
  const opportunityType = resolveOptionalOverride(
    deal,
    "ace_opportunity_type",
    config,
    "aceDefaultOpportunityType"
  );
  if (opportunityType) payload.OpportunityType = opportunityType;
  const marketing = buildMarketing(deal, config);
  if (marketing) payload.Marketing = marketing;
  const primaryNeeds = resolveOptionalMultiOverride(
    deal,
    "ace_primary_need_from_aws",
    config,
    "aceDefaultPrimaryNeedFromAws"
  );
  if (primaryNeeds) payload.PrimaryNeedsFromAws = primaryNeeds;
  const nationalSecurity = resolveOptionalOverride(
    deal,
    "ace_national_security",
    config,
    "aceDefaultNationalSecurity"
  );
  if (nationalSecurity) payload.NationalSecurity = nationalSecurity;

  return payload;
}
