import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  PartnerCentralSellingClient,
  CreateOpportunityCommandInput,
  UpdateOpportunityCommandInput,
  GetOpportunityCommandInput,
  ListEngagementFromOpportunityTasksCommandInput,
} from "@aws-sdk/client-partnercentral-selling";
import { ListEngagementFromOpportunityTasksCommand } from "@aws-sdk/client-partnercentral-selling";

import { createAceClient, ACEThrottledError } from "../lib/ace";
import { ACE_CATALOG, type AppConfig } from "../lib/config";

/**
 * Unit tests for the ACE SDK wrapper (task 9.2). The wrapper implements a
 * single-retry throttling policy with a 1000ms inter-retry sleep. To keep
 * these tests fast and deterministic we inject a mock `send()` function
 * into `createAceClient` via the `sdk` seam and use Vitest fake timers to
 * advance past the sleep instantaneously.
 *
 * Requirements covered: 10.1, 10.2, 10.3
 *
 * The cases exercised here mirror the four scenarios called out in
 * tasks.md §9.2:
 *   1. Happy path — single successful call returns the mocked output.
 *   2. Single retry on throttle — first call throws
 *      `ThrottlingException`, second succeeds.
 *   3. Failure after retry — both calls throttle → `ACEThrottledError`.
 *   4. `LastModifiedDate`-conflict pass-through on `UpdateOpportunity` —
 *      SDK throws a `ConflictException`; error propagates unchanged (NOT
 *      wrapped as `ACEThrottledError`).
 *
 * Two extra tests round out coverage:
 *   - `TooManyRequestsException` is treated as throttling (robust to SDK
 *     naming variance).
 *   - A non-throttling error surfaced on the retry also passes through
 *     unchanged.
 */

// Minimal AppConfig suitable for constructing the wrapper. Values are
// unused by the tests because the SDK is fully mocked via the `sdk` seam,
// but the shape must match so TypeScript is happy.
const TEST_CONFIG: AppConfig = {
  awsAccessKeyId: "AKIAX",
  awsSecretAccessKey: "secret",
  aceRegion: "us-east-1",
  stageMappingRaw: "qualified=Qualified",
  stageDisplayNamesRaw: "",
  hubspotPrivateAppToken: "tok",
};

/**
 * Build a mock `PartnerCentralSellingClient` whose `.send()` is the
 * provided Vitest mock. `createAceClient` only ever calls `client.send()`
 * so we can get away with satisfying just that method and casting.
 */
function buildMockSdk(
  send: (...args: unknown[]) => unknown
): PartnerCentralSellingClient {
  return { send } as unknown as PartnerCentralSellingClient;
}

/**
 * Test-only minimal stubs for the SDK input shapes. They satisfy the
 * required fields so TypeScript's strict mode is happy without us having
 * to build full, valid ACE request payloads — the wrapper does not
 * introspect the input, it just forwards it to `client.send()`.
 */
const STUB_CREATE_INPUT = {
  Catalog: "Sandbox",
  ClientToken: "test-token",
} as unknown as CreateOpportunityCommandInput;

const STUB_UPDATE_INPUT = {
  Catalog: "Sandbox",
  Identifier: "O-1",
  LastModifiedDate: "2025-01-01T00:00:00Z",
} as unknown as UpdateOpportunityCommandInput;

const STUB_GET_INPUT = {
  Catalog: "Sandbox",
  Identifier: "O-1",
} as unknown as GetOpportunityCommandInput;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ace.ts throttle-retry wrapper", () => {
  test("happy path: single successful call returns the SDK output", async () => {
    const send = vi.fn().mockResolvedValue({ Id: "O-123" });
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    // No timer advance needed — the success path never awaits the retry
    // sleep.
    const resp = await ace.createOpportunity(STUB_CREATE_INPUT);

    expect(resp).toEqual({ Id: "O-123" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("single retry on ThrottlingException: first call throws, second succeeds", async () => {
    const throttle = Object.assign(new Error("Throttled"), {
      name: "ThrottlingException",
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce({ Id: "O-456" });
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    // Kick off the call, then advance fake timers past the 1000ms
    // inter-retry sleep. `advanceTimersByTimeAsync` yields to microtasks
    // so the promise chain inside `sendWithRetry` actually progresses.
    const p = ace.createOpportunity(STUB_CREATE_INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    const resp = await p;

    expect(resp).toEqual({ Id: "O-456" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("TooManyRequestsException is also treated as throttling", async () => {
    const throttle = Object.assign(new Error(), {
      name: "TooManyRequestsException",
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce({ ok: true });
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    const p = ace.getOpportunity(STUB_GET_INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    const resp = await p;

    expect(resp).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("failure after retry: throttle twice → ACEThrottledError", async () => {
    const throttle = Object.assign(new Error("Throttled"), {
      name: "ThrottlingException",
    });
    const send = vi.fn().mockRejectedValue(throttle); // all calls reject
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    // Attach the rejection expectation before advancing timers so the
    // pending rejection is observed and no unhandled-rejection warning
    // leaks out of the test runner.
    const p = ace.updateOpportunity(STUB_UPDATE_INPUT);
    const expectation = expect(p).rejects.toBeInstanceOf(ACEThrottledError);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;

    expect(send).toHaveBeenCalledTimes(2);
  });

  test("ACEThrottledError carries the underlying SDK error as cause", async () => {
    // Regression-proof the `cause` wiring so callers can log the
    // underlying SDK error when mapping to the ACE_THROTTLED code.
    const throttle = Object.assign(new Error("Slow down"), {
      name: "ThrottlingException",
    });
    const send = vi.fn().mockRejectedValue(throttle);
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    const p = ace.updateOpportunity(STUB_UPDATE_INPUT);
    const expectation = expect(p).rejects.toMatchObject({
      name: "ACEThrottledError",
      cause: throttle,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  test("non-throttling errors pass through without wrapping (e.g. ConflictException)", async () => {
    // This is the LastModifiedDate-conflict pass-through case for
    // UpdateOpportunity: the wrapper must NOT wrap `ConflictException`
    // as `ACEThrottledError`, because `share.ts` needs to catch the
    // original error name to trigger its single `GetOpportunity` refresh.
    const conflict = Object.assign(new Error("LastModifiedDate stale"), {
      name: "ConflictException",
    });
    const send = vi.fn().mockRejectedValue(conflict);
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    await expect(ace.updateOpportunity(STUB_UPDATE_INPUT)).rejects.toBe(
      conflict
    );
    // No retry is attempted for non-throttling errors, so .send() runs
    // exactly once.
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("non-throttling error on retry also passes through (throttle then ConflictException)", async () => {
    const throttle = Object.assign(new Error(), {
      name: "ThrottlingException",
    });
    const conflict = Object.assign(new Error(), { name: "ConflictException" });
    const send = vi
      .fn()
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(conflict);
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    const p = ace.updateOpportunity(STUB_UPDATE_INPUT);
    const expectation = expect(p).rejects.toBe(conflict);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;

    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("ace.ts listEngagementFromOpportunityTasks", () => {
  /**
   * Validates: Requirements 6.1, 6.2
   *
   * The Submit_Function probes engagement-task state via this method to
   * decide between (a) returning early with "Submission already in
   * progress." when AWS reports `IN_PROGRESS`, and (b) re-issuing
   * `StartEngagementFromOpportunityTask` with a fresh `randomUUID()`
   * `ClientToken` after a `FAILED` task so AWS's idempotency cache
   * doesn't dedupe the retry. Both behaviours hinge on the wrapper
   * dispatching the right command, with the deal's `ace_opportunity_id`
   * scoped under the Sandbox catalog.
   */
  test("dispatches ListEngagementFromOpportunityTasksCommand with Catalog + OpportunityIdentifier", async () => {
    // Arrange: capture whatever Command instance is sent so we can
    // assert both its constructor identity and its `.input` shape.
    const send = vi.fn().mockResolvedValue({ TaskSummaries: [] });
    const ace = createAceClient(TEST_CONFIG, buildMockSdk(send));

    const input: ListEngagementFromOpportunityTasksCommandInput = {
      Catalog: ACE_CATALOG,
      OpportunityIdentifier: ["O-789"],
    };

    // Act.
    await ace.listEngagementFromOpportunityTasks(input);

    // Assert: send() called once, with a real
    // ListEngagementFromOpportunityTasksCommand whose input forwards
    // the Catalog + OpportunityIdentifier verbatim. We check the
    // command's `.input` rather than rebuilding a new command and
    // comparing instances, because the AWS SDK's command objects don't
    // implement structural equality.
    expect(send).toHaveBeenCalledTimes(1);
    const sentCommand = send.mock.calls[0]?.[0] as
      | ListEngagementFromOpportunityTasksCommand
      | undefined;
    expect(sentCommand).toBeInstanceOf(ListEngagementFromOpportunityTasksCommand);
    expect(sentCommand?.input).toEqual({
      Catalog: "Sandbox",
      OpportunityIdentifier: ["O-789"],
    });
  });
});
