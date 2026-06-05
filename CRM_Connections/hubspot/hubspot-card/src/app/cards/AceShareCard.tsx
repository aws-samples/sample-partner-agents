/**
 * AceShareCard — HubSpot UI Extension App Card (Developer Platform 2025.2).
 *
 * Renders the "AWS Partner Central" card on the HubSpot deal record tab.
 * The card reads a focused set of deal properties (`description`,
 * `hs_next_step`, the `ace_*` round-trip fields, the `aws_*` mirror
 * fields), chooses one of five visual states, and exposes two buttons
 * that invoke the Share / Refresh AWS Lambda handlers via
 * `hubspot.fetch`.
 *
 * ## Backend integration
 *
 * The Share / Refresh handlers run as AWS Lambdas behind an API Gateway HTTP
 * API (deployed via `infra/deploy.sh`) — not HubSpot Serverless Functions.
 * `hubspot.fetch` automatically attaches a short-lived JWT in
 * `Authorization: Bearer <token>` plus an `X-HubSpot-Signature-V3` HMAC.
 * The Lambda verifies the v3 signature inline.
 *
 * ## Visual states
 *
 *   1. Placeholder        — the deal has no AWS context (no
 *                           `description`, no `ace_*` field set, no
 *                           `aws_*` mirror set). Buttons hidden,
 *                           explanatory text shown.
 *   2. In-flight Share    — `inFlight === "share"`. Both buttons disabled,
 *                           Share button shows "Sharing…" label.
 *   3. In-flight Refresh  — `inFlight === "refresh"`. Both buttons disabled,
 *                           Refresh button shows "Refreshing…" label.
 *   4. Active — no opp    — Some AWS context present, no `ace_opportunity_id`.
 *                           Only the Share button is visible.
 *   5. Active — with opp  — Some AWS context present, `ace_opportunity_id` set.
 *                           Both buttons visible.
 *
 * The "Error" surface is rendered as an inline `Alert` whenever the last
 * server-side action stored a non-empty `ace_sync_error`.
 *
 * ## State management
 *
 * Deal properties are read once on mount and re-read after every Share /
 * Refresh click. The `inFlight` local state gates both buttons to prevent
 * concurrent Share / Refresh clicks on the same deal.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  hubspot,
  Flex,
  Text,
  Button,
  Alert,
  Divider,
  LoadingSpinner,
  DescriptionList,
  DescriptionListItem,
} from "@hubspot/ui-extensions";
import { useAssociations } from "@hubspot/ui-extensions/crm";
import {
  classifySubmissionMode,
  isSubmitActionVisible,
  missingSubmissionFields,
} from "./submission-mode";
// Per-deployment API base URL. The file is gitignored — `npm install`
// materialises it from `config.local.ts.example` if missing, and the
// deploy script (`infra/deploy.sh`) overwrites it with the actual
// `ApiUrl` stack output. Tests pass an explicit `apiBaseUrl` prop and
// don't depend on this import's runtime value.
import { ACE_API_BASE_URL } from "./config.local";

/**
 * The custom deal properties the card depends on. Operators edit
 * `ace_*` fields on the deal; Refresh writes AWS's view back into the
 * SAME `ace_*` fields. The `aws_*` keys are pure AWS-side state with
 * no operator-controlled equivalent (review status / stage / reviewer
 * feedback) so they remain dedicated read-only mirrors.
 */
const DEAL_PROPERTY_NAMES = [
  "description",
  "hs_next_step",
  "ace_opportunity_id",
  "ace_solutions",
  "ace_aws_products",
  "ace_involvement_type",
  "ace_visibility",
  "ace_sync_status",
  "ace_last_sync",
  "ace_sync_error",
  "aws_review_status",
  "aws_stage",
  "aws_review_comments",
  "aws_review_status_reason",
  // Share-readiness checklist inputs. The card mirrors the
  // backend's `validatePreconditions` so reps see exactly which
  // fields gate Share before they click. Country / state / postal
  // are read from the deal-level overrides (the company-association
  // fallback is left to the backend; the card hint nudges the rep
  // to either set the deal-level value or populate the company).
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "ace_country_code",
  "ace_state_or_region",
  "ace_postal_code",
  "ace_other_solution_description",
  "ace_marketing_source",
  "ace_marketing_campaign_name",
  "ace_marketing_channels",
  "ace_aws_funding_used",
  "ace_closed_lost_reason",
  // HubSpot's built-in "any property changed" timestamp. Returned
  // by the UI extension API as **epoch milliseconds (string)** for
  // datetime-typed properties — see `parseHubspotTimestamp`. Used
  // by `deriveDisplayedSyncStatus` to flip the card into "Pending
  // Sync" when the deal has been edited after the last successful
  // Share/Refresh.
  "hs_lastmodifieddate",
] as const;

/** Per-request timeout for the Share / Refresh fetch. */
const FETCH_TIMEOUT_MS = 20000;

/**
 * AWS `ReviewStatus` values where AWS BLOCKS every UpdateOpportunity
 * call. Sharing a deal in this state will fail fast with a
 * PRECONDITION error. Per AWS docs (working-with-opportunity-updates.html),
 * Submitted / In Review opps are read-only until the review process
 * completes (status moves to Approved or Action Required).
 */
const REVIEW_BLOCKED_STATES = new Set(["Submitted", "In Review"]);

/**
 * AWS `ReviewStatus` values where AWS locks portions of the Customer
 * + SoftwareRevenue blocks. Edits to those locked sub-fields
 * (CompanyName, WebsiteUrl, Industry, Address, contact email/name,
 * SoftwareRevenue.*) are silently overwritten on next Refresh
 * because the Share path passes AWS's existing values through
 * verbatim. Stage / Next Steps / Close Date / Title / Spend / etc.
 * remain editable and do flow through.
 *
 * Per AWS docs, the precise locked subset varies by state:
 *   - Approved: subset of Customer.Account.* + Project fields.
 *   - Action Required: only a documented allow-list is editable.
 *   - Disqualified: defensive — same passthrough behaviour.
 */
const CUSTOMER_LOCKED_STATES = new Set([
  "Approved",
  "Disqualified",
  "Action Required",
]);

/**
 * Subset of company properties the readiness checklist consults
 * when the deal-level override fields are blank. Mirrors the
 * backend's company-side fallback in `validatePreconditions`:
 *   - `hs_country_code` ↔ deal `ace_country_code`
 *   - `state`           ↔ deal `ace_state_or_region`
 *   - `zip`             ↔ deal `ace_postal_code`
 *
 * Sourced from the deal's primary associated company via
 * `useAssociations({ toObjectType: "Companies", … })`. When no
 * company is associated, the card uses an empty object — the
 * checklist falls back to "set on the deal" behaviour.
 */
type CompanyProps = {
  hs_country_code?: string;
  state?: string;
  zip?: string;
};

/** Shape of the deal-property snapshot kept in local state. */
type DealProps = {
  description?: string;
  hs_next_step?: string;
  ace_opportunity_id?: string;
  ace_solutions?: string;
  ace_involvement_type?: string;
  ace_visibility?: string;
  ace_aws_products?: string;
  ace_sync_status?: string;
  ace_last_sync?: string;
  ace_sync_error?: string;
  aws_review_status?: string;
  aws_stage?: string;
  aws_review_comments?: string;
  aws_review_status_reason?: string;
  hs_lastmodifieddate?: string;
  // Share-readiness checklist inputs.
  dealname?: string;
  dealstage?: string;
  amount?: string;
  closedate?: string;
  ace_country_code?: string;
  ace_state_or_region?: string;
  ace_postal_code?: string;
  ace_other_solution_description?: string;
  ace_marketing_source?: string;
  ace_marketing_campaign_name?: string;
  ace_marketing_channels?: string;
  ace_aws_funding_used?: string;
  ace_closed_lost_reason?: string;
};

/**
 * Mirror of the discriminated-union response envelope defined in
 * `backend/lib/errors.ts`. Duplicated here because the card is bundled
 * separately from the Lambda handlers.
 */
type FunctionResponse =
  | {
      ok: true;
      message: string;
      properties?: Record<string, string>;
    }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

/**
 * Minimal shape of the `hubspot.fetch` response. We narrow against these
 * fields without importing the full SDK types so tests can use a simpler
 * stub.
 */
type HubspotFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

/**
 * Subset of the `@hubspot/ui-extensions` CRM host actions the card
 * actually calls.
 */
type CardActions = {
  addAlert: (args: {
    type?: "info" | "warning" | "success" | "danger" | "tip";
    message: string;
    title?: string;
  }) => void;
  fetchCrmObjectProperties: (
    properties: string[] | "*"
  ) => Promise<Record<string, string>>;
  refreshObjectProperties: () => void;
  /**
   * HubSpot push subscription: invokes the callback whenever any of
   * the listed deal properties changes value (sidebar edits, workflow
   * updates, public-API writes, etc.). The callback receives a
   * `Record<string, string>` containing only the CHANGED properties,
   * not the full deal — we merge them into local state.
   *
   * The card uses this to keep the share-readiness checklist live as
   * the rep populates missing fields without leaving the page. Before
   * this hook the rep had to click Refresh to re-evaluate, which was
   * confusing UX.
   */
  onCrmPropertiesUpdate: (
    properties: string[] | "*",
    callback: (
      properties: Record<string, string>,
      error?: { message: string },
    ) => void,
  ) => void;
};

type AceShareCardProps = {
  dealId: number;
  actions: CardActions;
  /**
   * Optional override for the AWS API Gateway base URL. Production mounts
   * leave this undefined so the constant `ACE_API_BASE_URL` is used.
   * Tests pass a stub URL to assert URL composition.
   */
  apiBaseUrl?: string;
  /**
   * `hubspot.fetch` wrapper injected as a prop so tests can mock the
   * network call without patching the SDK. Production mounts pass
   * `hubspot.fetch` unchanged.
   */
  fetchFn: (
    url: string,
    init: {
      method: string;
      timeout?: number;
      body?: unknown;
      headers?: Record<string, string>;
    }
  ) => Promise<HubspotFetchResponse>;
  /**
   * Optional override for the deal's primary-company properties.
   * Used by the share-readiness checklist to honour the
   * `validatePreconditions` deal→company fallback chain
   * (`hs_country_code`, `state`, `zip`).
   *
   * Production mounts leave this undefined; the card calls
   * `useAssociations({ toObjectType: "Companies", … })` from the
   * HubSpot UI Extensions SDK and tracks the result in local state.
   * Tests pass a fixture so the readiness logic can be exercised
   * without mocking the hook.
   */
  companyProps?: CompanyProps;
};

/** Render a dash for empty string-ish values so the property list never shows blanks. */
function display(value: string | undefined): string {
  return value && value.length > 0 ? value : "—";
}

/**
 * Format an ISO 8601 timestamp from `ace_last_sync` for human display.
 *
 * The HubSpot deal property stores the value as-written by the Lambda
 * handler (e.g. `"2026-05-15T15:11:39.263Z"`). Render it as the user's
 * locale-aware date + time so the card surface is readable. Returns the
 * raw string when it can't be parsed (defensive fallback — should never
 * happen for backend-written values, but matches HubSpot's behaviour
 * when an operator manually edits the field to something non-ISO).
 */
/**
 * Parse a HubSpot timestamp value into epoch milliseconds.
 *
 * HubSpot's UI extension API returns `datetime`-typed properties as
 * **epoch milliseconds (as a string)** rather than ISO 8601 — e.g.
 * `"1779271571635"` rather than `"2026-05-20T10:06:11.635Z"`. This
 * happens for both built-in datetimes (`hs_lastmodifieddate`) and
 * custom datetime properties (`ace_last_sync`).
 *
 * Some contexts may still surface the value as ISO 8601 (the public
 * CRM API does, for example), so we try integer parse first and
 * fall back to ISO. Returns `NaN` when both attempts fail.
 */
function parseHubspotTimestamp(value: string | undefined): number {
  if (!value || value.length === 0) return NaN;
  const trimmed = value.trim();
  // Pure-digit string → epoch millis (the common UI-extension shape).
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }
  // Otherwise try ISO 8601 / RFC 3339.
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatLastSync(value: string | undefined): string {
  const ts = parseHubspotTimestamp(value);
  if (!Number.isFinite(ts)) return value && value.length > 0 ? value : "—";
  // Use the browser's locale and timezone so the displayed value matches
  // what the HubSpot user sees elsewhere on the deal record.
  return new Date(ts).toLocaleString();
}

/**
 * Skew tolerance for the lastModified > lastSync comparison. HubSpot's
 * own writes (the post-Share write that updates ace_last_sync) bump
 * `hs_lastmodifieddate` to a value typically within 1-2 seconds of
 * `ace_last_sync`. Anything inside this window is treated as "from
 * the sync itself" rather than a real subsequent edit; outside it,
 * the deal is genuinely Pending sync.
 */
const PENDING_SYNC_SKEW_MS = 5_000;

/**
 * Derive the "displayed" sync status. Returns one of:
 *   - "Not Synced"   — never shared (no ace_last_sync).
 *   - "Pending Sync" — deal edited after the last successful sync.
 *   - "Sync Error"   — last Share/Refresh stored an error.
 *   - whatever the backend wrote into `ace_sync_status` otherwise.
 *
 * The "Pending Sync" state is purely client-side and computed from
 * `hs_lastmodifieddate > ace_last_sync + skew`. The backend doesn't
 * track a Pending state — it would need a webhook subscription on
 * deal property changes, which adds setup complexity and a HubSpot
 * webhook + Lambda for no real user benefit. The card already
 * re-reads on mount and after every Share/Refresh, so deriving the
 * status here gives the rep an accurate "you have unsynced edits"
 * cue without any backend churn.
 */
function deriveDisplayedSyncStatus(deal: DealProps): string {
  // Backend-stored error wins — don't mask it with a derived label.
  const stored = (deal.ace_sync_status ?? "").trim();
  if (stored === "Sync Error") return "Sync Error";

  // Deal never shared — no ace_last_sync timestamp.
  const lastSync = parseHubspotTimestamp(deal.ace_last_sync);
  if (!Number.isFinite(lastSync)) return stored || "Not Synced";

  // Deal edited after the last successful sync? `hs_lastmodifieddate`
  // is HubSpot's "any property changed" built-in. Use a small skew
  // window because HubSpot bumps lastmodified when WE write
  // ace_last_sync, so the two timestamps are always close after a
  // successful sync.
  const lastModified = parseHubspotTimestamp(deal.hs_lastmodifieddate);
  if (
    Number.isFinite(lastModified) &&
    lastModified > lastSync + PENDING_SYNC_SKEW_MS
  ) {
    return "Pending Sync";
  }

  return stored || "Synced";
}

/**
 * Check whether the deal is in scope for the AWS co-sell workflow.
 *
 * The card is shown when ANY of these is true:
 *   - the deal has a non-empty `description` (the operator wrote
 *     something the rep can submit to AWS as
 *     `Project.CustomerBusinessProblem`), OR
 *   - any ACE-related deal property is non-empty (the deal already
 *     has some link to AWS Partner Central — a synced opportunity,
 *     a partner-side selection that hasn't been shared yet, etc.).
 *
 * This is permissive on purpose: the backend Share Lambda runs the
 * full precondition validator, so a deal that isn't actually ready
 * still gets a clean error message. Hiding the card entirely is
 * reserved for deals that have no AWS context at all.
 */
function isInScope(deal: DealProps): boolean {
  const hasDescription =
    !!deal.description && deal.description.length > 0;
  if (hasDescription) return true;

  // Any ACE / AWS-mirror field carrying a value means the deal has
  // some Partner Central context; surface the card so the rep can
  // act on it.
  const aceFieldKeys: ReadonlyArray<keyof DealProps> = [
    "ace_opportunity_id",
    "ace_solutions",
    "ace_involvement_type",
    "ace_visibility",
    "ace_sync_status",
    "ace_last_sync",
    "ace_sync_error",
    "aws_review_status",
    "aws_stage",
    "aws_review_comments",
    "aws_review_status_reason",
  ];
  for (const key of aceFieldKeys) {
    const value = deal[key];
    if (typeof value === "string" && value.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Share-readiness checklist (UX-only, advisory).
 *
 * Mirrors the backend's `validatePreconditions` so reps see exactly
 * which fields gate Share before they click. The Share lambda
 * remains the source of truth — the checklist is purely a UI
 * convenience to avoid trial-and-error 422 errors.
 *
 * Each item is one of:
 *   - "ok"        — green check.
 *   - "missing"   — red X. Share will fail until populated.
 *   - "advisory"  — yellow info. Share succeeds, but the value is
 *                   probably worth setting (currently used for
 *                   Marketing fields when source is "Yes").
 *   - "info"      — blue info. Populated optional value worth
 *                   surfacing for visibility (e.g. AWS Products
 *                   count). Doesn't block Share, doesn't nudge.
 *   - "n/a"       — gray dash. Conditional rule and current deal
 *                   state means it doesn't apply (e.g. State on a
 *                   non-US country, Closed Lost reason on a
 *                   non-Closed-Lost deal).
 */
type ChecklistStatus = "ok" | "missing" | "advisory" | "info" | "na";

type ChecklistItem = {
  /** Stable key for React lists. */
  key: string;
  /** User-facing label. */
  label: string;
  status: ChecklistStatus;
  /** Optional second line shown under the label when status !== "ok". */
  hint?: string;
};

type ShareReadiness = {
  items: ChecklistItem[];
  /** True iff every "missing" item is empty. Advisory + n/a still allow Share. */
  allRequiredOk: boolean;
};

const SOLUTION_ID_PATTERN = /^S-\d+$/;

/**
 * Return whether `ace_solutions` carries at least one Solution
 * Offering id (matches `S-\d+`). Mirrors `parseSolutionIds` in the
 * backend — accept `;`, `,`, or whitespace as separators so reps
 * who type multiple IDs in a free-text field with commas (the
 * intuitive choice) don't get silently rejected. HubSpot multi-
 * select pickists serialize natively with `;`.
 */
function hasValidSolutionId(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .some((s) => SOLUTION_ID_PATTERN.test(s));
}

function nonEmpty(v: string | undefined): boolean {
  return !!v && v.trim().length > 0;
}

/**
 * Detect known cross-field AWS rejection rules that we can't infer
 * from the per-field validators. Surfaced both as a checklist
 * advisory (so reps see it BEFORE clicking Share or Submit) AND as
 * a button-disable on Submit (so the rep can't trigger a guaranteed-
 * failure round-trip). Returns `undefined` when the combination is
 * fine.
 *
 * Each rule should be derived from an empirical AWS rejection we've
 * observed (logged in `ace_sync_error` with the verbatim AWS message).
 * Adding a new rule means: capture the AWS error, derive the
 * sufficient HubSpot field combination that triggers it, write the
 * rule here. Don't speculate — only add rules backed by an actual
 * AWS rejection trace.
 */
type AwsIncompatibility = {
  /** Stable key for React lists / test assertions. */
  key: string;
  /** Short label shown on the readiness checklist row. */
  label: string;
  /** Detailed explanation shown under the label. */
  detail: string;
  /** Suggested HubSpot-side fix (rendered as a sentence). */
  fix: string;
};

function detectAwsIncompatibility(
  deal: DealProps,
): AwsIncompatibility | undefined {
  // O13673805 (Sandbox, May 2026) failed with:
  //   BUSINESS_VALIDATION_EXCEPTION primaryNeedsFromAws:Cannot
  //   set visibility to limited on a Co-Sell opportunity;
  //   ACTION_NOT_PERMITTED:You cannot perform Submit action.
  //   Opportunity cannot be submitted or updated to Limited
  //   Visibility
  //
  // Rule: AWS rejects InvolvementType=Co-Sell + Visibility=Limited.
  //       "Limited" is only valid with InvolvementType="For
  //       Visibility Only" (a marketing/awareness-only co-sell
  //       flavour).
  const involvement = (deal.ace_involvement_type ?? "").trim();
  const visibility = (deal.ace_visibility ?? "").trim();
  if (involvement === "Co-Sell" && visibility === "Limited") {
    return {
      key: "coSellLimited",
      label: "Incompatible: Co-Sell + Limited Visibility",
      detail:
        "AWS rejects Co-Sell opportunities with Limited Visibility. Submit will fail at validation.",
      fix:
        'Change Visibility to "Full", OR change Involvement Type to "For Visibility Only".',
    };
  }
  return undefined;
}

/**
 * Translate AWS's verbatim rejection messages into a human-friendly
 * "What went wrong" / "How to fix" pair. Keyed off substring
 * matches so the SDK's error format changes don't immediately
 * regress the parsing — when the substring matches, we emit a
 * curated message; otherwise we fall back to the raw AWS string so
 * the rep still sees the full diagnostic.
 *
 * Intentionally a closed list. Adding a new entry means we've
 * observed the AWS error in production / Sandbox and can describe
 * the fix authoritatively.
 */
type FailureExplanation = {
  /** Short summary suitable for the Alert title body. */
  summary: string;
  /** Concrete HubSpot-side fix the rep should apply. */
  fix: string;
};

function explainSubmissionFailure(
  raw: string | undefined,
): FailureExplanation | undefined {
  if (!raw || raw.length === 0) return undefined;

  // Strip the "StartEngagement: " prefix the lambda adds before
  // matching, so the substrings below match the AWS-original text.
  const message = raw.replace(/^StartEngagement:\s*/, "");

  // Co-Sell + Limited (see detectAwsIncompatibility above).
  if (
    message.includes("Cannot set visibility to limited") ||
    message.includes("submitted or updated to Limited Visibility")
  ) {
    return {
      summary:
        "AWS rejects Co-Sell opportunities with Limited Visibility.",
      fix:
        'Change Visibility to "Full" (or change Involvement Type to "For Visibility Only"), then click Submit again.',
    };
  }

  // Past TargetCloseDate at create / update time.
  if (
    message.includes("Target Close Date should be a future date") ||
    message.includes("targetCloseDate")
  ) {
    return {
      summary: "AWS requires Close Date to be in the future.",
      fix: "Change the deal's Close Date to a future date, then click Share again.",
    };
  }

  // Generic OPPORTUNITY_VALIDATION_FAILED with no specific
  // substring — the rep at least gets the AWS verbatim diagnostic
  // alongside a "this is an AWS-side rule" hint.
  if (message.includes("OPPORTUNITY_VALIDATION_FAILED")) {
    return {
      summary: "AWS rejected the submission during validation.",
      fix: "Review the AWS message above and adjust the deal fields, then click Submit again.",
    };
  }

  return undefined;
}

function computeShareReadiness(
  deal: DealProps,
  company: CompanyProps,
): ShareReadiness {
  const items: ChecklistItem[] = [];
  const push = (item: ChecklistItem) => items.push(item);

  // 0. AWS cross-field incompatibilities — surfaced FIRST so the
  //    rep sees the structural blocker before scanning the per-
  //    field rows. Always rendered when present, regardless of
  //    whether other fields are populated.
  const awsIncompat = detectAwsIncompatibility(deal);
  if (awsIncompat) {
    push({
      key: awsIncompat.key,
      label: awsIncompat.label,
      status: "missing",
      hint: `${awsIncompat.detail} ${awsIncompat.fix}`,
    });
  }

  // 1. dealname (HubSpot built-in). The backend falls back to a
  //    canned title when blank, so this is technically optional —
  //    but reps want their AWS opportunity to carry their HubSpot
  //    deal name, so we surface it as advisory rather than fully
  //    optional.
  push({
    key: "dealname",
    label: "Deal name",
    status: nonEmpty(deal.dealname) ? "ok" : "advisory",
    hint: nonEmpty(deal.dealname)
      ? undefined
      : `Defaults to "Partner Opportunity" when blank.`,
  });

  // 2. description (≥ 20 chars after trim).
  const desc = deal.description?.trim() ?? "";
  push({
    key: "description",
    label: "Description (≥ 20 characters)",
    status: desc.length >= 20 ? "ok" : "missing",
    hint:
      desc.length >= 20
        ? undefined
        : desc.length === 0
        ? "Sent to AWS as the customer business problem."
        : `Currently ${desc.length} characters.`,
  });

  // 3. closedate.
  push({
    key: "closedate",
    label: "Close date",
    status: nonEmpty(deal.closedate) ? "ok" : "missing",
  });

  // 4. amount > 0.
  const amount = deal.amount !== undefined ? Number(deal.amount) : NaN;
  const amountOk = Number.isFinite(amount) && amount > 0;
  push({
    key: "amount",
    label: "Amount",
    status: amountOk ? "ok" : "missing",
    hint: amountOk ? undefined : "Must be greater than 0.",
  });

  // 5. dealstage (must be set; the backend validates it maps to an
  //    ACE stage but we can't enumerate the operator's mapping
  //    here). A blank dealstage is rare in HubSpot but possible.
  push({
    key: "dealstage",
    label: "Deal stage",
    status: nonEmpty(deal.dealstage) ? "ok" : "missing",
    hint: nonEmpty(deal.dealstage)
      ? undefined
      : "Pipeline stage must be set.",
  });

  // 6. countryCode (deal override OR company association).
  //    Mirrors the backend's `validatePreconditions` precedence
  //    chain: deal-level `ace_country_code` first, then the
  //    associated company's `hs_country_code`. When the company is
  //    where the value lives, the checklist still shows ✅ and the
  //    backend resolver will pick it up at Share time.
  const dealCountry = deal.ace_country_code?.trim() ?? "";
  const companyCountry = company.hs_country_code?.trim() ?? "";
  const countryCode = dealCountry || companyCountry;
  push({
    key: "countryCode",
    label: "Customer country code",
    status: countryCode.length > 0 ? "ok" : "missing",
    hint:
      countryCode.length > 0
        ? dealCountry.length === 0 && companyCountry.length > 0
          ? "Inherited from the associated company."
          : undefined
        : "Set on the deal directly OR on the associated company.",
  });

  // 7. State (US-only).
  if (countryCode === "US") {
    const dealState = deal.ace_state_or_region?.trim() ?? "";
    const companyState = company.state?.trim() ?? "";
    const state = dealState || companyState;
    push({
      key: "stateOrRegion",
      label: "Customer state",
      status: state.length > 0 ? "ok" : "missing",
      hint:
        state.length > 0
          ? dealState.length === 0 && companyState.length > 0
            ? "Inherited from the associated company."
            : undefined
          : "Required when country is US. Set on the deal OR on the associated company.",
    });
  } else {
    push({
      key: "stateOrRegion",
      label: "Customer state",
      status: "na",
      hint: "Only required when country is US.",
    });
  }

  // 8. Postal code.
  const dealPostal = deal.ace_postal_code?.trim() ?? "";
  const companyPostal = company.zip?.trim() ?? "";
  const postal = dealPostal || companyPostal;
  push({
    key: "postalCode",
    label: "Customer postal code",
    status: postal.length > 0 ? "ok" : "missing",
    hint:
      postal.length > 0
        ? dealPostal.length === 0 && companyPostal.length > 0
          ? "Inherited from the associated company."
          : undefined
        : "Set on the deal directly OR on the associated company.",
  });

  // 9. Solution Offering — backend accepts EITHER `ace_solutions`
  //    with a valid `S-…` id OR `ace_other_solution_description`.
  //    Surface as a single item so the rep doesn't think both are
  //    required.
  const solutionsOk = hasValidSolutionId(deal.ace_solutions);
  const otherDescOk = nonEmpty(deal.ace_other_solution_description);
  push({
    key: "solutions",
    label: "Solution Offering",
    status: solutionsOk || otherDescOk ? "ok" : "missing",
    hint:
      solutionsOk || otherDescOk
        ? otherDescOk && !solutionsOk
          ? "Using free-text Other description."
          : undefined
        : "Pick at least one Solution Offering, OR fill in the Other Solution description.",
  });

  // 9b. AWS Products — entirely optional from AWS's perspective.
  //     Surface as info (ℹ️) when populated so the rep can see the
  //     count in the expanded checklist. Status is "info" rather than
  //     "ok" so that populated entries actually expand the checklist
  //     for visibility — otherwise the all-required-ok collapse hides
  //     them. Omitted when blank to avoid clutter.
  if (nonEmpty(deal.ace_aws_products)) {
    const productCount = deal.ace_aws_products!
      .split(/[;,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
    push({
      key: "awsProducts",
      label: `AWS Products (${productCount} associated)`,
      status: "info",
    });
  }

  // 10. Closed Lost reason — only when stage maps to Closed Lost.
  //     The card doesn't know the stage mapping, so we conservatively
  //     trigger when the dealstage looks like Closed Lost. Backend
  //     enforces the real rule.
  const stage = (deal.dealstage ?? "").trim().toLowerCase();
  if (stage.includes("closedlost") || stage.includes("closed_lost")) {
    push({
      key: "closedLostReason",
      label: "Closed Lost reason",
      status: nonEmpty(deal.ace_closed_lost_reason) ? "ok" : "missing",
      hint: nonEmpty(deal.ace_closed_lost_reason)
        ? undefined
        : "AWS requires a reason when stage is Closed Lost.",
    });
  }

  // 11. Marketing fields — advisory, not blocking. When source is
  //     "No" / blank, the backend omits AwsFundingUsed / Channels
  //     entirely, so they're n/a. When source is "Yes", they're
  //     not strictly required by the lambda (defaults are
  //     supplied), but operators usually want to be intentional —
  //     surface as advisory so the rep notices.
  const marketingSource = (deal.ace_marketing_source ?? "").trim();
  const isMarketingActivity =
    marketingSource === "Yes" || marketingSource === "Marketing Activity";
  if (isMarketingActivity) {
    push({
      key: "marketingCampaignName",
      label: "Marketing campaign name",
      status: nonEmpty(deal.ace_marketing_campaign_name) ? "ok" : "advisory",
      hint: nonEmpty(deal.ace_marketing_campaign_name)
        ? undefined
        : "Recommended when sourced from a marketing activity.",
    });
    push({
      key: "marketingChannels",
      label: "Marketing channels",
      status: nonEmpty(deal.ace_marketing_channels) ? "ok" : "advisory",
      hint: nonEmpty(deal.ace_marketing_channels)
        ? undefined
        : "Recommended when sourced from a marketing activity.",
    });
    push({
      key: "awsFundingUsed",
      label: "AWS funding used",
      status: nonEmpty(deal.ace_aws_funding_used) ? "ok" : "advisory",
      hint: nonEmpty(deal.ace_aws_funding_used)
        ? undefined
        : "Recommended when sourced from a marketing activity. Defaults to No on AWS if blank.",
    });
  }

  const allRequiredOk = items.every(
    (i) => i.status !== "missing",
  );
  return { items, allRequiredOk };
}

/** Render a single checklist row with an icon + label + optional hint. */
const ChecklistRow: React.FC<{ item: ChecklistItem }> = ({ item }) => {
  const icon =
    item.status === "ok"
      ? "✅"
      : item.status === "missing"
      ? "❌"
      : item.status === "advisory"
      ? "⚠️"
      : item.status === "info"
      ? "ℹ️"
      : "—";
  return (
    <Flex direction="column" gap="xs">
      <Text>
        {icon} {item.label}
      </Text>
      {item.hint && item.status !== "ok" ? (
        <Text format={{ italic: true }}>{`   ${item.hint}`}</Text>
      ) : null}
    </Flex>
  );
};

/**
 * Shape-narrow a `hubspot.fetch` result into the card's `FunctionResponse`.
 *
 * The backend always returns a JSON body matching `FunctionResponse`. If
 * the body is malformed, synthesise an `ok: false` envelope so the render
 * path never sees an uncategorised error. The authorizer 401 path
 * synthesises `AUTH_INVALID` with a user-readable message.
 */
async function coerceResponse(
  res: HubspotFetchResponse
): Promise<FunctionResponse> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (body && typeof body === "object" && "ok" in body) {
    return body as FunctionResponse;
  }

  if (res.status === 401) {
    return {
      ok: false,
      code: "AUTH_INVALID",
      message: "Authorization failed. Reload the HubSpot page and try again.",
    };
  }

  return {
    ok: false,
    code: "INTERNAL",
    message: `Unexpected response from backend (status ${res.status}).`,
  };
}

/**
 * Render the share-readiness checklist. When all required items are
 * populated (no "missing" entries), collapse to a one-line confirmation
 * so the card stays compact for ready-to-share deals. Otherwise render
 * each item with an icon + label + optional hint.
 *
 * Advisory entries (yellow ⚠️) don't block Share — they're populated
 * for the Marketing Activity sub-fields where AWS accepts blanks but
 * operators usually want to be deliberate.
 */
const ShareReadinessChecklist: React.FC<{
  deal: DealProps;
  company: CompanyProps;
}> = ({ deal, company }) => {
  const { items, allRequiredOk } = computeShareReadiness(deal, company);
  const missingCount = items.filter((i) => i.status === "missing").length;
  const advisoryCount = items.filter((i) => i.status === "advisory").length;
  const infoCount = items.filter((i) => i.status === "info").length;

  if (allRequiredOk && advisoryCount === 0 && infoCount === 0) {
    return (
      <Flex direction="column" gap="xs">
        <Text format={{ fontWeight: "bold" }}>
          ✅ Ready to share to AWS
        </Text>
      </Flex>
    );
  }

  const heading = !allRequiredOk
    ? `Required to share — ${missingCount} field${
        missingCount === 1 ? "" : "s"
      } missing`
    : advisoryCount > 0
    ? `Ready to share to AWS — ${advisoryCount} optional field${
        advisoryCount === 1 ? "" : "s"
      } worth setting`
    : `Ready to share to AWS`;

  return (
    <Flex direction="column" gap="sm">
      <Text format={{ fontWeight: "bold" }}>{heading}</Text>
      {items.map((item) => (
        <ChecklistRow key={item.key} item={item} />
      ))}
    </Flex>
  );
};

/**
 * The card itself. Split out from the `hubspot.extend` registration so
 * tests can render it directly with mock `actions` / `fetchFn` props
 * without having to simulate the HubSpot extend-callback boot sequence.
 */
export const AceShareCard: React.FC<AceShareCardProps> = ({
  dealId,
  actions,
  apiBaseUrl,
  fetchFn,
  companyProps: companyPropsOverride,
}) => {
  const effectiveApiBaseUrl = apiBaseUrl ?? ACE_API_BASE_URL;
  const [deal, setDeal] = useState<DealProps>({});
  const [loaded, setLoaded] = useState(false);
  const [inFlight, setInFlight] = useState<
    "idle" | "share" | "submit" | "refresh"
  >("idle");

  // Pull the deal's primary associated company so the readiness
  // checklist can honour the deal→company fallback for
  // ace_country_code / ace_state_or_region / ace_postal_code. The
  // hook handles refetch on association changes; we just pluck the
  // first result (HubSpot guarantees one primary per deal). Tests
  // bypass the hook by passing `companyProps` directly.
  const associationsResult = useAssociations(
    {
      toObjectType: "Companies",
      properties: ["hs_country_code", "state", "zip"],
      pageLength: 1,
    },
  );
  const fetchedCompany: CompanyProps =
    associationsResult.results.length > 0
      ? {
          hs_country_code:
            associationsResult.results[0].properties.hs_country_code ??
            undefined,
          state:
            associationsResult.results[0].properties.state ?? undefined,
          zip: associationsResult.results[0].properties.zip ?? undefined,
        }
      : {};
  const company: CompanyProps = companyPropsOverride ?? fetchedCompany;

  const fetchDeal = useCallback(async () => {
    try {
      const props = await actions.fetchCrmObjectProperties([
        ...DEAL_PROPERTY_NAMES,
      ]);
      setDeal(props as DealProps);
    } finally {
      setLoaded(true);
    }
  }, [actions]);

  useEffect(() => {
    void fetchDeal();
  }, [fetchDeal]);

  // Live-update the deal state when properties change in HubSpot
  // (sidebar edits, workflow updates, public-API writes). The
  // share-readiness checklist re-classifies every render against
  // the new `deal` snapshot, so the rep sees ❌ flip to ✅ as they
  // populate fields without ever leaving the page.
  //
  // The callback merges only the CHANGED properties (HubSpot sends
  // only the diff) into the existing deal state — we don't need a
  // full refetch. `setDeal` uses the functional updater so React
  // doesn't capture a stale `deal` closure.
  useEffect(() => {
    actions.onCrmPropertiesUpdate(
      [...DEAL_PROPERTY_NAMES],
      (changed, error) => {
        if (error) {
          // Don't surface to the rep — this is a best-effort live
          // sync. The card remains usable; manual Refresh still
          // works as a fallback.
          return;
        }
        setDeal((prev) => ({ ...prev, ...(changed as DealProps) }));
      },
    );
    // The SDK's onCrmPropertiesUpdate has no documented teardown —
    // it fires for the lifetime of the card mount. We rely on the
    // card's own unmount to release any internal listeners.
  }, [actions]);

  const invoke = useCallback(
    async (kind: "share" | "submit" | "refresh") => {
      if (inFlight !== "idle") {
        return;
      }
      if (!effectiveApiBaseUrl) {
        actions.addAlert({
          type: "danger",
          message:
            "Card is not configured: apiBaseUrl is missing. Redeploy the backend (./infra/deploy.sh) and re-upload the card.",
        });
        return;
      }
      setInFlight(kind);
      try {
        const url = `${effectiveApiBaseUrl.replace(/\/$/, "")}/${kind}`;
        const response = await fetchFn(url, {
          method: "POST",
          timeout: FETCH_TIMEOUT_MS,
          body: { dealId },
        });
        const res = await coerceResponse(response);
        if (res.ok) {
          actions.addAlert({ type: "success", message: res.message });
        } else {
          actions.addAlert({ type: "danger", message: res.message });
        }
      } catch (err) {
        const fallbackLabel =
          kind === "share"
            ? "Share"
            : kind === "submit"
            ? "Submit"
            : "Refresh";
        const message =
          err instanceof Error && err.message
            ? err.message
            : `${fallbackLabel} failed.`;
        actions.addAlert({ type: "danger", message });
      } finally {
        try {
          actions.refreshObjectProperties();
        } catch {
          // no-op
        }
        // R9.4: re-fetch deal properties before re-enabling buttons so
        // the card re-classifies Submission_Mode and Submit_Action_Visible
        // against the freshly-written aws_review_status.
        await fetchDeal();
        setInFlight("idle");
      }
    },
    [actions, dealId, effectiveApiBaseUrl, fetchDeal, fetchFn, inFlight]
  );

  const handleShare = useCallback(() => invoke("share"), [invoke]);
  const handleSubmit = useCallback(() => invoke("submit"), [invoke]);
  const handleRefresh = useCallback(() => invoke("refresh"), [invoke]);

  if (!loaded) {
    return (
      <Flex direction="column" gap="md">
        <Text format={{ fontWeight: "bold" }}>AWS Partner Central</Text>
        <LoadingSpinner label="Loading…" />
      </Flex>
    );
  }

  if (!isInScope(deal)) {
    return (
      <Flex direction="column" gap="md">
        <Text format={{ fontWeight: "bold" }}>AWS Partner Central</Text>
        <Text>
          This deal has no AWS Partner Central context yet. Add a
          deal &ldquo;Description&rdquo; (sent to AWS as the customer
          business problem) and the Share button will appear.
        </Text>
      </Flex>
    );
  }

  const hasOpportunity =
    !!deal.ace_opportunity_id && deal.ace_opportunity_id.length > 0;
  const busy = inFlight !== "idle";
  const hasError = !!deal.ace_sync_error && deal.ace_sync_error.length > 0;
  const reviewStatus = (deal.aws_review_status ?? "").trim();
  const reviewBlocked = REVIEW_BLOCKED_STATES.has(reviewStatus);
  const customerLocked = CUSTOMER_LOCKED_STATES.has(reviewStatus);

  // R1.1, R1.2, R1.3, R7.1: classify the next Share click into
  // Create_And_Submit (one click does it all) vs Create_Only
  // (save as draft; Submit separately).
  const submissionMode = classifySubmissionMode(deal);
  // R5.1, R5.2, R5.3, R11.1, R11.2: Submit_Action visibility is
  // gated on `ace_opportunity_id` set + `aws_review_status` ∈
  // {"Pending Submission", ""}.
  const submitVisible = isSubmitActionVisible(deal);
  // R1.7: when Create_Only because of missing fields, we surface the
  // missing field names in the helper line.
  const missingFields = missingSubmissionFields(deal);

  // When the opportunity is already saved on AWS as a draft (oppId
  // present + aws_review_status ∈ {"Pending Submission", ""}),
  // Share is hidden entirely. Editing the opp in this state without
  // submitting is no longer a supported action — the AWS Sandbox
  // UpdateOpportunity API silently strips ReviewStatus to null when
  // called against a Pending Submission opp, which permanently
  // orphans the opportunity. The backend payload preserves
  // ReviewStatus as belt-and-braces, but the safest UX is to remove
  // the Share button so the rep simply cannot trigger the path.
  // Reps who need to push HubSpot edits to a saved draft can: edit
  // in HubSpot now, click Submit to advance the opp out of draft
  // state, then the next Refresh / EventBridge auto-pull will
  // reconcile the deal back from AWS.
  const isDraftPendingSubmission = hasOpportunity && submitVisible;

  // Share button visibility rules. The "Share to AWS (...)" framing
  // only makes sense in two states:
  //   (a) No opp yet → Share creates one (Create_And_Submit or
  //       Create_Only depending on the classifier).
  //   (b) Opp exists AND AWS allows updates AND we're not in the
  //       draft-already-saved state.
  // Hidden in every other case:
  //   - `isDraftPendingSubmission` — see the long comment above; the
  //     SDK's UpdateOpportunity strips ReviewStatus.
  //   - `reviewBlocked` (Submitted / In Review) — AWS rejects every
  //     update during the review window, and the card already shows
  //     a "Updates blocked while AWS is reviewing" Alert. Rendering
  //     a Share button below that contradicts the alert and lets
  //     the rep trigger a guaranteed PRECONDITION failure.
  const shareHidden = isDraftPendingSubmission || reviewBlocked;

  // R1.6, R1.7: helper line directly under the Share button. Only
  // rendered when the Share button itself is rendered — i.e. when
  // the opp is not already saved as a draft on AWS.
  const helperLine =
    submissionMode === "Create_And_Submit"
      ? "This click will submit the opportunity to AWS for review."
      : missingFields.length > 0
      ? `This click will save the opportunity to AWS as a draft. Submit for review separately. Missing for submission: ${missingFields.join(", ")}.`
      : "This click will save the opportunity to AWS as a draft. Submit for review separately.";

  // R8.4: AWS-side submission failure detection. The Submit_Function
  // (and Share's create-and-submit path) write `ace_sync_error` with
  // the literal prefix "StartEngagement: " on synchronous engagement
  // failures. The AWS error message embeds the reason code inline.
  const lastSubmitFailed =
    deal.ace_sync_error?.startsWith("StartEngagement") ?? false;
  // Curated explanation for known AWS rejection patterns. When
  // `undefined`, the Last-failed Alert renders just the verbatim
  // AWS message. When set, we render a friendlier
  // summary + fix pair alongside the verbatim message.
  const failureExplanation = explainSubmissionFailure(deal.ace_sync_error);

  // Cross-field AWS rule that we know AWS will reject (e.g.
  // Co-Sell + Limited Visibility). Surfaced both in the readiness
  // checklist and as a Submit-button gate so reps can't trigger a
  // guaranteed-failure round-trip from the Submit button. Render
  // the warning Alert above Submit so the rep sees it without
  // having to scroll up to the readiness checklist.
  const awsIncompatibility = detectAwsIncompatibility(deal);

  // R5.7, R11.2: Submission_Pending_Recovery surface — a saved-but-
  // not-yet-submitted opp (legacy null status or "Pending Submission").
  // Only render when the Submit button is also visible (same gating).
  const showRecoveryAlert = submitVisible;

  return (
    <Flex direction="column" gap="md">
      <Text format={{ fontWeight: "bold" }}>AWS Partner Central</Text>
      {reviewBlocked && (
        <Alert title="Updates blocked while AWS is reviewing" variant="warning">
          <Text>
            This opportunity is in {deal.aws_review_status} review
            status. AWS blocks all updates while the review is in
            progress. Share will fail until status moves to Approved
            or Action Required.
          </Text>
        </Alert>
      )}
      {customerLocked && (
        <Alert title="Customer details locked on AWS" variant="warning">
          <Text>
            This opportunity is in {deal.aws_review_status} review
            status. AWS no longer accepts edits to the customer
            company or contacts (CompanyName, WebsiteUrl, Industry,
            Address, contact email / name). Changes you make to the
            associated Company or Contacts in HubSpot will stay local
            — update those in AWS Partner Central directly.
          </Text>
          <Text>
            Stage, Next Steps, Close Date, Title and Expected Spend
            still sync — Share and Refresh remain enabled for those.
          </Text>
        </Alert>
      )}
      <DescriptionList>
        <DescriptionListItem label="ACE Opportunity ID">
          <Text>{display(deal.ace_opportunity_id)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="Sync Status">
          <Text>{deriveDisplayedSyncStatus(deal)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="AWS Review Status">
          <Text>{display(deal.aws_review_status)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="AWS Stage">
          <Text>{display(deal.aws_stage)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="Solution Offering">
          <Text>{display(deal.ace_solutions)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="AWS Products">
          <Text>{display(deal.ace_aws_products)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="Involvement Type">
          <Text>{display(deal.ace_involvement_type)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="Visibility">
          <Text>{display(deal.ace_visibility)}</Text>
        </DescriptionListItem>
        <DescriptionListItem label="Next Steps">
          <Text>{display(deal.hs_next_step)}</Text>
        </DescriptionListItem>
        {deal.aws_review_comments && deal.aws_review_comments.length > 0 ? (
          <DescriptionListItem label="AWS Review Comments">
            <Text>{deal.aws_review_comments}</Text>
          </DescriptionListItem>
        ) : null}
        {deal.aws_review_status_reason &&
        deal.aws_review_status_reason.length > 0 ? (
          <DescriptionListItem label="AWS Review Status Reason">
            <Text>{deal.aws_review_status_reason}</Text>
          </DescriptionListItem>
        ) : null}
        <DescriptionListItem label="Last Sync">
          <Text>{formatLastSync(deal.ace_last_sync)}</Text>
        </DescriptionListItem>
      </DescriptionList>
      {/* Share-readiness checklist — only shown before the first Share
          (no `ace_opportunity_id`). Once the opp is on AWS, the
          create-time preconditions are no longer relevant; the rep
          is past that gate. The list mirrors `validatePreconditions`
          on the backend so reps see exactly which fields gate Share
          before they click. */}
      {!hasOpportunity && (
        <>
          <Divider />
          <ShareReadinessChecklist deal={deal} company={company} />
        </>
      )}
      <Divider />
      <Flex direction="column" gap="sm">
        <Flex direction="row" gap="sm">
          {/* PREVENT-NULL-REVIEW-STATUS: hide Share entirely when the
              opp is already saved on AWS as a draft. The original
              "editable pass-through" Share path used to silently strip
              ReviewStatus to null on the Sandbox catalog and orphan the
              opp; we now both (a) preserve ReviewStatus in the backend
              update payload as belt-and-braces, and (b) remove the
              button from the UI in this state so the rep can't
              accidentally trigger any retrieval-side regression. The
              only sensible next action from a saved draft is Submit. */}
          {!shareHidden && (
            <Button
              onClick={handleShare}
              disabled={busy}
              variant="primary"
              type="button"
            >
              {inFlight === "share"
                ? "Sharing…"
                : hasOpportunity
                ? "Push updates to AWS"
                : submissionMode === "Create_And_Submit"
                ? "Share to AWS (creates and submits)"
                : "Share to AWS (save as draft)"}
            </Button>
          )}
          {hasOpportunity && (
            <Button
              onClick={handleRefresh}
              disabled={busy}
              variant="secondary"
              type="button"
            >
              {inFlight === "refresh"
                ? "Refreshing…"
                : "Refresh from AWS Partner Central"}
            </Button>
          )}
        </Flex>
        {/* R1.6, R1.7: helper line directly under the Share button.
            Only rendered for the create-time flows (no opp yet) and
            when Share is visible — suppressed when:
              - Share is hidden (draft-already-saved or AWS review-
                blocked) — there's no Share button to sit under.
              - The opp already exists — Share's role is "push
                updates to AWS", not "save as draft" / "submit for
                review", so the create-mode helper text would be
                misleading. */}
        {!shareHidden && !hasOpportunity && <Text>{helperLine}</Text>}
        {submitVisible && (
          <>
            {/* R5.7, R11.2: Submission_Pending_Recovery alert directly above Submit. */}
            {showRecoveryAlert && (
              <Alert
                title="Saved on AWS — not yet submitted"
                variant="info"
              >
                <Text>
                  This opportunity is saved on AWS but not yet
                  submitted for review. Submit when ready.
                </Text>
              </Alert>
            )}
            {/* R8.4: Last-failed submission alert directly above Submit. */}
            {lastSubmitFailed && (
              <Alert title="Last submission failed" variant="error">
                {failureExplanation && (
                  <>
                    <Text format={{ fontWeight: "bold" }}>
                      {failureExplanation.summary}
                    </Text>
                    <Text>{`How to fix: ${failureExplanation.fix}`}</Text>
                  </>
                )}
                <Text format={{ italic: true }}>
                  {`AWS message: ${deal.ace_sync_error}`}
                </Text>
              </Alert>
            )}
            {/* AWS cross-field incompatibility (e.g. Co-Sell + Limited).
                Rendered above Submit so the rep sees the structural
                blocker right next to the disabled button. */}
            {awsIncompatibility && (
              <Alert title={awsIncompatibility.label} variant="warning">
                <Text>{awsIncompatibility.detail}</Text>
                <Text>{`How to fix: ${awsIncompatibility.fix}`}</Text>
              </Alert>
            )}
            {/* Missing-fields hint moved here (post-7.2 UX tweak) when
                the opp is already saved as a draft, since the missing
                fields gate Submit, not Share. */}
            {isDraftPendingSubmission && missingFields.length > 0 && (
              <Text>
                Missing for submission: {missingFields.join(", ")}.
                Populate these fields on the deal, then click Submit.
              </Text>
            )}
            <Flex direction="row" gap="sm">
              <Button
                onClick={handleSubmit}
                disabled={
                  busy ||
                  missingFields.length > 0 ||
                  !!awsIncompatibility
                }
                variant="primary"
                type="button"
              >
                {inFlight === "submit"
                  ? "Submitting…"
                  : "Submit for AWS Review"}
              </Button>
            </Flex>
          </>
        )}
      </Flex>
      {hasError && !(lastSubmitFailed && submitVisible) && (
        <Alert title="Last sync error" variant="error">
          {deal.ace_sync_error}
        </Alert>
      )}
    </Flex>
  );
};

/**
 * HubSpot UI Extensions entry point. Called once at card boot with the
 * extend-callback `api` object. We pass `hubspot.fetch` as the production
 * fetch implementation. The API base URL is no longer injected via
 * `extensionConfig` (removed in 2025.2) — it lives in the
 * `ACE_API_BASE_URL` constant at the top of this file.
 */
type ExtensionContext = {
  crm: { objectId: number };
};

hubspot.extend<"crm.record.tab">(({ actions, context }) => {
  const ctx = context as unknown as ExtensionContext;
  return (
    <AceShareCard
      dealId={ctx.crm.objectId}
      actions={actions}
      fetchFn={
        (
          hubspot as unknown as {
            fetch: AceShareCardProps["fetchFn"];
          }
        ).fetch
      }
    />
  );
});

export default AceShareCard;
