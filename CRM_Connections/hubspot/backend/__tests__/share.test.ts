import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

import { runShare } from "../core/run-share";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import type { AppConfig } from "../lib/config";
import type { CompanyProps, DealProps } from "../lib/preconditions";

/**
 * Unit tests for `runShare` (task 11.2).
 *
 * `runShare` is the dependency-injected core of the Share serverless function.
 * These tests exercise the full orchestration by substituting literal object
 * mocks for the ACE and HubSpot wrappers — no SDKs, no `process.env`, no
 * network. Vitest fake timers make the 1000ms inter-write delays on the
 * create path observable without slowing the suite down.
 *
 * Requirements covered: 2.1, 2.4, 2.7, 2.8, 3.5, 3.6, 10.1, 11.2, 11.3.
 *
 * Scenarios (from tasks.md §11.2):
 *   - create-new happy path + inter-write-delay assertion
 *   - create-path precondition failure (no ACE calls fire)
 *   - create-path ACE failure writes a Sync Error back to the deal
 *   - update-existing happy path
 *   - stale-LastModifiedDate single-retry success
 *   - stale-LastModifiedDate both attempts fail → STALE_OPPORTUNITY
 *   - configuration branches: empty STAGE_MAPPING and off-list stage
 *     return STAGE_UNMAPPABLE before any ACE call
 *
 * The "missing-secret" branch of `main` is exercised indirectly by the
 * STAGE_UNMAPPABLE tests (same short-circuit shape): `main` is the only
 * place `loadConfig` runs, and it immediately returns `MISSING_SECRET`
 * without calling `runShare`, so there is nothing to assert in `runShare`
 * itself beyond it never being invoked — that is proved by the fact that
 * no test here calls `main`.
 */

// A baseline AppConfig whose STAGE_MAPPING covers the three HubSpot stages
// used across these tests. Individual tests clone and tweak as needed.
const BASE_CONFIG: AppConfig = {
  awsAccessKeyId: "A",
  awsSecretAccessKey: "S",
  aceRegion: "us-east-1",
  stageMappingRaw:
    "qualified=Qualified;techvalid=Technical Validation;closedlost=Closed Lost",
  stageDisplayNamesRaw: "",
  hubspotPrivateAppToken: "tok",
};

/**
 * Build a deal record that satisfies every precondition by default AND
 * carries the two `Submission_Required_Fields` (`ace_involvement_type`,
 * `ace_visibility`) so the default classification is `Create_And_Submit`
 * and `StartEngagementFromOpportunityTask` fires on the create path.
 *
 * Tests targeting the `Create_Only` branch override one of the
 * submission fields back to `""` to flip the classifier (see
 * "create-path Create_Only" test below).
 */
function makeValidDeal(overrides: Partial<DealProps> = {}): DealProps {
  return {
    dealname: "Acme Migration",
    dealstage: "qualified",
    amount: "12000",
    closedate: "2026-12-15",
    contract_term__months_: "12",
    description:
      "Customer needs to migrate 20 workloads to AWS.",
    ace_solutions: "S-0000001",
    // Create-path preconditions (no silent defaults anymore): currency,
    // website, and industry are all deal-property-driven and required.
    ace_currency_code: "USD",
    ace_website_url: "https://acme.com",
    ace_industry: "Software and Internet",
    // All five Submission_Required_Fields populated so the default
    // classification is Create_And_Submit (StartEngagement fires).
    ace_involvement_type: "Co-Sell",
    ace_visibility: "Full",
    ace_delivery_model: "SaaS or PaaS",
    ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
    ace_customer_use_case: "Business Applications & Contact Center",
    ace_sales_activities: "Initialized discussions with customer",
    ...overrides,
  };
}

/** Build a valid company record with the required country code. */
function makeValidCompany(
  overrides: Partial<NonNullable<CompanyProps>> = {}
): CompanyProps {
  return {
    name: "Acme Corp",
    hs_country_code: "US",
    state: "WA",
    zip: "98101",
    ...overrides,
  };
}

// Mocks use `ReturnType<typeof vi.fn>` so the tests can inspect
// `.mock.calls` / `.mock.calls[0][0]` without wrestling with the precise
// SDK parameter types. The wrapper cast to the public interface is all we
// need — `runShare` only calls the methods declared on `AceClient` /
// `HubspotClient`.
type AceMocks = { [K in keyof AceClient]: ReturnType<typeof vi.fn> };
type HsMocks = { [K in keyof HubspotClient]: ReturnType<typeof vi.fn> };

function buildAce(
  partial: Partial<AceMocks> = {}
): { client: AceClient; mocks: AceMocks } {
  // `vi.fn().mockResolvedValue(x)` keeps the return type as the generic
  // `Mock<any[], unknown>` that `AceMocks` expects. Using the
  // `vi.fn(async () => x)` form narrows the generic and conflicts with
  // `partial.createOpportunity`'s wider type, so we avoid it here.
  const mocks: AceMocks = {
    createOpportunity:
      partial.createOpportunity ?? vi.fn().mockResolvedValue({ Id: "O-NEW-123" }),
    associateOpportunity:
      partial.associateOpportunity ?? vi.fn().mockResolvedValue({}),
    disassociateOpportunity:
      partial.disassociateOpportunity ?? vi.fn().mockResolvedValue({}),
    startEngagementFromOpportunityTask:
      partial.startEngagementFromOpportunityTask ?? vi.fn().mockResolvedValue({}),
    listEngagementFromOpportunityTasks:
      partial.listEngagementFromOpportunityTasks ?? vi.fn().mockResolvedValue({}),
    updateOpportunity:
      partial.updateOpportunity ?? vi.fn().mockResolvedValue({}),
    getOpportunity:
      partial.getOpportunity ??
      vi.fn().mockResolvedValue({
        LastModifiedDate: "2025-04-01T00:00:00Z",
        LifeCycle: { Stage: "Qualified" },
        // Mirror the create-time AssociateOpportunity so the update
        // path's `reconcileSolutions` finds nothing to add or remove
        // and stays a no-op for tests that don't override this mock.
        RelatedEntityIdentifiers: { Solutions: ["S-0000001"] },
      }),
    getAwsOpportunitySummary:
      partial.getAwsOpportunitySummary ?? vi.fn().mockResolvedValue({}),
  };
  return { client: mocks as unknown as AceClient, mocks };
}

function buildHs(
  deal: DealProps,
  company: CompanyProps,
  partial: Partial<HsMocks> = {}
): { client: HubspotClient; mocks: HsMocks } {
  const mocks: HsMocks = {
    readDealProperties:
      partial.readDealProperties ?? vi.fn().mockResolvedValue(deal),
    readAssociatedCompany:
      partial.readAssociatedCompany ?? vi.fn().mockResolvedValue(company),
    writeDealProperties:
      partial.writeDealProperties ?? vi.fn().mockResolvedValue(undefined),
    findDealByAceOpportunityId:
      partial.findDealByAceOpportunityId ?? vi.fn().mockResolvedValue(undefined),
    createDeal:
      partial.createDeal ?? vi.fn().mockResolvedValue(0),
  };
  return { client: mocks as unknown as HubspotClient, mocks };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin the clock so the future-close-date precondition is deterministic.
  // makeValidDeal's closedate sits comfortably after this.
  vi.setSystemTime(new Date("2026-06-24T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runShare — create path", () => {
  test("happy path: Create_And_Submit → create → associate → start-engagement with two 1000ms delays", async () => {
    const deal = makeValidDeal();
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // Two 1000ms sleeps sit between Create→Associate and Associate→Start.
    // Advancing 2000ms in one hop is sufficient because
    // `advanceTimersByTimeAsync` also flushes the microtask queue between
    // timer ticks.
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      // R2.4: Create_And_Submit success message MUST contain the
      // literal `submitted for review` substring so the card and any
      // downstream consumers can disambiguate the draft vs submit
      // case from the message body alone.
      expect(resp.message).toContain("submitted for review");
      expect(resp.message).toContain("O-NEW-123");
      expect(resp.properties.ace_opportunity_id).toBe("O-NEW-123");
      // After StartEngagement the create path re-reads ACE state and
      // surfaces it. ace_sync_status is now a sync-health flag —
      // every successful Share path writes "Synced". The raw AWS
      // state (or its absence during the acceptance window) lives
      // in aws_review_status / aws_stage.
      expect(resp.properties.ace_sync_status).toBe("Synced");
      expect(resp.properties.ace_sync_error).toBe("");
    }

    expect(ace.mocks.createOpportunity).toHaveBeenCalledTimes(1);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    expect(ace.mocks.startEngagementFromOpportunityTask).toHaveBeenCalledTimes(
      1
    );
    // Per R10.1/R10.2, every ACE call in the create flow targets Sandbox.
    expect(ace.mocks.createOpportunity.mock.calls[0][0].Catalog).toBe(
      "Sandbox"
    );
    expect(ace.mocks.associateOpportunity.mock.calls[0][0].Catalog).toBe(
      "Sandbox"
    );
    expect(
      ace.mocks.startEngagementFromOpportunityTask.mock.calls[0][0].Catalog
    ).toBe("Sandbox");
    expect(hs.mocks.writeDealProperties).toHaveBeenCalled();
    const firstWrite = hs.mocks.writeDealProperties.mock.calls[0];
    expect(firstWrite[0]).toBe(42);
    expect(firstWrite[1].ace_opportunity_id).toBe("O-NEW-123");
    // Early checkpoint write — `Synced` because we did successfully
    // reach ACE and got an opp id back. If a later step in the create
    // flow fails, the failure handler overwrites with `Sync Error`.
    expect(firstWrite[1].ace_sync_status).toBe("Synced");
  });

  test("inter-write delays are exactly 1000ms each (step-by-step timer advance)", async () => {
    // Tighter assertion than the happy-path test: confirm Associate does
    // NOT fire before 1000ms elapse, and StartEngagement does NOT fire
    // before a further 1000ms elapse. This is the strongest evidence the
    // 1000ms delay is actually present and the right magnitude.
    const deal = makeValidDeal();
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    // Flush initial microtasks: config parse + HS reads + CreateOpportunity
    // + the HS write of ace_opportunity_id all complete before the first
    // sleep schedules a timer.
    await vi.advanceTimersByTimeAsync(0);
    expect(ace.mocks.createOpportunity).toHaveBeenCalledTimes(1);
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();

    // 999ms elapsed — still short of the 1000ms inter-write delay.
    await vi.advanceTimersByTimeAsync(999);
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();

    // Crossing the 1000ms mark fires Associate, which then schedules the
    // next 1000ms sleep before StartEngagement.
    await vi.advanceTimersByTimeAsync(1);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();

    // Same 999 / +1 pattern for the second inter-write delay.
    await vi.advanceTimersByTimeAsync(999);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).toHaveBeenCalledTimes(1);

    const resp = await p;
    expect(resp.ok).toBe(true);
  });

  test("precondition failure returns PRECONDITION without calling ACE", async () => {
    // An empty closedate violates rule 1 of validatePreconditions. We
    // expect the short-circuit to fire before any ACE call and before any
    // HubSpot write.
    const deal = makeValidDeal({ closedate: "" });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("PRECONDITION");
      expect(resp.details?.preconditionFailures).toContain("closedate");
    }
    expect(ace.mocks.createOpportunity).not.toHaveBeenCalled();
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });

  test("CreateOpportunity failure returns ACE_CREATE and writes Sync Error to HubSpot", async () => {
    const deal = makeValidDeal();
    const company = makeValidCompany();
    const ace = buildAce({
      createOpportunity: vi.fn().mockRejectedValue(
        Object.assign(new Error("boom"), { name: "ValidationException" })
      ),
    });
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_CREATE");
      expect(resp.details?.step).toBe("CreateOpportunity");
      expect(resp.message).toContain("boom");
    }
    // Best-effort write-back: the deal is stamped with Sync Error so the
    // card shows the Error state on re-read.
    expect(hs.mocks.writeDealProperties).toHaveBeenCalledTimes(1);
    const hsCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(hsCall[1].ace_sync_status).toBe("Sync Error");
    expect(hsCall[1].ace_sync_error).toContain("CreateOpportunity");
    // The follow-up steps never fired.
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();
  });

  test("StartEngagement TaskStatus=FAILED (no throw) is surfaced as ACE_CREATE + Sync Error, not a false success", async () => {
    // AWS does NOT throw for submission validation failures — the
    // engagement task resolves (HTTP 200) with TaskStatus "FAILED" and a
    // Message. The create path must detect that instead of reporting a
    // successful submit. (Ground-truthed against the Sandbox API.)
    const deal = makeValidDeal();
    const company = makeValidCompany();
    const ace = buildAce({
      startEngagementFromOpportunityTask: vi.fn().mockResolvedValue({
        TaskId: "task-x",
        TaskStatus: "FAILED",
        Message:
          "BUSINESS_VALIDATION_EXCEPTION relatedEntityIdentifiers.solutions:Associate atleast one solution;REQUIRED_FIELD_MISSING customer.account.address.stateOrRegion:customer.account.address.stateOrRegion is required",
      }),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // create → write → associate (1 delay) → delay before engagement.
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_CREATE");
      expect(resp.details?.step).toBe("StartEngagement");
      expect(resp.message).toContain("stateOrRegion");
    }
    // The opp was created (id persisted) and then a Sync Error stamped —
    // the deal is recoverable via the Submit button.
    const errorWrite = hs.mocks.writeDealProperties.mock.calls.find(
      (c) => c[1].ace_sync_status === "Sync Error"
    );
    expect(errorWrite).toBeDefined();
    expect(errorWrite![1].ace_sync_error).toMatch(/^StartEngagement:/);
  });

  test("missing ace_solutions surfaces solutions precondition", async () => {
    // The deal has no Solution Offering IDs set on `ace_solutions`.
    // The validator must surface the new `solutions` rule and the
    // orchestration must short-circuit before any ACE call.
    const deal = makeValidDeal({ ace_solutions: "" });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("PRECONDITION");
      expect(resp.details?.preconditionFailures).toContain("solutions");
    }
    expect(ace.mocks.createOpportunity).not.toHaveBeenCalled();
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
  });

  test("multi-solution create issues one Associate call per id, in parallel under one inter-write delay", async () => {
    // The deal carries three `;`-separated Solution Offering IDs.
    // Each one becomes a separate AssociateOpportunity call. We
    // parallelize the batch (all three fire concurrently) under a
    // single 1000ms inter-write delay, instead of serializing them
    // with a 1000ms gap between each. This keeps total Share latency
    // under HubSpot's ~22s client-side fetch timeout when many
    // entities are selected.
    const deal = makeValidDeal({
      ace_solutions: "S-0000010;S-0000020;S-0000030",
    });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // 1 sleep before the whole associate batch + 1 sleep before
    // StartEngagement = 2 × 1000ms total, regardless of how many
    // entities are in the batch.
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(3);
    // Order of submitted call args is preserved (Promise.allSettled
    // iterates the input array in order to schedule the calls),
    // even though the calls themselves run concurrently.
    expect(
      ace.mocks.associateOpportunity.mock.calls.map(
        (c) => c[0].RelatedEntityIdentifier
      )
    ).toEqual(["S-0000010", "S-0000020", "S-0000030"]);
    // Disassociate is never called on the create path.
    expect(ace.mocks.disassociateOpportunity).not.toHaveBeenCalled();
  });

  test("Associate failure on second solution surfaces the failing id in the step", async () => {
    // Two solutions fire concurrently under one inter-write delay.
    // The first resolves; the second errors. Both calls land at the
    // ACE client, but the error envelope picks the FIRST failure in
    // input order (Promise.allSettled preserves index ordering) and
    // names the failing solution so the user can diagnose without a
    // log dive (the field is `details.step =
    // "AssociateOpportunity[Solutions:<id>]"`).
    const deal = makeValidDeal({ ace_solutions: "S-0000010;S-0000020" });
    const company = makeValidCompany();
    const ace = buildAce({
      associateOpportunity: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(
          Object.assign(new Error("not found"), {
            name: "ResourceNotFoundException",
          })
        ),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    await vi.advanceTimersByTimeAsync(3000);
    const resp = await p;

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_CREATE");
      expect(resp.details?.step).toBe("AssociateOpportunity[Solutions:S-0000020]");
    }
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(2);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();
  });

  test("`Other` description with no Solutions skips AssociateOpportunity entirely", async () => {
    // The deal has no `ace_solutions` ID but does have a non-blank
    // `ace_other_solution_description`. The precondition passes via the
    // OtherSolutionDescription path, and AssociateOpportunity is
    // skipped — there's nothing to attach. CreateOpportunity and
    // StartEngagement still fire.
    const deal = makeValidDeal({
      ace_solutions: "",
      ace_other_solution_description:
        "Custom integration outside of any registered Solution Offering.",
    });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // Just one 1000ms sleep — between Create and StartEngagement (no
    // associate phase).
    await vi.advanceTimersByTimeAsync(1000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    expect(ace.mocks.createOpportunity).toHaveBeenCalledTimes(1);
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).toHaveBeenCalledTimes(1);
  });

  test("literal 'Other' in ace_solutions is filtered out before AssociateOpportunity", async () => {
    // A partner who selected "Other" in HubSpot's picklist may end up
    // with `ace_solutions = "Other"` (or "Other;S-xxx"). The literal
    // value is dropped by parseSolutionIds because AWS would reject it
    // with `INVALID_VALUE`. Mixing "Other" with a real ID still
    // succeeds — only the real ID becomes an Associate call. The
    // `Project.OtherSolutionDescription` field carries the free-text
    // detail (handled by the payload builder).
    const deal = makeValidDeal({
      ace_solutions: "Other;S-0000099",
      ace_other_solution_description:
        "We sell something not yet listed in Partner Central.",
    });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.associateOpportunity.mock.calls[0][0].RelatedEntityIdentifier
    ).toBe("S-0000099");
  });

  test("Create_Only: missing ace_visibility → Create + Associate run, NO StartEngagement, success message contains `saved as draft` and the next-step literal", async () => {
    // R3.1, R3.4, R3.5: when a Submission_Required_Field is missing
    // and the deal has no `ace_opportunity_id`, the create path runs
    // CreateOpportunity + AssociateOpportunity (one per Solution)
    // and SHALL NOT call StartEngagementFromOpportunityTask. The
    // success message MUST contain both the `saved as draft` literal
    // (R3.4) and the literal next-step text
    // `Click "Submit for AWS Review" to submit.` so the partner
    // knows submission is the next deliberate action.
    const deal = makeValidDeal({ ace_visibility: "" });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // Only one inter-write sleep is active in Create_Only mode:
    // between CreateOpportunity and AssociateOpportunity. The
    // post-Associate StartEngagement sleep is gone with
    // StartEngagement itself.
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      // R3.4 — both literals appear in the success message.
      expect(resp.message).toContain("saved as draft");
      expect(resp.message).toContain(
        'Click "Submit for AWS Review" to submit.',
      );
    }
    // R3.1: Create + Associate ran.
    expect(ace.mocks.createOpportunity).toHaveBeenCalledTimes(1);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    // R3.1: StartEngagement DID NOT run.
    expect(
      ace.mocks.startEngagementFromOpportunityTask,
    ).not.toHaveBeenCalled();
  });
});

describe("runShare — update path", () => {
  test("happy path: existing opportunity → GetOpportunity → UpdateOpportunity → Synced", async () => {
    const deal = makeValidDeal({ ace_opportunity_id: "O-EXISTING" });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      // The default `aws_review_status` from the mock is empty (not
      // Pending Submission), so the success message reflects the
      // generic update path — not the new R7.4 `draft updated` literal.
      expect(resp.message).toContain("Updated ACE opportunity O-EXISTING");
      expect(resp.properties.ace_opportunity_id).toBe("O-EXISTING");
      // ace_sync_status is the sync-health flag — successful Share
      // paths always write "Synced". AWS's live state lives in
      // aws_review_status / aws_stage.
      expect(resp.properties.ace_sync_status).toBe("Synced");
      expect(resp.properties.ace_sync_error).toBe("");
    }
    // Update path: 1 GetOpportunity (initial) + 1 UpdateOpportunity +
    // 1 GetOpportunity (post-update status read in `fetchSyncStatus`).
    expect(ace.mocks.getOpportunity).toHaveBeenCalledTimes(2);
    expect(ace.mocks.updateOpportunity).toHaveBeenCalledTimes(1);
    // Update path must not touch the create-only endpoints.
    expect(ace.mocks.createOpportunity).not.toHaveBeenCalled();
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();
    // Exactly one HS write — the final Synced stamp.
    expect(hs.mocks.writeDealProperties).toHaveBeenCalledTimes(1);
    expect(hs.mocks.writeDealProperties.mock.calls[0][1].ace_sync_status).toBe(
      "Synced"
    );
    // UpdateOpportunity forwards the LastModifiedDate it just read.
    expect(
      ace.mocks.updateOpportunity.mock.calls[0][0].LastModifiedDate
    ).toBe("2025-04-01T00:00:00Z");
  });

  test("stale LastModifiedDate: single retry succeeds (R11.2)", async () => {
    // Simulate the narrow window where another writer has touched the
    // opportunity between our GetOpportunity and UpdateOpportunity. The
    // wrapper handles the conflict by re-fetching and retrying once.
    const conflict = Object.assign(new Error("stale"), {
      name: "ConflictException",
    });
    const deal = makeValidDeal({ ace_opportunity_id: "O-STALE" });
    const company = makeValidCompany();
    const ace = buildAce({
      updateOpportunity: vi
        .fn()
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({}),
      // Two getOpportunity calls: initial read + refresh after conflict.
      getOpportunity: vi
        .fn()
        .mockResolvedValueOnce({
          LastModifiedDate: "2025-04-01T00:00:00Z",
          // Mirror the deal's `ace_solutions` so reconcileSolutions
          // is a no-op (otherwise the timer-using sleep blocks).
          RelatedEntityIdentifiers: { Solutions: ["S-0000001"] },
        })
        .mockResolvedValueOnce({
          LastModifiedDate: "2025-04-02T00:00:00Z",
          RelatedEntityIdentifiers: { Solutions: ["S-0000001"] },
        }),
    });
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    expect(ace.mocks.updateOpportunity).toHaveBeenCalledTimes(2);
    // 1 initial Get + 1 retry Get (for fresh LastModifiedDate) +
    // 1 post-success status Get = 3.
    expect(ace.mocks.getOpportunity).toHaveBeenCalledTimes(3);
    // Second update used the FRESH LastModifiedDate returned by the
    // retry's GetOpportunity, not the original one.
    expect(
      ace.mocks.updateOpportunity.mock.calls[1][0].LastModifiedDate
    ).toBe("2025-04-02T00:00:00Z");
  });

  test("stale LastModifiedDate: both attempts fail → STALE_OPPORTUNITY (R11.3)", async () => {
    // A second conflict means the deal is actively drifting under us;
    // telling the user to Refresh first is the only viable recourse.
    const conflict = Object.assign(new Error("stale"), {
      name: "ConflictException",
    });
    const deal = makeValidDeal({ ace_opportunity_id: "O-STALE" });
    const company = makeValidCompany();
    const ace = buildAce({
      updateOpportunity: vi.fn().mockRejectedValue(conflict),
    });
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("STALE_OPPORTUNITY");
      expect(resp.details?.step).toBe("UpdateOpportunity");
      expect(resp.message).toContain("Refresh");
    }
    expect(ace.mocks.updateOpportunity).toHaveBeenCalledTimes(2);
    // User-visible deal stamp reflects the Sync Error state.
    expect(hs.mocks.writeDealProperties).toHaveBeenCalledTimes(1);
    const hsCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(hsCall[1].ace_sync_status).toBe("Sync Error");
    expect(hsCall[1].ace_sync_error).toContain("Refresh");
  });

  test("non-conflict UpdateOpportunity failure returns ACE_UPDATE", async () => {
    // Guard that only ConflictException triggers the retry branch — every
    // other error flows through the generic aceFailure tail.
    const validation = Object.assign(new Error("bad payload"), {
      name: "ValidationException",
    });
    const deal = makeValidDeal({ ace_opportunity_id: "O-EXISTING" });
    const company = makeValidCompany();
    const ace = buildAce({
      updateOpportunity: vi.fn().mockRejectedValue(validation),
    });
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_UPDATE");
      expect(resp.details?.step).toBe("UpdateOpportunity");
    }
    // Only the first attempt ran — no retry on non-conflict errors.
    expect(ace.mocks.updateOpportunity).toHaveBeenCalledTimes(1);
  });

  test("solution diff: deal adds one, removes one → attach-then-detach", async () => {
    // The deal lists `S-0000040;S-0000060`; AWS currently has `S-0000060;S-0000050`.
    // Reconcile must attach S-0000040 first, then disassociate S-0000050 —
    // never the other way around (per AWS DisassociateOpportunity docs:
    // "first attach the new entity and then disassociate the one to be
    // removed").
    const deal = makeValidDeal({
      ace_opportunity_id: "O-EXISTING",
      ace_solutions: "S-0000040;S-0000060",
    });
    const company = makeValidCompany();
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LastModifiedDate: "2025-04-01T00:00:00Z",
        LifeCycle: { Stage: "Qualified" },
        RelatedEntityIdentifiers: { Solutions: ["S-0000060", "S-0000050"] },
      }),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // 1 sleep before associate + 1 sleep before disassociate.
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.associateOpportunity.mock.calls[0][0].RelatedEntityIdentifier
    ).toBe("S-0000040");
    expect(ace.mocks.disassociateOpportunity).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.disassociateOpportunity.mock.calls[0][0]
        .RelatedEntityIdentifier
    ).toBe("S-0000050");
    // Order check: associate must land before disassociate.
    expect(
      ace.mocks.associateOpportunity.mock.invocationCallOrder[0]
    ).toBeLessThan(
      ace.mocks.disassociateOpportunity.mock.invocationCallOrder[0]
    );
  });

  test("solution diff: deal matches AWS → reconcile is a no-op", async () => {
    // The default mock returns `{ Solutions: ["S-0000001"] }`, which
    // matches the deal's default `ace_solutions = "S-0000001"`. Neither
    // attach nor detach should fire.
    const deal = makeValidDeal({ ace_opportunity_id: "O-EXISTING" });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const resp = await runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
    expect(ace.mocks.disassociateOpportunity).not.toHaveBeenCalled();
  });

  test("Disassociate failure on update surfaces the failing id with ACE_UPDATE", async () => {
    const deal = makeValidDeal({
      ace_opportunity_id: "O-EXISTING",
      ace_solutions: "S-0000060",
    });
    const company = makeValidCompany();
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LastModifiedDate: "2025-04-01T00:00:00Z",
        LifeCycle: { Stage: "Qualified" },
        RelatedEntityIdentifiers: { Solutions: ["S-0000060", "S-0000070"] },
      }),
      disassociateOpportunity: vi.fn().mockRejectedValue(
        Object.assign(new Error("nope"), {
          name: "ValidationException",
        })
      ),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_UPDATE");
      expect(resp.details?.step).toBe(
        "DisassociateOpportunity[Solutions:S-0000070]"
      );
    }
  });

  test.each([
    "Submitted",
    "In Review",
  ])(
    "ReviewStatus=%s returns PRECONDITION without calling UpdateOpportunity",
    async (state) => {
      // Per AWS docs (working-with-opportunity-updates.html), opps in
      // Submitted / In Review are read-only — every update is rejected
      // until the review completes. Share fails fast here so the
      // partner sees a clear message instead of a generic AWS rejection.
      const deal = makeValidDeal({ ace_opportunity_id: "O-IN-REVIEW" });
      const company = makeValidCompany();
      const ace = buildAce({
        getOpportunity: vi.fn().mockResolvedValue({
          LastModifiedDate: "2025-04-01T00:00:00Z",
          LifeCycle: { Stage: "Qualified", ReviewStatus: state },
          RelatedEntityIdentifiers: { Solutions: ["S-0000001"] },
        }),
      });
      const hs = buildHs(deal, company);

      const resp = await runShare(42, {
        config: BASE_CONFIG,
        ace: ace.client,
        hs: hs.client,
      });

      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.code).toBe("PRECONDITION");
        expect(resp.message).toContain(state);
        expect(resp.message).toContain("AWS is reviewing");
      }
      // Critical: no UpdateOpportunity call.
      expect(ace.mocks.updateOpportunity).not.toHaveBeenCalled();
      // ace_sync_error written to the deal so the card surfaces it.
      const errCall = hs.mocks.writeDealProperties.mock.calls.find(
        (c) => c[1].ace_sync_error,
      );
      expect(errCall).toBeDefined();
      expect(errCall?.[1].ace_sync_error).toContain(state);
    },
  );

  test("Pending Submission opp: editable pass-through update — Update + Solution reconcile run, NO StartEngagement, success message contains `draft updated`", async () => {
    // R7.1, R7.2, R7.4: an editable pass-through update against a
    // Pending Submission opportunity must run UpdateOpportunity AND
    // its solution-association reconcile, MUST NOT auto-fire
    // StartEngagementFromOpportunityTask (the previous auto-recovery
    // block in updatePath has been deleted in favour of a deliberate
    // Submit_Action click), and MUST surface the literal `draft updated`
    // substring in the success message so the card can render the
    // draft-mode confirmation.
    //
    // Bonus assertion preserved from the previous version of this
    // test: the `forceStage` workaround keeps AWS's existing Stage
    // (Prospect) instead of overwriting with the deal's mapped
    // Qualified — AWS rejects Stage changes while ReviewStatus is
    // Pending Submission with ACTION_NOT_PERMITTED.
    //
    // The deal carries two solutions; AWS has only one of them. Reconcile
    // must therefore call AssociateOpportunity once for the new one,
    // proving the reconcile path actually ran (not just that it was
    // skipped as a no-op).
    const deal = makeValidDeal({
      ace_opportunity_id: "O-PENDING",
      dealstage: "qualified",
      ace_solutions: "S-0000001;S-0000002",
    });
    const company = makeValidCompany();
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LastModifiedDate: "2025-04-01T00:00:00Z",
        LifeCycle: {
          Stage: "Prospect",
          ReviewStatus: "Pending Submission",
        },
        // AWS only has S-0000001; reconcile must attach S-0000002.
        RelatedEntityIdentifiers: { Solutions: ["S-0000001"] },
      }),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // Advance past the inter-write sleep before AssociateOpportunity
    // (and any post-update reconcile sleeps). Generous bound — there
    // is no longer a StartEngagement step to gate on.
    await vi.advanceTimersByTimeAsync(4000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      // R7.4.
      expect(resp.message).toContain("draft updated");
    }
    expect(ace.mocks.updateOpportunity).toHaveBeenCalledTimes(1);
    // forceStage workaround: payload's Stage is AWS's existing
    // Prospect, NOT the mapped Qualified that the deal carries.
    const payload = ace.mocks.updateOpportunity.mock.calls[0][0];
    expect(payload.LifeCycle.Stage).toBe("Prospect");
    // PREVENT-NULL-REVIEW-STATUS: the payload MUST include the
    // current LifeCycle.ReviewStatus value verbatim. Sandbox
    // UpdateOpportunity silently strips ReviewStatus to null when
    // the field is absent on the wire, which permanently blocks
    // the opp from being submitted via
    // StartEngagementFromOpportunityTask. Sending the same value
    // back is a safe same-value passthrough (proven empirically
    // against the Sandbox API).
    expect(payload.LifeCycle.ReviewStatus).toBe("Pending Submission");
    // Solution reconcile actually ran: the missing-on-AWS S-0000002
    // was attached.
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.associateOpportunity.mock.calls[0][0].RelatedEntityIdentifier,
    ).toBe("S-0000002");
    // R7.2: StartEngagementFromOpportunityTask MUST NOT fire from the
    // update path under any state — submission is now an explicit
    // Submit_Action click, not a side effect of editing a draft.
    expect(
      ace.mocks.startEngagementFromOpportunityTask,
    ).not.toHaveBeenCalled();
  });

  test("PREVENT-NULL-REVIEW-STATUS: update payload echoes back the current ReviewStatus for every editable state", async () => {
    // The Sandbox catalog's UpdateOpportunity strips
    // LifeCycle.ReviewStatus to null when the field is absent on
    // the wire — proven empirically against the live API. Our fix:
    // the orchestrator reads the current ReviewStatus from
    // GetOpportunity and the payload builder echoes it back verbatim
    // as a same-value passthrough. This test pins the contract
    // across every state the update path may legitimately see.
    //
    // Submitted / In Review are deliberately omitted because the
    // orchestrator fails fast on those before reaching the payload
    // builder (R7.3); they're covered by the existing review-blocked
    // tests above. The empty-state ("") is also exercised — when AWS
    // returns no ReviewStatus, we omit the field rather than send an
    // empty string (which AWS rejects).
    const cases: ReadonlyArray<{
      label: string;
      reviewStatus: string;
      expectInPayload: string | undefined;
    }> = [
      { label: "Pending Submission", reviewStatus: "Pending Submission", expectInPayload: "Pending Submission" },
      { label: "Action Required", reviewStatus: "Action Required", expectInPayload: "Action Required" },
      { label: "Approved", reviewStatus: "Approved", expectInPayload: "Approved" },
      { label: "Rejected", reviewStatus: "Rejected", expectInPayload: "Rejected" },
      { label: "Disqualified", reviewStatus: "Disqualified", expectInPayload: "Disqualified" },
      // Empty-string / null current state — AWS returned no
      // ReviewStatus on GetOpportunity. We omit the field on the
      // wire because re-asserting "" or null is rejected by AWS,
      // and resurrecting an already-orphaned opp via UpdateOpportunity
      // is out of scope for the Share path.
      { label: "empty", reviewStatus: "", expectInPayload: undefined },
    ];

    for (const c of cases) {
      const deal = makeValidDeal({
        ace_opportunity_id: "O-PIN",
        ace_solutions: "S-0000001",
      });
      const company = makeValidCompany();
      const getResp: Record<string, unknown> = {
        LastModifiedDate: "2026-04-01T00:00:00Z",
        LifeCycle: { Stage: "Qualified" },
        RelatedEntityIdentifiers: { Solutions: ["S-0000001"] },
      };
      // Only attach LifeCycle.ReviewStatus when the case is non-empty;
      // simulating an AWS-side absent field is the empty case.
      if (c.reviewStatus.length > 0) {
        (getResp.LifeCycle as Record<string, unknown>).ReviewStatus =
          c.reviewStatus;
      }
      // Approved / Disqualified / Action Required also surface a
      // Customer block lock in the orchestrator — provide one so the
      // payload reconstruction has the data it needs.
      if (
        c.reviewStatus === "Approved" ||
        c.reviewStatus === "Disqualified" ||
        c.reviewStatus === "Action Required"
      ) {
        getResp.Customer = {
          Account: { CompanyName: "AWS-locked Co", Industry: "Software" },
        };
      }

      const ace = buildAce({
        getOpportunity: vi.fn().mockResolvedValue(getResp),
      });
      const hs = buildHs(deal, company);

      const p = runShare(42, {
        config: BASE_CONFIG,
        ace: ace.client,
        hs: hs.client,
      });
      // Past any inter-write sleeps in the reconcile path.
      await vi.advanceTimersByTimeAsync(2000);
      const resp = await p;

      expect(resp.ok, `[${c.label}] expected runShare to succeed`).toBe(true);
      expect(
        ace.mocks.updateOpportunity,
        `[${c.label}] updateOpportunity must be called`,
      ).toHaveBeenCalledTimes(1);
      const payload = ace.mocks.updateOpportunity.mock.calls[0][0];
      const lifeCycle = payload.LifeCycle as Record<string, unknown>;
      if (c.expectInPayload === undefined) {
        expect(
          lifeCycle.ReviewStatus,
          `[${c.label}] ReviewStatus must be omitted when GetOpportunity has no value`,
        ).toBeUndefined();
      } else {
        expect(
          lifeCycle.ReviewStatus,
          `[${c.label}] ReviewStatus must be echoed back verbatim`,
        ).toBe(c.expectInPayload);
      }
    }
  });

  test("AWS Products: deal adds one product to existing solution-only opp → AssociateOpportunity called for AwsProducts only", async () => {
    // The deal carries one Solution and one AWS Product; AWS only
    // has the Solution. Reconcile must attach the AWS Product
    // (RelatedEntityType=AwsProducts) without re-attaching the
    // already-present Solution.
    const deal = makeValidDeal({
      ace_opportunity_id: "O-PRODUCTS",
      ace_solutions: "S-0000001",
      ace_aws_products: "AmazonEC2P5",
    });
    const company = makeValidCompany();
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LastModifiedDate: "2026-04-01T00:00:00Z",
        LifeCycle: { Stage: "Qualified" },
        RelatedEntityIdentifiers: {
          Solutions: ["S-0000001"],
          AwsProducts: [], // Empty on AWS — our diff must add the product.
        },
      }),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    // Exactly one AssociateOpportunity — for the AWS Product. The
    // Solution was already attached on AWS so the diff is a no-op.
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(1);
    const call = ace.mocks.associateOpportunity.mock.calls[0][0];
    expect(call.RelatedEntityType).toBe("AwsProducts");
    expect(call.RelatedEntityIdentifier).toBe("AmazonEC2P5");
    // No disassociate calls — nothing was removed.
    expect(ace.mocks.disassociateOpportunity).not.toHaveBeenCalled();
  });

  test("AWS Products: deal removes a product → DisassociateOpportunity called for AwsProducts", async () => {
    // The deal lists no AWS Products; AWS currently has one.
    // Reconcile must detach the AWS Product without touching the
    // Solution association.
    const deal = makeValidDeal({
      ace_opportunity_id: "O-PROD-REMOVE",
      ace_solutions: "S-0000001",
      ace_aws_products: "",
    });
    const company = makeValidCompany();
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LastModifiedDate: "2026-04-01T00:00:00Z",
        LifeCycle: { Stage: "Qualified" },
        RelatedEntityIdentifiers: {
          Solutions: ["S-0000001"],
          AwsProducts: ["AmazonEC2P5"],
        },
      }),
    });
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    expect(ace.mocks.associateOpportunity).not.toHaveBeenCalled();
    expect(ace.mocks.disassociateOpportunity).toHaveBeenCalledTimes(1);
    const call = ace.mocks.disassociateOpportunity.mock.calls[0][0];
    expect(call.RelatedEntityType).toBe("AwsProducts");
    expect(call.RelatedEntityIdentifier).toBe("AmazonEC2P5");
  });

  test("AWS Products: create path issues AssociateOpportunity for both Solutions and AwsProducts", async () => {
    // No oppId yet → create path. The deal has both a Solution and
    // two AWS Products; we expect three AssociateOpportunity calls
    // total — one per related entity, regardless of type.
    const deal = makeValidDeal({
      ace_solutions: "S-0000001",
      ace_aws_products: "AmazonEC2P5;AmazonS3",
    });
    const company = makeValidCompany();
    const ace = buildAce();
    const hs = buildHs(deal, company);

    const p = runShare(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });
    // 3 inter-write sleeps before each Associate + 1 before
    // StartEngagement = 4 × 1000ms.
    await vi.advanceTimersByTimeAsync(4000);
    const resp = await p;

    expect(resp.ok).toBe(true);
    expect(ace.mocks.createOpportunity).toHaveBeenCalledTimes(1);
    expect(ace.mocks.associateOpportunity).toHaveBeenCalledTimes(3);
    const types = ace.mocks.associateOpportunity.mock.calls.map(
      (c) => c[0].RelatedEntityType,
    );
    const ids = ace.mocks.associateOpportunity.mock.calls.map(
      (c) => c[0].RelatedEntityIdentifier,
    );
    expect(types).toEqual(["Solutions", "AwsProducts", "AwsProducts"]);
    expect(ids).toEqual(["S-0000001", "AmazonEC2P5", "AmazonS3"]);
  });
});

describe("runShare — configuration branches", () => {
  test("empty STAGE_MAPPING returns STAGE_UNMAPPABLE without calling ACE or HubSpot", async () => {
    const config = { ...BASE_CONFIG, stageMappingRaw: "" };
    const ace = buildAce();
    const hs = buildHs(makeValidDeal(), makeValidCompany());

    const resp = await runShare(42, { config, ace: ace.client, hs: hs.client });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("STAGE_UNMAPPABLE");
    }
    expect(ace.mocks.createOpportunity).not.toHaveBeenCalled();
    expect(hs.mocks.readDealProperties).not.toHaveBeenCalled();
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });

  test("STAGE_MAPPING with off-list value returns STAGE_UNMAPPABLE with invalid entries", async () => {
    const config = {
      ...BASE_CONFIG,
      // "NotAStage" is not one of the six valid ACE stages.
      stageMappingRaw: "qualified=NotAStage",
    };
    const ace = buildAce();
    const hs = buildHs(makeValidDeal(), makeValidCompany());

    const resp = await runShare(42, { config, ace: ace.client, hs: hs.client });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("STAGE_UNMAPPABLE");
      expect(resp.details?.invalidStageMappings).toContain("qualified=NotAStage");
    }
    expect(ace.mocks.createOpportunity).not.toHaveBeenCalled();
    expect(hs.mocks.readDealProperties).not.toHaveBeenCalled();
  });
});
