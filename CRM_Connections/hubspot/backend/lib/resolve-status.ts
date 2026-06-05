/**
 * Sync-health resolution for the HubSpot `ace_sync_status` deal property.
 *
 * `ace_sync_status` is a HubSpot picklist that reflects how the LAST
 * sync attempt fared — NOT what AWS thinks of the opportunity. AWS's
 * own state lives in `aws_review_status` (the raw `LifeCycle.ReviewStatus`
 * value: "Pending Submission", "Submitted", "In review", "Action Required",
 * "Approved", "Rejected"), so callers and the card display the two
 * fields side-by-side without one drowning out the other.
 *
 * The closed enum:
 *
 *   `Not Synced`  — Initial state. The deal has never been shared
 *                   with AWS Partner Central.
 *   `Synced`      — Last Share / Refresh / EventBridge auto-pull
 *                   completed against ACE. AWS state is reflected on
 *                   the deal in `aws_review_status` / `aws_stage` /
 *                   `aws_*` mirror fields.
 *   `Sync Error`  — Last sync attempt failed. See `ace_sync_error` for
 *                   the failing step + AWS error message.
 *
 * Resolution rule:
 *
 *   `resolveStatus` is invoked exclusively from successful read paths
 *   (Refresh, post-Update / post-Create snapshot, EventBridge auto-pull),
 *   so it always returns `"Synced"`. Failure-path callers in
 *   `aceFailure` write `"Sync Error"` directly without calling this
 *   function. The "Not Synced" value is set by the partner provisioning
 *   scripts as the property's default and isn't written by the
 *   handlers.
 *
 *   The function still takes `reviewStatus` / `aceStage` arguments so
 *   the existing call sites (and snapshot-builder signature in
 *   `run-share.ts:snapshotFromOpportunity`) stay unchanged. They're
 *   intentionally unused — the resolution rule no longer depends on
 *   ACE-side state. Callers needing the AWS state should read the
 *   `aws_review_status` / `aws_stage` mirror fields instead.
 */

/** The closed enum HubSpot's `ace_sync_status` property accepts. */
export type SyncStatus = "Not Synced" | "Synced" | "Sync Error";

/**
 * Always returns `"Synced"`. The function is called only after a
 * successful ACE read; failure paths call `aceFailure` directly which
 * writes `"Sync Error"` without going through this resolver.
 *
 * The arguments are kept for source-compatibility with existing call
 * sites and the property-test signature; both are intentionally
 * unused now.
 */
export function resolveStatus(
  _reviewStatus: string | undefined,
  _aceStage: string | undefined
): SyncStatus {
  return "Synced";
}
