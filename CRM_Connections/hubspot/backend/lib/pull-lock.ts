/**
 * Per-opportunity lock + dealId cache for the Pull Lambda.
 *
 * AWS Partner Central fires several events per opportunity during
 * creation (one `Opportunity Created`, then several `Opportunity
 * Updated` as the agent fills in fields). Without serialisation per
 * opportunity, the check-then-create path in `runPull`
 * (`findDealByAceOpportunityId` → `createDeal`) races and produces
 * duplicate HubSpot deals.
 *
 * Two distinct races have to be defended against:
 *
 *   1. **Concurrent invocations** for the same opp. Two Lambda
 *      containers running the same handler at the same time both call
 *      `findDealByAceOpportunityId`, both miss, both create a deal.
 *
 *   2. **Sequential invocations within HubSpot's search-index lag.**
 *      Invocation 1 finishes (creates deal A, releases lock).
 *      Invocation 2 starts a few seconds later, searches HubSpot, but
 *      HubSpot's eventually-consistent search index hasn't yet
 *      propagated deal A's `ace_opportunity_id` value. Invocation 2
 *      misses, creates duplicate deal B. Empirically the index lag
 *      sits in the 5-30 second range.
 *
 * This module fixes both with a single DynamoDB row per `oppId`:
 *
 *   - Acquire — conditional `PutItem`. Condition:
 *     `attribute_not_exists(oppId) OR expiresAt < :now`. Lets a fresh
 *     invocation reclaim a stale lock when the previous holder
 *     crashed past the lease window.
 *   - Release with dealId — `UpdateItem` setting `dealId` and bumping
 *     `expiresAt` to a long cache window (default 1 hour). The row
 *     stays in DynamoDB, so the next pull invocation can short-circuit
 *     the HubSpot search using the cached `dealId` even though the
 *     primary lease has functionally ended.
 *   - Peek (after a failed acquire) — `GetItem`. If the existing row
 *     has a `dealId` set, return it; the caller skips HubSpot search
 *     and goes straight to `runRefresh` against the cached id.
 *     If `dealId` is unset, another invocation is mid-flight; the
 *     caller throws `LockHeldError` and EventBridge retries.
 *   - TTL — DynamoDB's TTL on `expiresAt` reaps both stale locks
 *     (60s) and stale cache entries (1h). After the TTL window,
 *     HubSpot's search index has long since caught up and normal
 *     flow resumes.
 *
 * ## Failure mode on contention
 *
 * `acquireLock` throws `LockHeldError` only when another invocation
 * holds the row AND has not yet stored a `dealId`. The handler
 * re-throws so EventBridge retries with exponential backoff. Once a
 * `dealId` is in the row, all subsequent invocations short-circuit
 * to the Refresh path immediately, no retry needed.
 *
 * ## Lease lengths
 *
 * 60 seconds for the in-flight lock — comfortably longer than the
 * worst-case ~5s pull round trip. 1 hour for the dealId cache —
 * covers HubSpot's worst observed search-index lag with margin.
 * Stuck locks past the 60s lease are reclaimable by the next
 * invocation; abandoned cache rows reap on TTL.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";

/** How long a holder can hold the lock before another invocation can steal it. */
const LEASE_SECONDS = 60;

/**
 * How long the row stays after a clean release with a `dealId`. The
 * row is read by subsequent pull invocations as a cache hit so they
 * skip the HubSpot search index entirely. 1 hour is well past
 * HubSpot's worst observed property-search lag.
 */
const CACHE_SECONDS = 60 * 60;

/**
 * Thrown by `acquireLock` when another invocation holds an unexpired
 * lock on the same `oppId` AND no `dealId` has been written yet. The
 * handler turns this into a Lambda failure so EventBridge retries.
 */
export class LockHeldError extends Error {
  constructor(public readonly oppId: string) {
    super(`Pull lock held by another invocation for ${oppId}`);
    this.name = "LockHeldError";
  }
}

/**
 * Minimal injection seam over the DynamoDB SDK so tests can use a
 * literal-record stub without booting the AWS SDK transport.
 */
export type DdbLike = Pick<DynamoDBClient, "send">;

export type LockDeps = {
  /** DynamoDB table name (CFN: `PullLockTable`). */
  tableName: string;
  /** Override the system clock — defaults to `Date.now()`. */
  now?: () => number;
  /** Override the DynamoDB client — defaults to a default-config singleton. */
  client?: DdbLike;
};

/**
 * Outcome of an acquire attempt. The caller MUST handle all three
 * cases:
 *
 *   - `acquired`  → run the orchestration; on success call
 *                   `release(dealId)` to convert the row into a cache
 *                   entry. On failure, the row will TTL out after
 *                   `LEASE_SECONDS`.
 *   - `cache_hit` → another invocation already created this deal.
 *                   Skip the HubSpot search entirely and run
 *                   `runRefresh` against the cached `dealId`.
 *   - throws `LockHeldError` → in-flight contention. The caller
 *                   surfaces this so EventBridge retries.
 */
export type AcquireResult =
  | { kind: "acquired"; release: (dealId: number) => Promise<void> }
  | { kind: "cache_hit"; dealId: number };

let defaultClient: DynamoDBClient | undefined;
function getDefaultClient(): DynamoDBClient {
  if (!defaultClient) {
    defaultClient = new DynamoDBClient({});
  }
  return defaultClient;
}

/**
 * Acquire the per-opportunity lock, hit the cache, or throw
 * `LockHeldError`.
 */
export async function acquireLock(
  oppId: string,
  deps: LockDeps
): Promise<AcquireResult> {
  const client = deps.client ?? getDefaultClient();
  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const expiresAtSec = nowSec + LEASE_SECONDS;

  try {
    await client.send(
      new PutItemCommand({
        TableName: deps.tableName,
        Item: {
          oppId: { S: oppId },
          expiresAt: { N: String(expiresAtSec) },
          acquiredAt: { N: String(nowSec) },
        },
        // Acquire IF (no existing row OR existing row's lease has expired).
        ConditionExpression:
          "attribute_not_exists(oppId) OR expiresAt < :now",
        ExpressionAttributeValues: {
          ":now": { N: String(nowSec) },
        },
      })
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Existing row blocks us. Peek at it: if a `dealId` is cached,
      // return it as a cache hit. If not, real contention.
      return await peekAfterContention(oppId, client, deps.tableName);
    }
    throw err;
  }

  // Acquired. Caller calls `release(dealId)` after running the
  // orchestration to convert the row into a cache entry.
  return {
    kind: "acquired",
    release: async (dealId: number) => {
      const releaseNowMs = (deps.now ?? Date.now)();
      const releaseNowSec = Math.floor(releaseNowMs / 1000);
      const cacheUntilSec = releaseNowSec + CACHE_SECONDS;
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: deps.tableName,
            Key: { oppId: { S: oppId } },
            // `expiresAt` is the TTL field — bumping it past
            // `LEASE_SECONDS` extends the row's life into a cache
            // window. `dealId` lets subsequent invocations short-
            // circuit the HubSpot search.
            UpdateExpression:
              "SET expiresAt = :exp, dealId = :did, completedAt = :now",
            ExpressionAttributeValues: {
              ":exp": { N: String(cacheUntilSec) },
              ":did": { N: String(dealId) },
              ":now": { N: String(releaseNowSec) },
            },
          })
        );
      } catch {
        // Best-effort. If UpdateItem fails, the row will TTL out
        // after the lease window and the next invocation will redo
        // the work — duplicate-protection is partially degraded but
        // the search index has likely caught up by then.
      }
    },
  };
}

async function peekAfterContention(
  oppId: string,
  client: DdbLike,
  tableName: string
): Promise<AcquireResult> {
  let item: Record<string, { N?: string; S?: string }> | undefined;
  try {
    const out = await client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { oppId: { S: oppId } },
        ConsistentRead: true,
      })
    );
    item = (out as { Item?: Record<string, { N?: string; S?: string }> }).Item;
  } catch {
    item = undefined;
  }

  const cachedDealId = item?.dealId?.N
    ? Number(item.dealId.N)
    : undefined;
  if (cachedDealId !== undefined && Number.isFinite(cachedDealId)) {
    return { kind: "cache_hit", dealId: cachedDealId };
  }
  // No cached dealId means another invocation is still mid-flight.
  // Surface as contention so EventBridge retries.
  throw new LockHeldError(oppId);
}

/**
 * Seed the dealId cache without going through the acquire/release
 * dance. Used by `runShare` after a successful CreateOpportunity so
 * the immediately-following EventBridge `Opportunity Created` event
 * — which often arrives before HubSpot's search index has indexed
 * the new `ace_opportunity_id` value — can short-circuit straight to
 * Refresh instead of duplicate-creating.
 *
 * Idempotent: an `oppId` that already has a cache row gets its
 * `expiresAt` extended and `dealId` overwritten (which is fine — the
 * dealId is stable). Best-effort: a write failure logs but does not
 * fail the caller's flow.
 */
export async function seedCache(
  oppId: string,
  dealId: number,
  deps: LockDeps
): Promise<void> {
  const client = deps.client ?? getDefaultClient();
  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  const expiresAtSec = nowSec + CACHE_SECONDS;
  try {
    await client.send(
      new PutItemCommand({
        TableName: deps.tableName,
        Item: {
          oppId: { S: oppId },
          expiresAt: { N: String(expiresAtSec) },
          dealId: { N: String(dealId) },
          completedAt: { N: String(nowSec) },
        },
      })
    );
  } catch {
    // best-effort
  }
}
