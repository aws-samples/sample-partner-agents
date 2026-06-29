import { describe, test, expect, vi } from "vitest";

import { runRefresh } from "../core/run-refresh";
import type { AceClient } from "../lib/ace";
import type { HubspotClient } from "../lib/hubspot";
import type { AppConfig } from "../lib/config";
import type { DealProps } from "../lib/preconditions";

/**
 * Unit tests for `runRefresh` (task 12.2).
 *
 * Mirrors the dependency-injection pattern from `share.test.ts`: build
 * literal-object mocks for the ACE and HubSpot wrappers, call
 * `runRefresh(dealId, deps)` directly, and assert on both the typed
 * response envelope and the outgoing HubSpot PATCH payload.
 *
 * Scenarios:
 *   - `Submitted` engagement-completed shortcut (ReviewStatus missing,
 *      Stage advanced past Prospect)
 *   - `Approved` passthrough (R5.3 — APN CRM ID dependency removed)
 *   - `Rejected` via `LifeCycle.ReviewStatus = "Rejected"` (R5.1)
 *   - `Closed Lost → Synced` via `LifeCycle.Stage = "Closed Lost"` (R5.2)
 *   - Missing `ace_opportunity_id` → `PRECONDITION` (R4.1)
 *   - `GetOpportunity` failure → `ACE_GET` (R4.8)
 *   - `GetAwsOpportunitySummary` failure is now SWALLOWED (best-effort)
 *   - Stage-label display: `STAGE_DISPLAY_NAMES` precedence + fallback to
 *     raw ACE stage when no reverse mapping exists (R4.2, R4.3)
 *
 * Requirements covered: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8.
 */

// Baseline AppConfig: a full 4-stage STAGE_MAPPING plus matching display
// names so reverse-map + label derivation exercise both normal paths.
// Individual tests clone and tweak.
const BASE_CONFIG: AppConfig = {
  awsAccessKeyId: "A",
  awsSecretAccessKey: "S",
  aceRegion: "us-east-1",
  stageMappingRaw:
    "qualified=Qualified;techvalid=Technical Validation;bizvalid=Business Validation;closedlost=Closed Lost",
  stageDisplayNamesRaw:
    "qualified=Qualified;techvalid=Technical Validation;bizvalid=Business Validation;closedlost=Closed Lost",
  hubspotPrivateAppToken: "tok",
};

/**
 * Build a deal record with a valid `ace_opportunity_id` by default — every
 * test except the missing-ID case expects Refresh's precondition to pass.
 */
function baseDeal(overrides: Partial<DealProps> = {}): DealProps {
  return {
    dealname: "Acme",
    ace_opportunity_id: "O-123",
    ...overrides,
  };
}

// Mock shape mirrors share.test.ts: vi.fn() per method keeps assertions on
// `.mock.calls` compatible with the shared pattern.
type AceMocks = { [K in keyof AceClient]: ReturnType<typeof vi.fn> };
type HsMocks = { [K in keyof HubspotClient]: ReturnType<typeof vi.fn> };

function buildAce(
  partial: Partial<AceMocks> = {}
): { client: AceClient; mocks: AceMocks } {
  // Refresh only invokes `getOpportunity` + `getAwsOpportunitySummary`, but
  // we populate the other four methods so the cast to `AceClient` is safe
  // and a future change that starts using them surfaces as a test failure
  // rather than a runtime TypeError.
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
      vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Business Validation" } }),
    getAwsOpportunitySummary:
      partial.getAwsOpportunitySummary ?? vi.fn().mockResolvedValue({}),
  };
  return { client: mocks as unknown as AceClient, mocks };
}

function buildHs(
  deal: DealProps,
  partial: Partial<HsMocks> = {}
): { client: HubspotClient; mocks: HsMocks } {
  // `readAssociatedCompany` is never called by `runRefresh` — it returns
  // `undefined` here just to satisfy the interface shape.
  const mocks: HsMocks = {
    readDealProperties:
      partial.readDealProperties ?? vi.fn().mockResolvedValue(deal),
    readAssociatedCompany:
      partial.readAssociatedCompany ?? vi.fn().mockResolvedValue(undefined),
    writeDealProperties:
      partial.writeDealProperties ?? vi.fn().mockResolvedValue(undefined),
    findDealByAceOpportunityId:
      partial.findDealByAceOpportunityId ?? vi.fn().mockResolvedValue(undefined),
    createDeal:
      partial.createDeal ?? vi.fn().mockResolvedValue(0),
  };
  return { client: mocks as unknown as HubspotClient, mocks };
}

describe("runRefresh — status resolution", () => {
  test("Sync-health flag stays Synced; live AWS state lives in aws_review_status", async () => {
    // AWS is still reviewing: stage is Qualified, no ReviewStatus yet.
    // After the v8 collapse, ace_sync_status is a pure sync-health
    // flag — so a successful read returns "Synced" regardless of the
    // AWS review state. The user-facing AWS state (or its absence)
    // surfaces via aws_review_status / aws_stage / the success
    // message.
    const ace = buildAce({
      getOpportunity: vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Qualified" } }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.properties.ace_sync_status).toBe("Synced");
      // Stage shows in the message; ReviewStatus omitted because
      // AWS hasn't reported one yet (acceptance window).
      expect(resp.message).toMatch(/^Refreshed — stage /);
      expect(resp.properties.aws_review_status).toBe("");
      expect(resp.properties.aws_stage).toBe("Qualified");
    }

    const writeCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writeCall[0]).toBe(42);
    expect(writeCall[1].ace_sync_status).toBe("Synced");
    expect(writeCall[1].ace_sync_error).toBe("");
    expect(writeCall[1].aws_review_status).toBe("");
    expect(writeCall[1].aws_stage).toBe("Qualified");
  });

  test("ReviewStatus=Approved → sync-health Synced + AWS state in aws_review_status", async () => {
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LifeCycle: {
          Stage: "Business Validation",
          ReviewStatus: "Approved",
        },
      }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      // Sync-health: just "Synced".
      expect(resp.properties.ace_sync_status).toBe("Synced");
      // AWS state: live ReviewStatus from AWS, mirrored verbatim.
      expect(resp.properties.aws_review_status).toBe("Approved");
      expect(resp.properties.aws_stage).toBe("Business Validation");
      // Message shows AWS state alongside the stage label.
      expect(resp.message).toContain("Approved");
      expect(resp.message).toContain("Business Validation");
    }
    const writeCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writeCall[1].ace_sync_status).toBe("Synced");
    expect(writeCall[1].aws_review_status).toBe("Approved");
    expect(writeCall[1].aws_stage).toBe("Business Validation");
  });

  test("ReviewStatus=Rejected → sync-health Synced + Rejected in message and aws_review_status", async () => {
    const ace = buildAce({
      getOpportunity: vi.fn().mockResolvedValue({
        LifeCycle: { Stage: "Qualified", ReviewStatus: "Rejected" },
      }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.properties.ace_sync_status).toBe("Synced");
      expect(resp.properties.aws_review_status).toBe("Rejected");
      // Message preserves the explicit "(Rejected)" suffix so the
      // toast leads with the bad news.
      expect(resp.message).toMatch(/\(Rejected\)$/);
    }
    const writeCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writeCall[1].ace_sync_status).toBe("Synced");
    expect(writeCall[1].aws_review_status).toBe("Rejected");
  });

  test('Closed Lost stage → sync-health Synced, "Closed Lost" surfaced in message', async () => {
    const ace = buildAce({
      getOpportunity: vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Closed Lost" } }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.properties.ace_sync_status).toBe("Synced");
      expect(resp.message).toContain("Closed Lost");
    }
  });
});

describe("runRefresh — error paths", () => {
  test("missing ace_opportunity_id returns PRECONDITION and skips ACE entirely", async () => {
    // R4.1: Refresh must not fire any ACE calls when the deal has not
    // been shared yet. The message instructs the user to Share first.
    const ace = buildAce();
    const hs = buildHs({ dealname: "Acme" }); // no ace_opportunity_id

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("PRECONDITION");
      expect(resp.message).toContain("Share");
    }
    // Strong assertion: no ACE traffic at all on this branch.
    expect(ace.mocks.getOpportunity).not.toHaveBeenCalled();
    expect(ace.mocks.getAwsOpportunitySummary).not.toHaveBeenCalled();
  });

  test("GetOpportunity failure surfaces ACE_GET and short-circuits the summary call", async () => {
    // R4.8: ACE failures are surfaced as typed error responses. If the
    // initial GetOpportunity fails, the summary call must not run —
    // otherwise a downstream error would mask the root cause.
    const ace = buildAce({
      getOpportunity: vi.fn().mockRejectedValue(
        Object.assign(new Error("boom"), { name: "InternalFailure" })
      ),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("ACE_GET");
      expect(resp.details?.step).toBe("GetOpportunity");
      expect(resp.message).toContain("boom");
    }
    expect(ace.mocks.getAwsOpportunitySummary).not.toHaveBeenCalled();
    // Best-effort write-back stamps Sync Error on the deal (R4.8).
    const writeCall = hs.mocks.writeDealProperties.mock.calls[0];
    expect(writeCall[1].ace_sync_status).toBe("Sync Error");
    expect(writeCall[1].ace_sync_error).toContain("GetOpportunity");
  });

  test("GetAwsOpportunitySummary failure is swallowed (best-effort) — Refresh still succeeds", async () => {
    // The summary read is now best-effort: AWS doesn't always
    // populate it (acceptance window). When it fails, we still
    // produce a successful Refresh from the GetOpportunity response;
    // the snapshot's summary-only fields (InvolvementType /
    // Visibility / Solutions) come back empty.
    const ace = buildAce({
      getOpportunity: vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Qualified" } }),
      getAwsOpportunitySummary: vi.fn().mockRejectedValue(
        Object.assign(new Error("boom"), { name: "ServiceUnavailable" })
      ),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.properties.ace_sync_status).toBe("Synced");
      // Non-destructive reverse-sync: summary-only fields (InvolvementType
      // / Visibility) and any other partner-editable input AWS returns
      // blank are OMITTED from the write, not set to "" — so a locally-set
      // value survives. They must be absent from the response props.
      expect(resp.properties.ace_involvement_type).toBeUndefined();
      expect(resp.properties.ace_visibility).toBeUndefined();
      expect(resp.properties.ace_solutions).toBeUndefined();
    }
  });

  test("Refresh does NOT clobber locally-set involvement/visibility when AWS summary is blank (regression)", async () => {
    // The deal carries the partner's freshly-entered submission fields.
    // AWS has no summary yet (pre-submission), so the snapshot's
    // involvement/visibility are blank. The write-back must OMIT those
    // keys so HubSpot keeps the partner's values — otherwise Submit can
    // never see them (they'd be wiped on every Refresh).
    const ace = buildAce({
      getOpportunity: vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Qualified", ReviewStatus: "Pending Submission" } }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(
      baseDeal({
        ace_involvement_type: "Co-Sell",
        ace_visibility: "Full",
      })
    );

    const resp = await runRefresh(42, {
      config: BASE_CONFIG,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    const written = hs.mocks.writeDealProperties.mock.calls[0][1];
    expect("ace_involvement_type" in written).toBe(false);
    expect("ace_visibility" in written).toBe(false);
  });
});

describe("runRefresh — stage label derivation", () => {
  test("STAGE_DISPLAY_NAMES override takes precedence over the HubSpot stage ID", async () => {
    // R4.2: when STAGE_DISPLAY_NAMES has an entry for the reverse-mapped
    // HubSpot stage ID, that display name wins over the raw stage ID
    // and over the raw ACE stage.
    const config: AppConfig = {
      ...BASE_CONFIG,
      stageDisplayNamesRaw: "bizvalid=Business Validation Phase",
    };
    const ace = buildAce({
      getOpportunity: vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Business Validation" } }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.message).toContain("Business Validation Phase");
    }
  });

  test("stage label falls back to raw ACE stage when no reverse mapping exists", async () => {
    // R4.3: if the ACE stage has no reverse-map entry (e.g. `Launched`
    // was dropped from STAGE_MAPPING), the label falls through to the
    // raw ACE stage string rather than showing `undefined`.
    const config: AppConfig = {
      ...BASE_CONFIG,
      stageMappingRaw: "qualified=Qualified", // no entry for Launched
      stageDisplayNamesRaw: "",
    };
    const ace = buildAce({
      getOpportunity: vi
        .fn()
        .mockResolvedValue({ LifeCycle: { Stage: "Launched" } }),
      getAwsOpportunitySummary: vi.fn().mockResolvedValue({}),
    });
    const hs = buildHs(baseDeal());

    const resp = await runRefresh(42, {
      config,
      ace: ace.client,
      hs: hs.client,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.message).toContain("Launched");
    }
  });
});
