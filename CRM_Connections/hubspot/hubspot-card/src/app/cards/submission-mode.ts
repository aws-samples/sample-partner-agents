// backend/lib/submission-mode.ts AND hubspot-card/src/app/cards/submission-mode.ts
// Both files are byte-identical.

export type SubmissionMode = "Create_And_Submit" | "Create_Only";

/**
 * The set of HubSpot deal properties AWS uses ONLY at engagement-task
 * time and that are not consumed by Create / Update / Associate. When
 * any of these is missing, Share is downgraded to Create_Only and the
 * partner gets a Submit_Action surface to complete submission later.
 *
 * Glossary alignment: this is `Submission_Required_Fields` from
 * requirements.md.
 */
export const SUBMISSION_REQUIRED_FIELDS = [
  "ace_involvement_type",
  "ace_visibility",
] as const;

/** AWS_Review_Status values where Submit_Action is allowed. */
const SUBMITTABLE_STATES = new Set(["Pending Submission", ""]);

/**
 * AWS_Review_Status values that already locked submission. Sending
 * StartEngagement against any of these is rejected by AWS at
 * SubmitOpportunity (the inner action). The Submit_Function refuses
 * to even attempt the call when the status is in this set.
 */
const NON_SUBMITTABLE_STATES = new Set([
  "Submitted",
  "In Review",
  "Action Required",
  "Approved",
  "Rejected",
]);

export type SubmissionInputs = {
  ace_opportunity_id?: string;
  ace_involvement_type?: string;
  ace_visibility?: string;
  aws_review_status?: string;
};

/**
 * Returns the field names from SUBMISSION_REQUIRED_FIELDS that are
 * empty / whitespace-only on the deal. Stable order matches the
 * declaration order so card UI and backend error messages list the
 * same fields in the same sequence.
 */
export function missingSubmissionFields(deal: SubmissionInputs): string[] {
  return SUBMISSION_REQUIRED_FIELDS.filter(
    (k) => (deal[k] ?? "").trim().length === 0
  );
}

/**
 * R1.2, R1.3, R7.1. Decides whether the next Share click will create
 * AND submit, or save as draft only.
 */
export function classifySubmissionMode(deal: SubmissionInputs): SubmissionMode {
  const reviewStatus = (deal.aws_review_status ?? "").trim();

  // R7.1: Pending Submission editable pass-through is ALWAYS Create_Only,
  // independent of submission-field population. Submission requires
  // a deliberate Submit click.
  if (reviewStatus === "Pending Submission") return "Create_Only";

  // R1.3: Submitted / In Review never reach Share orchestration anyway,
  // but we classify defensively as Create_Only so the helper line
  // doesn't promise a submit that won't happen.
  if (NON_SUBMITTABLE_STATES.has(reviewStatus)) return "Create_Only";

  // R1.2: All required fields populated AND status not in the
  // "blocked-from-fresh-submit" set → full happy path.
  const missing = missingSubmissionFields(deal);
  if (missing.length === 0) return "Create_And_Submit";

  return "Create_Only";
}

/** R5.1, R5.2, R5.3, R11.2 + R11.3. */
export function isSubmitActionVisible(deal: SubmissionInputs): boolean {
  const oppId = (deal.ace_opportunity_id ?? "").trim();
  if (oppId.length === 0) return false;
  const reviewStatus = (deal.aws_review_status ?? "").trim();
  return SUBMITTABLE_STATES.has(reviewStatus);
}
