/**
 * Tests for `core/run-pull.ts` — the EventBridge-driven AWS → HubSpot
 * orchestration.
 *
 * Coverage:
 *   - Catalog mismatch is skipped, not failed (defence-in-depth in case
 *     the EventBridge rule is misconfigured).
 *   - Existing-deal path: HubSpot search hits → Refresh delegated.
 *     Asserted by checking the writeDealProperties call HubSpot
 *     receives at the end of `runRefresh`.
 *   - Missing-deal path: HubSpot search misses → ACE fetched, deal
 *     created with the snapshot-derived property bag.
 *   - Errors at each stage map onto the right ErrorCode.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

import { runPull } from "../core/run-pull";
import type { AcePullEvent, PullDeps } from "../core/run-pull";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import type { AppConfig } from "../lib/config";
import { ErrorCode } from "../lib/errors";

// Match the share test: BASE_CONFIG carries enough state for runRefresh
// (which is what the existing-deal path delegates to) to thread through
// without barfing on an empty stageMapping.
const BASE_CONFIG: AppConfig = {
  awsAccessKeyId: "K",
  awsSecretAccessKey: "S",
  aceRegion: "us-east-1",
  stageMappingRaw:
    "qualified=Qualified;techvalid=Technical Validation;closedlost=Closed Lost",
  stageDisplayNamesRaw: "",
  hubspotPrivateAppToken: "tok",
};

type AceMocks = { [K in keyof AceClient]: ReturnType<typeof vi.fn> };
type HsMocks = { [K in keyof HubspotClient]: ReturnType<typeof vi.fn> };

function buildAce(partial: Partial<AceMocks> = {}): {
  client: AceClient;
  mocks: AceMocks;
} {
  const mocks: AceMocks = {
    createOpportunity:
      partial.createOpportunity ?? vi.fn().mockResolvedValue({}),
    associateOpportunity:
      partial.associateOpportunity ?? vi.fn().mockResolvedValue({}),
    disassociateOpportunity:
      partial.disassociateOpportunity ?? vi.fn().mockResolvedValue({}),
    startEngagementFromOpportunityTask:
      partial.startEngagementFromOpportunityTask ??
      vi.fn().mockResolvedValue({}),
    listEngagementFromOpportunityTasks:
      partial.listEngagementFromOpportunityTasks ??
      vi.fn().mockResolvedValue({}),
    updateOpportunity:
      partial.updateOpportunity ?? vi.fn().mockResolvedValue({}),
    getOpportunity:
      partial.getOpportunity ??
      vi.fn().mockResolvedValue({
        Id: "O123",
        LifeCycle: { Stage: "Qualified" },
        Project: { Title: "Acme migration" },
        Customer: { Account: { CompanyName: "Acme Corp" } },
      }),
    getAwsOpportunitySummary:
      partial.getAwsOpportunitySummary ?? vi.fn().mockResolvedValue({}),
  };
  return { client: mocks as unknown as AceClient, mocks };
}

function buildHs(partial: Partial<HsMocks> = {}): {
  client: HubspotClient;
  mocks: HsMocks;
} {
  const mocks: HsMocks = {
    readDealProperties:
      partial.readDealProperties ??
      vi.fn().mockResolvedValue({
        ace_opportunity_id: "O123",
      }),
    readAssociatedCompany:
      partial.readAssociatedCompany ?? vi.fn().mockResolvedValue(undefined),
    writeDealProperties:
      partial.writeDealProperties ?? vi.fn().mockResolvedValue(undefined),
    findDealByAceOpportunityId:
      partial.findDealByAceOpportunityId ??
      vi.fn().mockResolvedValue(undefined),
    createDeal: partial.createDeal ?? vi.fn().mockResolvedValue(0),
  };
  return { client: mocks as unknown as HubspotClient, mocks };
}

function eventFor(
  oppId: string,
  detailType: AcePullEvent["detailType"] = "Opportunity Updated",
  catalog = "Sandbox"
): AcePullEvent {
  return {
    detailType,
    detail: { catalog, opportunity: { identifier: oppId } },
  };
}

function deps(ace: AceClient, hs: HubspotClient): PullDeps {
  return {
    config: BASE_CONFIG,
    ace,
    hs,
    lock: {
      tableName: "test-pull-locks",
      now: () => Date.parse("2026-05-18T18:00:00Z"),
      // Stub DynamoDB client: every send() resolves to {} so
      // acquireLock + release are no-ops in the default case. Tests
      // that care about lock contention override this.
      client: {
        send: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

beforeEach(() => {
  // Pull's snapshotToProps doesn't read clock, but Refresh writes
  // ace_last_sync; pin time so test logs are stable.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-18T18:00:00Z"));
});

describe("runPull — catalog filter", () => {
  test("event for non-stack catalog is skipped, not failed", async () => {
    const ace = buildAce();
    const hs = buildHs();

    const result = await runPull(
      eventFor("O999", "Opportunity Created", "AWS"),
      deps(ace.client, hs.client)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("skipped");
      expect(result.reason).toContain("AWS");
    }
    // No ACE / HubSpot side-effects.
    expect(hs.mocks.findDealByAceOpportunityId).not.toHaveBeenCalled();
    expect(ace.mocks.getOpportunity).not.toHaveBeenCalled();
    expect(hs.mocks.createDeal).not.toHaveBeenCalled();
  });

  test("missing opportunity.identifier returns INTERNAL", async () => {
    const ace = buildAce();
    const hs = buildHs();
    const result = await runPull(
      { detailType: "Opportunity Created", detail: { catalog: "Sandbox", opportunity: { identifier: "" } } },
      deps(ace.client, hs.client)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.INTERNAL);
    }
  });
});

describe("runPull — existing deal", () => {
  test("delegates to runRefresh and reports refreshed", async () => {
    // Refresh path: getOpportunity → getAwsOpportunitySummary →
    // writeDealProperties. We fake them all here. The pull-side
    // findDealByAceOpportunityId hit dictates which branch fires.
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LifeCycle: { Stage: "Qualified", ReviewStatus: "Approved" },
      }),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(424242),
      readDealProperties: vi
        .fn()
        .mockResolvedValue({ ace_opportunity_id: "O123" }),
    });

    const result = await runPull(
      eventFor("O123"),
      deps(ace.client, hs.client)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("refreshed");
      expect(result.dealId).toBe(424242);
    }
    // The auto-refresh wrote back the snapshot — that's the proof
    // runRefresh ran end-to-end.
    expect(hs.mocks.writeDealProperties).toHaveBeenCalledTimes(1);
    const [writtenDealId, written] = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writtenDealId).toBe(424242);
    expect(written.ace_sync_status).toBe("Synced");
    // No new deal was created.
    expect(hs.mocks.createDeal).not.toHaveBeenCalled();
  });

  test("propagates failure code from runRefresh", async () => {
    // Refresh fails at GetOpportunity → ACE_GET. The pull layer
    // should surface that code unchanged (operators can grep
    // CloudWatch by code).
    const ace = buildAce({
      getOpportunity: vi.fn().mockRejectedValue(new Error("ACE outage")),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(424242),
    });

    const result = await runPull(
      eventFor("O123"),
      deps(ace.client, hs.client)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.ACE_GET);
      expect(result.message).toContain("ACE outage");
    }
  });
});

describe("runPull — new deal", () => {
  test("creates HubSpot deal seeded from AWS state", async () => {
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        Id: "O77",
        LifeCycle: {
          Stage: "Qualified",
          ReviewStatus: "Submitted",
          TargetCloseDate: "2026-09-30",
        },
        Project: {
          Title: "Cloud migration for Beta Inc",
          CustomerBusinessProblem: "Move legacy on-prem to AWS",
          ExpectedCustomerSpend: [
            { Amount: "1500.0", CurrencyCode: "USD", Frequency: "Monthly" },
          ],
          OtherSolutionDescription: "Custom analytics rollout",
        },
        Customer: {
          Account: { CompanyName: "Beta Inc" },
        },
        RelatedEntityIdentifiers: { Solutions: ["S-0000001", "S-0000002"] },
      }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(undefined),
      createDeal: vi.fn().mockResolvedValue(800800),
    });

    const result = await runPull(
      eventFor("O77", "Opportunity Created"),
      deps(ace.client, hs.client)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("created");
      expect(result.dealId).toBe(800800);
    }
    expect(hs.mocks.createDeal).toHaveBeenCalledTimes(1);
    const [createdProps] = hs.mocks.createDeal.mock.calls[0];
    expect(createdProps.ace_opportunity_id).toBe("O77");
    expect(createdProps.dealname).toBe("Cloud migration for Beta Inc");
    expect(createdProps.submit_to_aws).toBeUndefined();
    // Solutions are mirrored as a `;`-separated string.
    expect(createdProps.ace_solutions).toBe("S-0000001;S-0000002");
    expect(createdProps.ace_other_solution_description).toBe(
      "Custom analytics rollout"
    );
    // AWS-derived TargetCloseDate flows through to HubSpot's closedate.
    expect(createdProps.closedate).toBe("2026-09-30");
    // Pipeline / dealstage applied via env defaults.
    expect(createdProps.pipeline).toBeDefined();
    expect(createdProps.dealstage).toBeDefined();
    // No refresh-write fired — Refresh path must not run on Create.
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });

  test("falls back to AWS company name when Project.Title is blank", async () => {
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        Id: "O88",
        LifeCycle: { Stage: "Qualified", ReviewStatus: "Submitted" },
        Project: { Title: "" },
        Customer: { Account: { CompanyName: "Gamma Co" } },
      }),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(undefined),
      createDeal: vi.fn().mockResolvedValue(900900),
    });

    const result = await runPull(eventFor("O88"), deps(ace.client, hs.client));
    expect(result.ok).toBe(true);
    const [props] = hs.mocks.createDeal.mock.calls[0];
    expect(props.dealname).toBe("Gamma Co");
  });

  test("ACE_GET failure on the create path surfaces ACE_GET", async () => {
    const ace = buildAce({
      getOpportunity: vi.fn().mockRejectedValue(new Error("AWS exploded")),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(undefined),
    });

    const result = await runPull(eventFor("O99"), deps(ace.client, hs.client));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.ACE_GET);
      expect(result.message).toContain("AWS exploded");
    }
    expect(hs.mocks.createDeal).not.toHaveBeenCalled();
  });

  test("HubSpot create failure surfaces HUBSPOT_WRITE", async () => {
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        Id: "Ofail",
        LifeCycle: { Stage: "Qualified" },
        Project: { Title: "x" },
        Customer: { Account: {} },
      }),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(undefined),
      createDeal: vi.fn().mockRejectedValue(new Error("HubSpot 503")),
    });

    const result = await runPull(
      eventFor("Ofail"),
      deps(ace.client, hs.client)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.HUBSPOT_WRITE);
      expect(result.message).toContain("HubSpot 503");
    }
  });

  test("missing AwsOpportunitySummary doesn't fail the create", async () => {
    // The summary fetch is best-effort — same as Refresh. A failure
    // there leaves InvolvementType / Visibility / Solutions blank
    // but creates the deal.
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        Id: "Onsum",
        LifeCycle: { Stage: "Qualified" },
        Project: { Title: "Title" },
        Customer: { Account: {} },
      }),
      getAwsOpportunitySummary: vi.fn().mockRejectedValue(new Error("nope")),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(undefined),
      createDeal: vi.fn().mockResolvedValue(11111),
    });

    const result = await runPull(eventFor("Onsum"), deps(ace.client, hs.client));
    expect(result.ok).toBe(true);
    expect(hs.mocks.createDeal).toHaveBeenCalledTimes(1);
  });

  test("defensive recheck before createDeal: if a parallel invocation already created the deal, switch to Refresh", async () => {
    // With the per-opp DynamoDB lock now wrapping the whole
    // orchestration, a parallel invocation on the same opp would
    // have failed at lock acquire and surfaced as `lock_held` (see
    // the next test). This test models a different scenario: a
    // sequential retry runs *after* the holder released, in which
    // case `findDealByAceOpportunityId` finds the freshly-created
    // deal on its first call and the runPull takes the Refresh
    // branch immediately (no createDeal).
    const findMock = vi.fn().mockResolvedValue(777777);
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const createMock = vi.fn().mockResolvedValue(0);
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        Id: "Orace",
        LifeCycle: { Stage: "Qualified" },
        Project: { Title: "Race winner" },
        Customer: { Account: { CompanyName: "Race Co" } },
      }),
    });
    const hs = buildHs({
      findDealByAceOpportunityId: findMock,
      readDealProperties: vi.fn().mockResolvedValue({
        ace_opportunity_id: "Orace",
      }),
      writeDealProperties: writeMock,
      createDeal: createMock,
    });

    const result = await runPull(eventFor("Orace"), deps(ace.client, hs.client));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("refreshed");
      expect(result.dealId).toBe(777777);
    }
    // Critical: no deal created — the existing one was found.
    expect(createMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalled();
    expect(writeMock.mock.calls[0][0]).toBe(777777);
  });

  test("lock contention: returns lock_held when another invocation holds the lock", async () => {
    // Simulate two PullLambda invocations firing for the same opp at
    // the same time. The DynamoDB conditional PutItem fails for the
    // second one with `ConditionalCheckFailedException`; the lock
    // module then peeks via GetItem to see if a dealId has been
    // cached. With no cache yet (the first invocation is still
    // mid-flight), the peek surfaces `LockHeldError`, runPull turns
    // it into a `lock_held` outcome, and the handler converts it to
    // a Lambda failure so EventBridge retries.
    const { ConditionalCheckFailedException } = await import(
      "@aws-sdk/client-dynamodb"
    );
    const lockClient = {
      send: vi
        .fn()
        // PutItem (acquire) — fails, the row is still live.
        .mockRejectedValueOnce(
          new ConditionalCheckFailedException({
            $metadata: {},
            message: "The conditional request failed",
          })
        )
        // GetItem (peek) — row exists but has no dealId yet.
        .mockResolvedValueOnce({
          Item: {
            oppId: { S: "Olocked" },
            expiresAt: { N: "9999999999" },
          },
        }),
    };
    const ace = buildAce();
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn(),
      createDeal: vi.fn(),
    });

    const result = await runPull(eventFor("Olocked"), {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
      lock: {
        tableName: "test-pull-locks",
        now: () => Date.parse("2026-05-18T18:00:00Z"),
        client: lockClient,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("lock_held");
    }
    // No HubSpot side-effects.
    expect(hs.mocks.findDealByAceOpportunityId).not.toHaveBeenCalled();
    expect(hs.mocks.createDeal).not.toHaveBeenCalled();
    expect(ace.mocks.getOpportunity).not.toHaveBeenCalled();
  });

  test("lock release: UpdateItem caches dealId on success even when the orchestration short-circuits early", async () => {
    // The lock must be released after the orchestration completes —
    // crashing or short-circuiting paths included. Verify that on
    // the existing-deal path (which short-circuits to runRefresh),
    // the DynamoDB client gets exactly two calls: PutItem (acquire)
    // and UpdateItem (release-with-cache, writing dealId so future
    // pull invocations skip the HubSpot search-index lag).
    const sendMock = vi.fn().mockResolvedValue({});
    const ace = buildAce();
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn().mockResolvedValue(424242),
      readDealProperties: vi.fn().mockResolvedValue({
        ace_opportunity_id: "Orelease",
      }),
      writeDealProperties: vi.fn().mockResolvedValue(undefined),
    });

    await runPull(eventFor("Orelease"), {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
      lock: {
        tableName: "test-pull-locks",
        now: () => Date.parse("2026-05-18T18:00:00Z"),
        client: { send: sendMock },
      },
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    // First call: PutItem (acquire).
    expect(sendMock.mock.calls[0][0].constructor.name).toBe(
      "PutItemCommand"
    );
    // Second call: UpdateItem (release-with-cache).
    const updateCmd = sendMock.mock.calls[1][0];
    expect(updateCmd.constructor.name).toBe("UpdateItemCommand");
    // The release writes the dealId so subsequent invocations get
    // a cache hit instead of going through HubSpot search.
    const exprValues = updateCmd.input.ExpressionAttributeValues;
    expect(exprValues[":did"].N).toBe("424242");
  });

  test("cache hit: lock contention with a cached dealId short-circuits to Refresh", async () => {
    // Models the HubSpot search-index lag race: invocation A finished
    // and cached the dealId in the lock row; invocation B starts
    // before HubSpot's search has propagated the new
    // `ace_opportunity_id`. Without the cache, B would search
    // HubSpot, miss, and create a duplicate. With the cache, B's
    // PutItem fails the conditional check, the GetItem peek returns
    // the cached dealId, and B runs Refresh against it.
    const { ConditionalCheckFailedException } = await import(
      "@aws-sdk/client-dynamodb"
    );
    const sendMock = vi
      .fn()
      // PutItem (acquire) — fails because the row is still live.
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        })
      )
      // GetItem (peek) — returns the cached dealId.
      .mockResolvedValueOnce({
        Item: {
          oppId: { S: "Ocache" },
          dealId: { N: "555555" },
          expiresAt: { N: "9999999999" },
        },
      });

    const ace = buildAce();
    const hs = buildHs({
      findDealByAceOpportunityId: vi.fn(),
      readDealProperties: vi.fn().mockResolvedValue({
        ace_opportunity_id: "Ocache",
      }),
      writeDealProperties: vi.fn().mockResolvedValue(undefined),
      createDeal: vi.fn(),
    });

    const result = await runPull(eventFor("Ocache"), {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
      lock: {
        tableName: "test-pull-locks",
        now: () => Date.parse("2026-05-18T18:00:00Z"),
        client: { send: sendMock },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("refreshed");
      expect(result.dealId).toBe(555555);
      expect(result.reason).toBe("cache_hit");
    }
    // Critical: HubSpot search bypassed entirely (would have lagged
    // and missed the new deal).
    expect(hs.mocks.findDealByAceOpportunityId).not.toHaveBeenCalled();
    expect(hs.mocks.createDeal).not.toHaveBeenCalled();
    // Refresh ran against the cached dealId.
    expect(hs.mocks.writeDealProperties.mock.calls[0][0]).toBe(555555);
  });
});

describe("runPull — search failure", () => {
  test("HubSpot search failure surfaces HUBSPOT_WRITE", async () => {
    const ace = buildAce();
    const hs = buildHs({
      findDealByAceOpportunityId: vi
        .fn()
        .mockRejectedValue(new Error("search 502")),
    });

    const result = await runPull(eventFor("Osrch"), deps(ace.client, hs.client));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.HUBSPOT_WRITE);
      expect(result.message).toContain("search 502");
    }
    // No create / refresh paths kicked off.
    expect(ace.mocks.getOpportunity).not.toHaveBeenCalled();
    expect(hs.mocks.createDeal).not.toHaveBeenCalled();
  });
});
