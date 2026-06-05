import { describe, test, expect, vi } from "vitest";

import { runSubmit } from "../core/run-submit";
import { generateEngagementClientToken } from "../lib/client-token";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import type { AppConfig } from "../lib/config";
import type { DealProps } from "../lib/preconditions";

/**
 * Unit tests for `runSubmit` (task 3.3).
 *
 * Covers all 11 cases enumerated in design §Testing Strategy →
 * `submit.test.ts (NEW)` and validates Requirements 4.1–4.6, 6.1–6.4,
 * 8.1, 8.2, 8.5, 9.5, 11.3 plus design Property 3 (no-orphan failure
 * write).
 *
 * Mocks both `AceClient` and `HubspotClient` as plain object-shaped
 * `vi.fn()` records — same convention used by `share.test.ts`. Each
 * AceClient method defaults to `vi.fn().mockResolvedValue({})` so any
 * orchestration step that fires unexpectedly still resolves rather
 * than blowing up the test with an unexpected reject.
 */

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
 * A deal record that satisfies every Submit precondition by default —
 * `ace_opportunity_id` populated, both Submission_Required_Fields
 * populated, `aws_review_status` empty (the "legacy null" pass-through
 * state). Individual tests override only the fields they exercise.
 *
 * `dealname` and `contract_term__months_` are populated because the
 * success-path code calls `snapshotToProps(snapshot, deal)`, which
 * expects the deal shape it would normally read from HubSpot.
 */
function makeValidDeal(overrides: Partial<DealProps> = {}): DealProps {
  return {
    dealname: "Acme Migration",
    contract_term__months_: "12",
    ace_opportunity_id: "O-EXISTING-1",
    ace_involvement_type: "Co-Sell",
    ace_visibility: "Full",
    aws_review_status: "",
    ace_sync_status: "Synced",
    ace_last_sync: "",
    ace_sync_error: "",
    ...overrides,
  };
}

type AceMocks = { [K in keyof AceClient]: ReturnType<typeof vi.fn> };
type HsMocks = { [K in keyof HubspotClient]: ReturnType<typeof vi.fn> };

/**
 * Build an `AceClient` whose every method defaults to a no-op resolved
 * `{}`. Tests override only the methods relevant to the path under
 * exercise. Mirrors the shape used by `share.test.ts`'s `buildAce`.
 */
function buildAce(
  partial: Partial<AceMocks> = {}
): { client: AceClient; mocks: AceMocks } {
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
        LifeCycle: { Stage: "Qualified", ReviewStatus: "Pending Submission" },
      }),
    getAwsOpportunitySummary:
      partial.getAwsOpportunitySummary ?? vi.fn().mockResolvedValue({}),
  };
  return { client: mocks as unknown as AceClient, mocks };
}

function buildHs(
  deal: DealProps,
  partial: Partial<HsMocks> = {}
): { client: HubspotClient; mocks: HsMocks } {
  const mocks: HsMocks = {
    readDealProperties:
      partial.readDealProperties ?? vi.fn().mockResolvedValue(deal),
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

/** All AceClient methods that count as an "AWS call" for negative assertions. */
function expectNoAwsCalls(mocks: AceMocks): void {
  expect(mocks.createOpportunity).not.toHaveBeenCalled();
  expect(mocks.associateOpportunity).not.toHaveBeenCalled();
  expect(mocks.disassociateOpportunity).not.toHaveBeenCalled();
  expect(mocks.startEngagementFromOpportunityTask).not.toHaveBeenCalled();
  expect(mocks.listEngagementFromOpportunityTasks).not.toHaveBeenCalled();
  expect(mocks.updateOpportunity).not.toHaveBeenCalled();
  expect(mocks.getOpportunity).not.toHaveBeenCalled();
  expect(mocks.getAwsOpportunitySummary).not.toHaveBeenCalled();
}

describe("runSubmit — preconditions (R4.1, R4.2, R6.4)", () => {
  test("1. missing ace_opportunity_id → PRECONDITION, no AWS calls", async () => {
    // R4.1: an empty ace_opportunity_id is the explicit "Share first"
    // signal. Submit must refuse before touching AWS so the partner
    // sees the actionable message rather than an opaque
    // ResourceNotFoundException from StartEngagement.
    const deal = makeValidDeal({ ace_opportunity_id: "" });
    const ace = buildAce();
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("PRECONDITION");
      expect(resp.details?.step).toBe("checkOpportunityId");
      expect(resp.message).toContain("Share");
    }
    expectNoAwsCalls(ace.mocks);
    // Precondition failures don't write back — the deal is fine, the
    // partner just hasn't completed Share yet.
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });

  test("2. missing ace_involvement_type → PRECONDITION naming the field, no AWS calls", async () => {
    // R4.2: missing Submission_Required_Fields surface in
    // `details.preconditionFailures` so the card can render the exact
    // missing keys. The error message must also name the field
    // verbatim — partners read the alert banner, not the details
    // object.
    const deal = makeValidDeal({ ace_involvement_type: "" });
    const ace = buildAce();
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("PRECONDITION");
      expect(resp.details?.step).toBe("checkSubmissionFields");
      expect(resp.details?.preconditionFailures).toContain(
        "ace_involvement_type"
      );
      expect(resp.message).toContain("ace_involvement_type");
    }
    expectNoAwsCalls(ace.mocks);
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });

  test("3. aws_review_status='Submitted' → PRECONDITION, no AWS calls (R6.4)", async () => {
    // R6.4 + R11.3: NON_SUBMITTABLE_STATES include Submitted, and the
    // entry-point check fails fast. AWS would also reject the call,
    // but failing here is faster and gives a cleaner message.
    const deal = makeValidDeal({ aws_review_status: "Submitted" });
    const ace = buildAce();
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("PRECONDITION");
      expect(resp.details?.step).toBe("checkReviewStatus");
      expect(resp.message).toContain("Submitted");
    }
    expectNoAwsCalls(ace.mocks);
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });
});

describe("runSubmit — engagement-task path (R6.1, R6.2, R6.3, R9.5, R11.3)", () => {
  test("4. Pending Submission + IN_PROGRESS task → success without StartEngagement (R6.2, R9.5)", async () => {
    // Duplicate Submit click while AWS is still chewing on the prior
    // task → return success "Submission already in progress." with no
    // second StartEngagement and no deal write. The card stays in the
    // submitting/pending UI state and the partner re-clicks Refresh.
    const deal = makeValidDeal({ aws_review_status: "Pending Submission" });
    const ace = buildAce({
      listEngagementFromOpportunityTasks: vi.fn().mockResolvedValue({
        TaskSummaries: [
          {
            TaskStatus: "IN_PROGRESS",
            StartTime: new Date("2025-04-10T00:00:00Z"),
          },
        ],
      }),
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.message).toBe("Submission already in progress.");
      expect(resp.properties.ace_sync_status).toBe("Synced");
      expect(resp.properties.ace_sync_error).toBe("");
    }
    expect(ace.mocks.listEngagementFromOpportunityTasks).toHaveBeenCalledTimes(
      1
    );
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).not.toHaveBeenCalled();
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });

  test("5. Pending Submission + FAILED task → StartEngagement with randomUUID() (not the deterministic token) (R6.3)", async () => {
    // R6.3: the deterministic engagement token is locked in AWS's
    // idempotency cache to the prior FAILED outcome. Retrying with
    // the same token would silently re-return the cached failure;
    // a fresh randomUUID() is the only way to retry.
    const deal = makeValidDeal({ aws_review_status: "Pending Submission" });
    const ace = buildAce({
      listEngagementFromOpportunityTasks: vi.fn().mockResolvedValue({
        TaskSummaries: [
          {
            TaskStatus: "FAILED",
            StartTime: new Date("2025-04-10T00:00:00Z"),
            ReasonCode: "VALIDATION_ERROR",
            Message: "Visibility field invalid",
          },
        ],
      }),
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).toHaveBeenCalledTimes(1);
    const tokenUsed =
      ace.mocks.startEngagementFromOpportunityTask.mock.calls[0][0]
        .ClientToken;
    // The deterministic token would re-issue the same value the prior
    // FAILED attempt already used, so the token MUST differ.
    expect(tokenUsed).not.toBe(generateEngagementClientToken(42));
    // randomUUID() output shape: 8-4-4-4-12 hex digits.
    expect(typeof tokenUsed).toBe("string");
    expect(tokenUsed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test("6. Pending Submission + no prior task → StartEngagement with deterministic engagement token (R6.1)", async () => {
    // R6.1: empty task list = first attempt. Use the deterministic
    // engagement token so a duplicate Submit click before AWS has
    // logged the task is an idempotent re-issue, not a duplicate
    // task on the AWS side.
    const deal = makeValidDeal({ aws_review_status: "Pending Submission" });
    const ace = buildAce({
      listEngagementFromOpportunityTasks: vi
        .fn()
        .mockResolvedValue({ TaskSummaries: [] }),
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.startEngagementFromOpportunityTask.mock.calls[0][0].ClientToken
    ).toBe(generateEngagementClientToken(42));
  });

  test("7. legacy empty aws_review_status falls through identically (R11.3)", async () => {
    // R11.3: the legacy null / empty review-status state is the
    // "orphan opportunity" recovery path. It must behave exactly like
    // Pending Submission so old deals are submittable without
    // backfill.
    const deal = makeValidDeal({ aws_review_status: "" });
    const ace = buildAce({
      listEngagementFromOpportunityTasks: vi
        .fn()
        .mockResolvedValue({ TaskSummaries: [] }),
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.startEngagementFromOpportunityTask.mock.calls[0][0].ClientToken
    ).toBe(generateEngagementClientToken(42));
  });

  test("10. ListEngagementFromOpportunityTasks throws → fallthrough to deterministic token (R6.1)", async () => {
    // Best-effort list: a transient AWS list failure must not block
    // recovery. The submit path treats a list throw as "no prior
    // task" and uses the deterministic engagement token.
    const deal = makeValidDeal({ aws_review_status: "Pending Submission" });
    const ace = buildAce({
      listEngagementFromOpportunityTasks: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("list failed"), {
            name: "ServiceUnavailableException",
          })
        ),
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    expect(
      ace.mocks.startEngagementFromOpportunityTask
    ).toHaveBeenCalledTimes(1);
    expect(
      ace.mocks.startEngagementFromOpportunityTask.mock.calls[0][0].ClientToken
    ).toBe(generateEngagementClientToken(42));
  });
});

describe("runSubmit — failure handling (Property 3, R8.1, R8.2, R8.5)", () => {
  test("8. StartEngagement throws → ACE_CREATE envelope; failure write omits ace_opportunity_id and aws_review_status", async () => {
    // Property 3 from design: on a Submit failure, the deal-property
    // write touches ONLY ace_sync_status / ace_sync_error /
    // ace_last_sync. Writing ace_opportunity_id or aws_review_status
    // here would risk orphaning the deal (R8.1, R8.5).
    const deal = makeValidDeal({ aws_review_status: "Pending Submission" });
    const ace = buildAce({
      startEngagementFromOpportunityTask: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Visibility invalid"), {
            name: "ValidationException",
          })
        ),
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_CREATE");
      expect(resp.details?.step).toBe("StartEngagement");
      expect(resp.message).toContain("Visibility invalid");
    }
    // Exactly one write — the Sync Error stamp.
    expect(hs.mocks.writeDealProperties).toHaveBeenCalledTimes(1);
    const writeCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writeCall[0]).toBe(42);
    const writtenKeys = Object.keys(writeCall[1]);
    // The no-orphan guarantee — neither key may appear in the failure
    // write map. This is the static-analysis-equivalent assertion
    // called out by design Property 3.
    expect(writtenKeys).not.toContain("ace_opportunity_id");
    expect(writtenKeys).not.toContain("aws_review_status");
    // What MUST be written on failure.
    expect(writeCall[1].ace_sync_status).toBe("Sync Error");
    expect(writeCall[1].ace_sync_error).toContain("StartEngagement");
    expect(writeCall[1].ace_sync_error).toContain("Visibility invalid");
    expect(typeof writeCall[1].ace_last_sync).toBe("string");
    expect(writeCall[1].ace_last_sync.length).toBeGreaterThan(0);
  });
});

describe("runSubmit — success path (R4.5, R4.6)", () => {
  test("9. StartEngagement succeeds → fetchAceSnapshot + write Synced + 'submitted for review' message", async () => {
    // R4.5 / R4.6: after a successful StartEngagement the submit
    // path reads back the post-engagement snapshot and stamps the
    // deal with the success-state health flags. The success
    // message must include the recognisable phrase the card uses
    // to differentiate "submitted" from "saved as draft".
    const deal = makeValidDeal({
      ace_opportunity_id: "O-SUBMITTED-9",
      aws_review_status: "Pending Submission",
    });
    const getOpportunity = vi.fn().mockResolvedValue({
      LifeCycle: { Stage: "Qualified", ReviewStatus: "Submitted" },
      Project: { Title: "Acme Migration" },
    });
    const getAwsOpportunitySummary = vi.fn().mockResolvedValue({});
    const ace = buildAce({
      listEngagementFromOpportunityTasks: vi
        .fn()
        .mockResolvedValue({ TaskSummaries: [] }),
      getOpportunity,
      getAwsOpportunitySummary,
    });
    const hs = buildHs(deal);

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.message).toContain("submitted for review");
      expect(resp.message).toContain("O-SUBMITTED-9");
      expect(resp.properties.ace_sync_status).toBe("Synced");
      expect(resp.properties.ace_sync_error).toBe("");
      expect(resp.properties.ace_last_sync.length).toBeGreaterThan(0);
    }
    // fetchAceSnapshot fired its two reads.
    expect(getOpportunity).toHaveBeenCalledTimes(1);
    expect(getOpportunity.mock.calls[0][0].Identifier).toBe("O-SUBMITTED-9");
    expect(getAwsOpportunitySummary).toHaveBeenCalledTimes(1);
    // The post-success deal write carries the snapshot fields plus the
    // sync-health stamp.
    expect(hs.mocks.writeDealProperties).toHaveBeenCalledTimes(1);
    const writeCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writeCall[0]).toBe(42);
    expect(writeCall[1].ace_sync_status).toBe("Synced");
    expect(writeCall[1].ace_sync_error).toBe("");
  });
});

describe("runSubmit — HubSpot read failure (R4.3-style HUBSPOT_WRITE bucket)", () => {
  test("11. readDealProperties throws → HUBSPOT_WRITE envelope, no AWS calls", async () => {
    // The submit path's only HubSpot read can fail (transient HTTP
    // error, auth issue, etc.). HubSpot-IO failures all surface under
    // HUBSPOT_WRITE — that's the single bucket the card maps to the
    // "HubSpot connection problem" alert.
    const deal = makeValidDeal();
    const ace = buildAce();
    const hs = buildHs(deal, {
      readDealProperties: vi.fn().mockRejectedValue(new Error("502 Bad Gateway")),
    });

    const resp = await runSubmit(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("HUBSPOT_WRITE");
      expect(resp.details?.step).toBe("readDeal");
      expect(resp.message).toContain("502 Bad Gateway");
    }
    expectNoAwsCalls(ace.mocks);
    expect(hs.mocks.writeDealProperties).not.toHaveBeenCalled();
  });
});
