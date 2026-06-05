import { v5 as uuidv5 } from "uuid";

/**
 * PAYLOAD_VERSION is a coupled constant shared with the Python batch sync.
 * If this value ever diverges from `src/mapping.py:PAYLOAD_VERSION`, the two
 * code paths will produce *different* ClientTokens for the same deal and ACE
 * will accept duplicate opportunities. Bump both together.
 *
 * History:
 *   - v4: initial AWS-backed pivot
 *   - v5: ACE payload corrections (CustomerUseCase enum, Marketing.Source
 *         mutual-exclusion, full UpdatePayload, distinct engagement-task
 *         ClientToken). Existing-but-shared opps from v4 retain their
 *         OppId; only newly-Created opps generate v5 tokens. The bump
 *         is also necessary because partial-failed v4 creates left
 *         orphaned ClientTokens locked to outdated request bodies in
 *         ACE's idempotency cache.
 *   - v6: added required `PartnerOpportunityIdentifier` (HubSpot deal ID)
 *         to Create / Update payloads. Opps created without it never
 *         get `LifeCycle.ReviewStatus = "Pending Submission"` and become
 *         unsubmittable orphans (verified empirically).
 */
export const PAYLOAD_VERSION = "v6" as const;

// RFC 4122 §Appendix C — the "URL" namespace. Matches Python's uuid.NAMESPACE_URL.
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Generate a deterministic UUIDv5 ClientToken for an ACE CreateOpportunity
 * call. Derived from the HubSpot deal ID so the Python batch sync and the
 * Custom Card produce the same token for the same deal, preserving ACE's
 * idempotency guarantee.
 */
export function generateClientToken(dealId: number): string {
  return uuidv5(`hubspot-deal-${dealId}-${PAYLOAD_VERSION}`, NAMESPACE_URL);
}

/**
 * Generate a deterministic UUIDv5 ClientToken for an ACE
 * `StartEngagementFromOpportunityTask` call. ACE keys idempotency per
 * `(operation, ClientToken)` pair, but in practice — and as observed
 * empirically — using the same ClientToken across two different ACE
 * write operations leads to the second call being silently deduped or
 * dropped. The engagement task therefore uses its own deterministic
 * suffix so it doesn't collide with the CreateOpportunity token.
 *
 * Determinism is still preserved per `dealId`, so a retry of Share for
 * the same deal produces the same token and ACE returns the original
 * task instead of starting a new one (the desired idempotency).
 */
export function generateEngagementClientToken(dealId: number): string {
  return uuidv5(
    `hubspot-deal-${dealId}-${PAYLOAD_VERSION}-engagement`,
    NAMESPACE_URL
  );
}
