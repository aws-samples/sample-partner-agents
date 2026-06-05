/**
 * Response envelope and error model for the Share / Refresh serverless functions.
 *
 * The Custom Card consumes a discriminated union on `ok: true | false` so it
 * can render success toasts or HubSpot-style alert banners without any further
 * type narrowing.
 *
 * Note: `ErrorCode` is intentionally implemented as an `as const` object plus
 * a type alias rather than a `const enum`, because the project's tsconfig sets
 * `isolatedModules: true` which is incompatible with `const enum` exports.
 */

export const ErrorCode = {
  MISSING_SECRET: "MISSING_SECRET",
  PRECONDITION: "PRECONDITION",
  STAGE_UNMAPPABLE: "STAGE_UNMAPPABLE",
  ACE_THROTTLED: "ACE_THROTTLED",
  ACE_CREATE: "ACE_CREATE",
  ACE_UPDATE: "ACE_UPDATE",
  ACE_GET: "ACE_GET",
  ACE_GET_SUMMARY: "ACE_GET_SUMMARY",
  HUBSPOT_WRITE: "HUBSPOT_WRITE",
  STALE_OPPORTUNITY: "STALE_OPPORTUNITY",
  AUTH_INVALID: "AUTH_INVALID",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Properties that were just written to the HubSpot deal on a successful run.
 * `ace_last_sync` is ISO 8601 UTC; `ace_sync_error` is always cleared on success.
 *
 * Bidirectional model: every editable ACE field has a SINGLE
 * `ace_*` property on the deal. Share writes operator-edited values
 * to AWS; Refresh writes AWS's current value back into the same
 * `ace_*` field. The four `aws_*` keys are pure AWS-side state with
 * no operator-controlled equivalent (review status, stage, reviewer
 * comments).
 *
 * All keys are individually optional and can be empty strings when
 * ACE has no value (e.g. `aws_review_status` is empty until the
 * engagement task runs).
 */
export type SuccessProperties = {
  ace_opportunity_id?: string;
  ace_sync_status: string;
  ace_last_sync: string;
  ace_sync_error: "";
  // Pure AWS-side state — no operator equivalent.
  aws_review_status?: string;
  aws_stage?: string;
  aws_review_comments?: string;
  aws_review_status_reason?: string;
  // Editable round-trip fields (HubSpot ↔ ACE share the same key).
  hs_next_step?: string;
  dealname?: string;
  description?: string;
  ace_additional_comments?: string;
  ace_competitor_name?: string;
  ace_other_competitor_names?: string;
  ace_other_solution_description?: string;
  ace_apn_programs?: string;
  ace_aws_partition?: string;
  ace_customer_use_case?: string;
  ace_delivery_model?: string;
  ace_sales_activities?: string;
  ace_currency_code?: string;
  ace_primary_need_from_aws?: string;
  ace_opportunity_type?: string;
  ace_marketing_source?: string;
  ace_aws_funding_used?: string;
  ace_national_security?: string;
  ace_closed_lost_reason?: string;
  ace_industry?: string;
  ace_aws_account_id?: string;
  ace_duns?: string;
  ace_street_address?: string;
  ace_involvement_type?: string;
  ace_visibility?: string;
  ace_solutions?: string;
  // Canonical HubSpot deal fields AWS owns the truth on.
  closedate?: string;
  amount?: string;
};

export type SuccessResponse = {
  ok: true;
  message: string;
  properties: SuccessProperties;
};

export type ErrorDetails = {
  step?: string;
  preconditionFailures?: string[];
  missingSecrets?: string[];
  invalidStageMappings?: string[];
};

export type ErrorResponse = {
  ok: false;
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
};

/**
 * Discriminated union consumed by the Custom Card. Narrow on `ok`.
 */
export type FunctionResponse = SuccessResponse | ErrorResponse;

/**
 * Build a fully typed ErrorResponse. The `details` object is omitted entirely
 * when no step or extra fields are provided, keeping the wire payload minimal.
 */
export function makeError(
  code: ErrorCode,
  step: string | undefined,
  message: string,
  extraDetails?: Omit<ErrorDetails, "step">
): ErrorResponse {
  const details: ErrorDetails = { ...(extraDetails ?? {}) };
  if (step !== undefined) {
    details.step = step;
  }
  const hasDetails = Object.keys(details).length > 0;
  return {
    ok: false,
    code,
    message,
    ...(hasDetails ? { details } : {}),
  };
}
