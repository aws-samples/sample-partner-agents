/**
 * React Testing Library tests for `AceShareCard`.
 *
 * The card imports from `@hubspot/ui-extensions`, whose components are
 * designed for HubSpot's remote-ui runtime — not standard DOM. Rather
 * than render them through their real runtime (which is not available
 * in jsdom), we replace the module with a thin set of plain-HTML
 * passthroughs so RTL can locate buttons by text, observe `disabled`
 * flags, and dispatch click events. This is the standard test-seam
 * technique for components that depend on design systems with exotic
 * host runtimes.
 *
 * Post-pivot: the card now calls an AWS Lambda backend via
 * `hubspot.fetch(url, { method, body, timeout })` instead of HubSpot
 * Serverless Functions. The tests inject a `fetchFn` mock as a prop so
 * the component logic can be exercised without touching the real SDK
 * singleton.
 *
 * Coverage:
 *   - All five visual states (Placeholder, Active-no-opp, Active-with-opp,
 *     In-flight Share, Error alert). The In-flight Refresh state shares
 *     its implementation with In-flight Share so a single in-flight test
 *     is sufficient for coverage of R6.1 / R6.2 / R11.1.
 *   - Buttons disabled while a fetch call is pending (R11.1).
 *   - Successful Share re-reads deal properties (R6.6) and calls
 *     `refreshObjectProperties` on the host.
 *   - Error response surfaces a danger toast (R6.5).
 *   - Inline `ace_sync_error` renders as an Alert (R6.5).
 *   - Fetch target URL is `<apiBaseUrl>/share` or `<apiBaseUrl>/refresh`.
 *
 * Requirements covered: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2, 6.3, 6.4,
 * 6.5, 6.6, 11.1.
 */

import React from "react";
import { describe, test, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---------------------------------------------------------------------------
// Mock @hubspot/ui-extensions
// ---------------------------------------------------------------------------
//
// Vitest hoists `vi.mock` above imports, so the factory cannot close over
// out-of-scope variables. We import React inside the factory with a
// synchronous `require` call (provided by vitest's CJS interop) and
// emit plain HTML elements that RTL can query. The `passthrough(tag)`
// helper converts any UI-extensions component into that tag while
// forwarding `onClick`, `disabled`, and children — enough surface area
// for these tests without reproducing the full component API.
vi.mock("@hubspot/ui-extensions", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactLib = require("react") as typeof import("react");

  const passthrough = (tag: string) =>
    ReactLib.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
      const {
        children,
        onClick,
        disabled,
        variant,
        direction,
        gap,
        format,
        label,
        type,
        // swallow remaining design-system-specific props so they do not
        // leak into the rendered DOM and trigger React warnings.
        ...rest
      } = props as Record<string, unknown>;
      void direction;
      void gap;
      void format;
      void rest;
      return ReactLib.createElement(
        tag,
        {
          ref,
          onClick,
          disabled,
          type,
          "data-variant": variant,
        },
        (children ?? label) as React.ReactNode
      );
    });

  return {
    // The real module exports a `hubspot` singleton with `extend` and
    // `fetch`. The card calls `hubspot.extend` at module scope; tests
    // render `<AceShareCard>` directly, so we just stub `extend` and
    // expose a `fetch` stub that tests never actually hit (they pass
    // their own `fetchFn` as a prop).
    hubspot: {
      extend: () => undefined,
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    },
    Flex: passthrough("div"),
    Text: passthrough("span"),
    Button: passthrough("button"),
    Alert: ({
      title,
      children,
      variant,
    }: {
      title?: string;
      children?: React.ReactNode;
      variant?: string;
    }) =>
      ReactLib.createElement(
        "div",
        { role: "alert", "data-variant": variant },
        title
          ? ReactLib.createElement("strong", null, title)
          : null,
        children
      ),
    Divider: () => ReactLib.createElement("hr", null),
    LoadingSpinner: ({ label }: { label?: string }) =>
      ReactLib.createElement(
        "span",
        { "aria-busy": "true" },
        label ?? "Loading..."
      ),
    DescriptionList: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement("dl", null, children),
    DescriptionListItem: ({
      label,
      children,
    }: {
      label?: string;
      children?: React.ReactNode;
    }) =>
      ReactLib.createElement(
        React.Fragment,
        null,
        ReactLib.createElement("dt", null, label),
        ReactLib.createElement("dd", null, children)
      ),
  };
});

// Mock the /crm subpath that exposes the `useAssociations` hook.
// The hook returns an empty results array by default; tests that
// need company props simulate them by passing `companyProps` directly
// to the AceShareCard component.
vi.mock("@hubspot/ui-extensions/crm", () => {
  return {
    useAssociations: () => ({
      results: [],
      error: null,
      isLoading: false,
      isRefetching: false,
      pagination: { hasMore: false, nextOffset: 0 },
      refetch: async () => undefined,
    }),
  };
});

// Imported AFTER vi.mock so the mocked module is the one resolved.
import { AceShareCard } from "../cards/AceShareCard";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type Props = React.ComponentProps<typeof AceShareCard>;
type Actions = Props["actions"];
type FetchFn = Props["fetchFn"];

const API = "https://apigw.example.com";

/**
 * A close date safely in the future relative to the test run. The card's
 * readiness checklist now flags past/today close dates (mirroring the
 * backend `closeDateFuture` precondition), so fixtures that need to be
 * "ready to share" must use a future date. Computed dynamically so the
 * suite never goes stale.
 */
function futureDate(): string {
  return new Date(Date.now() + 120 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Field set that satisfies every CREATE precondition (so the readiness
 * gate passes and the Share button shows its submission-mode label rather
 * than the "complete required fields" gate label). Submission-only fields
 * (ace_involvement_type / ace_visibility) are intentionally left to the
 * caller so tests can flip the Create_And_Submit ⇄ Create_Only classifier.
 */
function createReadyFields(): Record<string, string> {
  return {
    description: "Customer needs to migrate ten workloads to AWS by Q3.",
    dealname: "Acme Migration",
    dealstage: "qualifiedtobuy",
    amount: "12000",
    closedate: futureDate(),
    ace_country_code: "US",
    ace_state_or_region: "WA",
    ace_postal_code: "98101",
    ace_industry: "Software and Internet",
    ace_website_url: "https://acme.com",
    ace_currency_code: "USD",
    ace_solutions: "S-0000001",
    ace_marketing_source: "No",
  };
}

/**
 * Build a minimal `actions` object for a given deal snapshot. The
 * `fetchCrmObjectProperties` mock returns the provided snapshot on every
 * call — tests that need to observe the re-read on settle do so by
 * asserting `fetchCrmObjectProperties` call counts.
 */
function makeActions(
  initialDeal: Record<string, string>,
  overrides: Partial<Actions> = {}
): Actions {
  return {
    addAlert: vi.fn(),
    fetchCrmObjectProperties: vi.fn(async () => initialDeal),
    refreshObjectProperties: vi.fn(),
    // Default no-op subscription — tests that exercise the
    // live-update path override this with a stub that captures
    // the callback so they can fire it manually.
    onCrmPropertiesUpdate: vi.fn(),
    ...overrides,
  } as Actions;
}

/** Build a `fetchFn` that returns a `FunctionResponse`-shaped JSON body. */
function makeFetchFn(body: unknown, ok = true, status = 200): FetchFn {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as FetchFn;
}

// ---------------------------------------------------------------------------
// Visual state tests
// ---------------------------------------------------------------------------

describe("AceShareCard — visual states", () => {
  test("Placeholder state: hides both buttons when deal has no AWS context", async () => {
    const actions = makeActions({
      description: "",
      // Every ACE / aws_* property explicitly empty — confirms the
      // card hides the buttons only when there's nothing AWS-related
      // on the deal at all (no description, no synced opp, no
      // mirror data).
      ace_opportunity_id: "",
      ace_solutions: "",
      ace_sync_status: "",
      ace_last_sync: "",
      ace_sync_error: "",
      aws_review_status: "",
      aws_stage: "",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/no AWS Partner Central context yet/i);
    expect(
      screen.queryByText(/Refresh from AWS Partner Central/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Refresh from AWS Partner Central/i)
    ).not.toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("Active — opportunity present, no description: card surfaces because an ACE field is set", async () => {
    // Reverse-sync produces deals where `description` may be blank
    // (AWS opp has no `Project.CustomerBusinessProblem`) but the
    // deal carries an `ace_opportunity_id`. The card must still
    // render the Share / Refresh actions in that case.
    const actions = makeActions({
      description: "",
      ace_opportunity_id: "O-FROM-AWS",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    expect(
      await screen.findByText(/Refresh from AWS Partner Central/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Refresh from AWS Partner Central/i)
    ).toBeInTheDocument();
  });

  test("Active — no opportunity: Share visible, Refresh hidden (R1.4)", async () => {
    const actions = makeActions({
      description: "A description",
      ace_opportunity_id: "",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    // No oppId → Share is visible (Create_And_Submit / Create_Only label).
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.queryByText(/Refresh from AWS Partner Central/i)
    ).not.toBeInTheDocument();
  });

  test("Active — with opportunity: both buttons visible and property summary rendered (R1.5, R1.6)", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-123",
      ace_sync_status: "pending_review",
      ace_last_sync: "2025-04-29T12:00:00Z",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(
      screen.getByText(/Refresh from AWS Partner Central/i)
    ).toBeInTheDocument();
    expect(screen.getByText("O-123")).toBeInTheDocument();
    expect(screen.getByText("pending_review")).toBeInTheDocument();
    // The card formats `ace_last_sync` via `Date#toLocaleString()` so the
    // raw ISO string is no longer in the DOM. Match the locale-formatted
    // value computed from the same input the card receives.
    const expectedLastSync = new Date(
      "2025-04-29T12:00:00Z"
    ).toLocaleString();
    expect(screen.getByText(expectedLastSync)).toBeInTheDocument();
  });

  test("Sync Status shows 'Pending Sync' when hs_lastmodifieddate is well after ace_last_sync", async () => {
    // The deal was synced an hour ago; the rep then edited a field —
    // hs_lastmodifieddate moved forward but ace_last_sync didn't.
    // The card should show "Pending Sync" so the rep knows to click
    // Share.
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-PENDING",
      ace_sync_status: "Synced",
      ace_last_sync: "2026-05-20T12:00:00Z",
      hs_lastmodifieddate: "2026-05-20T13:00:00Z",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(screen.getByText("Pending Sync")).toBeInTheDocument();
  });

  test("Sync Status shows 'Pending Sync' with HubSpot's epoch-millis timestamps (UI extension format)", async () => {
    // HubSpot's UI extension API returns datetime-typed properties
    // as epoch milliseconds (string), not ISO 8601. Live observation
    // (May 2026): a deal returned `ace_last_sync = "1779271571635"`
    // and `hs_lastmodifieddate = "1779278400000"` (~2 hours later).
    // The card's derive function must parse both formats.
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-EPOCH",
      ace_sync_status: "Synced",
      // 2026-05-20T12:00:00Z
      ace_last_sync: "1779271200000",
      // 2026-05-20T13:00:00Z (1 hour later)
      hs_lastmodifieddate: "1779274800000",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(screen.getByText("Pending Sync")).toBeInTheDocument();
  });

  test("Sync Status stays 'Synced' when hs_lastmodifieddate is within the skew window of ace_last_sync", async () => {
    // The post-Share write bumps hs_lastmodifieddate slightly after
    // ace_last_sync. A 5s skew window absorbs that so we don't show
    // "Pending Sync" right after a successful sync.
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-FRESH",
      ace_sync_status: "Synced",
      ace_last_sync: "2026-05-20T12:00:00.000Z",
      hs_lastmodifieddate: "2026-05-20T12:00:01.500Z",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(screen.getByText("Synced")).toBeInTheDocument();
    expect(screen.queryByText("Pending Sync")).not.toBeInTheDocument();
  });

  test("Sync Status shows 'Sync Error' even when hs_lastmodifieddate is fresh", async () => {
    // Backend-stored Sync Error wins over the derived Pending Sync —
    // the rep needs to see the error first, not the "you have unsynced
    // edits" cue.
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-ERR",
      ace_sync_status: "Sync Error",
      ace_sync_error: "UpdateOpportunity: boom",
      ace_last_sync: "2026-05-20T12:00:00Z",
      hs_lastmodifieddate: "2026-05-20T13:00:00Z",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(screen.getByText("Sync Error")).toBeInTheDocument();
    expect(screen.queryByText("Pending Sync")).not.toBeInTheDocument();
  });

  test("Sync Status shows 'Not Synced' when no ace_last_sync and no stored status", async () => {
    // Deal has AWS context (description) but Share has never run.
    // The derived status falls back to "Not Synced".
    const actions = makeActions({
      description: "desc with no opp yet",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    // No oppId → Share is visible.
    await screen.findByText(/Share to AWS \(/i);
    expect(screen.getByText("Not Synced")).toBeInTheDocument();
  });

  test("Error alert renders when ace_sync_error is non-empty (R6.5)", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-123",
      ace_sync_error: "CreateOpportunity failed: boom",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    // The deal has `ace_opportunity_id` set + empty `aws_review_status`,
    // so the new Submission_Pending_Recovery Alert renders alongside the
    // legacy "Last sync error" Alert. Pick the specific one by title.
    const alerts = await screen.findAllByRole("alert");
    const errorAlert = alerts.find((a) =>
      a.textContent?.includes("Last sync error")
    );
    expect(errorAlert).toBeDefined();
    expect(errorAlert).toHaveTextContent("CreateOpportunity failed: boom");
  });

  test.each([
    "Submitted",
    "In Review",
  ])(
    "Review-blocked advisory shows when aws_review_status is %s",
    async (state) => {
      const actions = makeActions({
        description: "desc",
        ace_opportunity_id: "O-IN-REVIEW",
        aws_review_status: state,
      });
      const fetchFn = makeFetchFn({ ok: true, message: "" });
      render(
        <AceShareCard
          dealId={42}
          apiBaseUrl={API}
          actions={actions}
          fetchFn={fetchFn}
        />
      );
      await screen.findByText(/Refresh from AWS Partner Central/i);
      const alerts = await screen.findAllByRole("alert");
      const reviewAlert = alerts.find((a) =>
        a.textContent?.includes("Updates blocked while AWS is reviewing")
      );
      expect(reviewAlert).toBeDefined();
      expect(reviewAlert).toHaveTextContent(state);
    }
  );

  test.each([
    "Approved",
    "Disqualified",
    "Action Required",
  ])(
    "Customer-locked advisory shows when aws_review_status is %s",
    async (state) => {
      const actions = makeActions({
        description: "desc",
        ace_opportunity_id: "O-LOCKED",
        aws_review_status: state,
      });
      const fetchFn = makeFetchFn({ ok: true, message: "" });
      render(
        <AceShareCard
          dealId={42}
          apiBaseUrl={API}
          actions={actions}
          fetchFn={fetchFn}
        />
      );
      await screen.findByText(/Refresh from AWS Partner Central/i);
      const alerts = await screen.findAllByRole("alert");
      const lockAlert = alerts.find((a) =>
        a.textContent?.includes("Customer details locked on AWS")
      );
      expect(lockAlert).toBeDefined();
      expect(lockAlert).toHaveTextContent(state);
      expect(lockAlert).toHaveTextContent(/CompanyName/);
      // Share / Refresh stay enabled — Stage and Next Steps still sync.
      const shareBtn = screen
        .getByText(/Refresh from AWS Partner Central/i)
        .closest("button");
      expect(shareBtn).not.toBeDisabled();
    }
  );

  test.each([
    "Pending Submission",
    "",
    undefined,
  ])(
    "Customer-locked advisory hidden when aws_review_status is %s",
    async (state) => {
      const dealProps: Record<string, string> = {
        description: "desc",
        ace_opportunity_id: "O-EDITABLE",
      };
      if (state !== undefined) dealProps.aws_review_status = state;
      const actions = makeActions(dealProps);
      const fetchFn = makeFetchFn({ ok: true, message: "" });
      render(
        <AceShareCard
          dealId={42}
          apiBaseUrl={API}
          actions={actions}
          fetchFn={fetchFn}
        />
      );
      await screen.findByText(/Refresh from AWS Partner Central/i);
      expect(
        screen.queryByText(/Customer details locked on AWS/i)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Updates blocked while AWS is reviewing/i)
      ).not.toBeInTheDocument();
    }
  );
});

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

describe("AceShareCard — button interaction", () => {
  test("Share click POSTs {dealId} to <apiBaseUrl>/share and surfaces success toast", async () => {
    const actions = makeActions({
      description: "desc",
    });
    const fetchFn = makeFetchFn({
      ok: true,
      message: "Created ACE opportunity O-NEW",
    }) as unknown as FetchFn & { mock: { calls: unknown[][] } };
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    const shareBtn = await screen.findByText(/Share to AWS \(/i);
    fireEvent.click(shareBtn);
    await waitFor(() =>
      expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(0)
    );
    const call = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe(`${API}/share`);
    expect(call[1]).toMatchObject({
      method: "POST",
      timeout: 20000,
      body: { dealId: 42 },
    });
    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const alertArgs = (actions.addAlert as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(alertArgs.type).toBe("success");
    expect(alertArgs.message).toContain("O-NEW");
  });

  test("Refresh click POSTs to <apiBaseUrl>/refresh", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-123",
    });
    const fetchFn = makeFetchFn({
      ok: true,
      message: "Refreshed — stage Qualified, Submitted",
    });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    const refreshBtn = await screen.findByText(
      /Refresh from AWS Partner Central/i
    );
    fireEvent.click(refreshBtn);
    await waitFor(() =>
      expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(0)
    );
    const call = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe(`${API}/refresh`);
  });

  test("After a successful Share, fetchCrmObjectProperties is re-invoked (R6.6) and refreshObjectProperties is called", async () => {
    const fetchMock = vi.fn(async () => ({
      description: "desc",
    }));
    const actions: Actions = {
      addAlert: vi.fn(),
      fetchCrmObjectProperties: fetchMock,
      refreshObjectProperties: vi.fn(),
      onCrmPropertiesUpdate: vi.fn(),
    } as Actions;
    const fetchFn = makeFetchFn({ ok: true, message: "ok" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/Share to AWS \(/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(actions.refreshObjectProperties).toHaveBeenCalled();
  });

  test("Error response from backend triggers a danger toast (R6.5)", async () => {
    const actions = makeActions({
      description: "desc",
    });
    const fetchFn = makeFetchFn(
      {
        ok: false,
        code: "PRECONDITION",
        message: "Cannot share: closedate",
      },
      false,
      422
    );
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    fireEvent.click(
      await screen.findByText(/Share to AWS \(/i)
    );
    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const alertArgs = (actions.addAlert as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(alertArgs.type).toBe("danger");
    expect(alertArgs.message).toContain("Cannot share");
  });

  test("401 response synthesises AUTH_INVALID toast when body lacks ok field", async () => {
    const actions = makeActions({
      description: "desc",
    });
    // Simulate API Gateway's native 401 body: { message: "Unauthorized" }
    const fetchFn = makeFetchFn({ message: "Unauthorized" }, false, 401);
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    fireEvent.click(
      await screen.findByText(/Share to AWS \(/i)
    );
    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const alertArgs = (actions.addAlert as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(alertArgs.type).toBe("danger");
    expect(alertArgs.message).toContain("Authorization failed");
  });

  test("Buttons are disabled while Share is in flight; a second click during that window is ignored (R6.1, R11.1)", async () => {
    // No ace_opportunity_id on this deal, so Share is rendered.
    // (Decks with `ace_opportunity_id` set + empty/Pending review
    // status hide Share entirely under the PREVENT-NULL-REVIEW-STATUS
    // guard — see the dedicated tests in the
    // "Submission_Mode + Submit_Action" describe.)
    const actions = makeActions({
      description: "desc",
    });
    let resolveFetch: (value: {
      ok: true;
      status: 200;
      json: () => Promise<{ ok: true; message: string }>;
    }) => void = () => undefined;
    const pending = new Promise<{
      ok: true;
      status: 200;
      json: () => Promise<{ ok: true; message: string }>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchFn = vi.fn(() => pending) as unknown as FetchFn;
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    const shareBtn = await screen.findByText(/Share to AWS \(/i);
    await act(async () => {
      fireEvent.click(shareBtn);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Sharing/i)).toBeInTheDocument();
    });
    const busyShareBtn = screen.getByText(/Sharing/i).closest("button");
    expect(busyShareBtn).not.toBeNull();
    expect(busyShareBtn).toBeDisabled();
    // Refresh is hidden when there's no oppId, so we can't assert
    // it's also disabled here. The Submission_Mode describe block
    // covers Refresh-disabled-while-Submit-in-flight against a deal
    // with an oppId.

    // A second click during the in-flight window does not spawn a second
    // fetch.
    fireEvent.click(busyShareBtn!);
    expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, message: "ok" }),
      });
      await pending;
    });
  });

  test("Missing apiBaseUrl → danger toast, no fetch", async () => {
    const actions = makeActions({
      description: "desc",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl=""
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    fireEvent.click(
      await screen.findByText(/Share to AWS \(/i)
    );
    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const alertArgs = (actions.addAlert as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(alertArgs.type).toBe("danger");
    expect(alertArgs.message).toMatch(/not configured/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Submission_Mode + Submit_Action tests (ace-share-submit-decoupling spec
// — Task 7.2). These cover the new two-button layout: Share's mode-aware
// label + helper line (R1.4-R1.7), Submit's visibility (R5.1-R5.3),
// Submit's enabled label (R5.6), and the in-flight Submit gating
// (R9.1-R9.3).
// ---------------------------------------------------------------------------

describe("AceShareCard — Submission_Mode + Submit_Action", () => {
  test("Create_And_Submit: Share label is 'Share to AWS (creates and submits)' and helper line announces submit-for-review (R1.4, R1.6)", async () => {
    // All Submission_Required_Fields populated, no `aws_review_status`,
    // no `ace_opportunity_id` — classifier returns Create_And_Submit.
    // The deal is also create-ready so the readiness gate passes and the
    // submission-mode label (not the "complete required fields" gate) shows.
    const actions = makeActions({
      ...createReadyFields(),
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    expect(
      await screen.findByText("Share to AWS (creates and submits)")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This click will submit the opportunity to AWS for review."
      )
    ).toBeInTheDocument();
    // The other mode's label MUST NOT be on screen.
    expect(
      screen.queryByText("Share to AWS (save as draft)")
    ).not.toBeInTheDocument();
  });

  test("Create_Only because of missing ace_visibility: Share label is 'Share to AWS (save as draft)' and helper line lists the missing field (R1.5, R1.7)", async () => {
    // `ace_involvement_type` is set, `ace_visibility` is empty —
    // classifier returns Create_Only and missingSubmissionFields
    // returns ["ace_visibility"]. The deal is create-ready (visibility
    // is a submission-only field, not a create precondition) so the
    // submission-mode label shows rather than the readiness gate label.
    const actions = makeActions({
      ...createReadyFields(),
      ace_involvement_type: "Co-Sell",
      ace_visibility: "",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    expect(
      await screen.findByText("Share to AWS (save as draft)")
    ).toBeInTheDocument();
    // Helper line lists the missing field name.
    const helper = screen.getByText(/Missing for submission:/);
    expect(helper).toHaveTextContent("ace_visibility");
    // The other mode's label MUST NOT be on screen.
    expect(
      screen.queryByText("Share to AWS (creates and submits)")
    ).not.toBeInTheDocument();
  });

  test("Not-fully-ready new deal: Share label is 'save as draft' (never 'creates and submits'), button stays enabled", async () => {
    // Submission fields are populated (would classify Create_And_Submit),
    // but required CREATE fields (amount, close date, country, solutions…)
    // are missing. Because the deal isn't fully ready, the button must NOT
    // promise "creates and submits" — it offers a draft, and the readiness
    // checklist lists what's missing. The button stays clickable so the
    // backend returns (and now logs) the canonical precondition error.
    const actions = makeActions({
      description: "desc",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    const draftBtn = await screen.findByText("Share to AWS (save as draft)");
    expect(draftBtn).toBeInTheDocument();
    expect(draftBtn.closest("button")).not.toBeDisabled();
    // The misleading submit promise MUST NOT show while fields are missing.
    expect(
      screen.queryByText("Share to AWS (creates and submits)")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "This click will submit the opportunity to AWS for review."
      )
    ).not.toBeInTheDocument();
    // Helper reflects the draft framing.
    expect(
      screen.getByText(/save the opportunity to AWS as a draft/i)
    ).toBeInTheDocument();
  });

  test("Submit button visible and enabled with label 'Submit for AWS Review' when ace_opportunity_id set + aws_review_status='Pending Submission' (R5.1, R5.2, R5.3, R5.6)", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-PENDING",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    const submitBtn = await screen.findByText("Submit for AWS Review");
    expect(submitBtn).toBeInTheDocument();
    expect(submitBtn.closest("button")).not.toBeDisabled();
  });

  test("Submit button hidden when aws_review_status='Submitted' (R5.3)", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-SUBMITTED",
      aws_review_status: "Submitted",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    // Wait for the card to load.
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(
      screen.queryByText("Submit for AWS Review")
    ).not.toBeInTheDocument();
  });

  // Saved-but-unsubmitted drafts (oppId set + aws_review_status ∈
  // {"Pending Submission", ""}) keep an editable Share button
  // ("Push updates to AWS") alongside Submit. The backend preserves
  // ReviewStatus on update (R-PREVENT-NULL-REVIEW-STATUS passthrough in
  // payload.ts), so pushing updates to a draft is safe — reps update the
  // draft and submit when ready.

  test("Draft already saved (Pending Submission) + missing submission fields: Share shows 'Push updates to AWS'; missing-fields hint sits next to Submit; Submit is disabled", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-PENDING",
      aws_review_status: "Pending Submission",
      // Missing ace_involvement_type and ace_visibility.
      ace_involvement_type: "",
      ace_visibility: "",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    // Share is available as an update action for the saved draft.
    expect(screen.getByText("Push updates to AWS")).toBeInTheDocument();
    // The create-mode labels never apply once an opp exists.
    expect(
      screen.queryByText("Share to AWS (creates and submits)")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Share to AWS (save as draft)")
    ).not.toBeInTheDocument();
    // The create-mode helper line is suppressed when an opp exists.
    expect(
      screen.queryByText(/save the opportunity to AWS as a draft/i)
    ).not.toBeInTheDocument();
    // Missing-fields nudge sits below Submit.
    const missing = screen.getByText(/Missing for submission:/);
    expect(missing).toHaveTextContent("ace_involvement_type");
    expect(missing).toHaveTextContent("ace_visibility");
    expect(missing).toHaveTextContent(
      /Populate these fields on the deal, then click Submit/,
    );
    // Submit is rendered but disabled because the missing fields gate it.
    const submitBtn = screen.getByText("Submit for AWS Review");
    expect(submitBtn.closest("button")).toBeDisabled();
  });

  test("Draft already saved (Pending Submission) + all fields populated: Share shows 'Push updates to AWS', Submit is enabled primary", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-PENDING",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    // Share is available as an update action.
    expect(screen.getByText("Push updates to AWS")).toBeInTheDocument();
    // Create-mode labels don't apply once an opp exists.
    expect(
      screen.queryByText("Share to AWS (creates and submits)")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Share to AWS (save as draft)")
    ).not.toBeInTheDocument();
    const submitBtn = screen.getByText("Submit for AWS Review").closest(
      "button",
    );
    expect(submitBtn).not.toBeDisabled();
    expect(submitBtn).toHaveAttribute("data-variant", "primary");
    // No missing-fields hint.
    expect(
      screen.queryByText(/Missing for submission:/),
    ).not.toBeInTheDocument();
    // This fixture carries no ace_last_sync / hs_lastmodifieddate, so it
    // is NOT in the "Pending Sync" state — Submit stays enabled and the
    // push-first lock message is absent.
    expect(
      screen.queryByText(/edits that aren.t on AWS yet/i),
    ).not.toBeInTheDocument();
  });

  test("Pending Sync (edited after last sync): Submit is LOCKED until the rep pushes, with a clear reason", async () => {
    // Repro of the reported bug: a draft was shared with fields missing,
    // the rep then filled them in. All submission fields are now present
    // (missingFields empty), but the edits haven't been pushed to AWS —
    // the opp is stale. Submit must be disabled and explain why.
    const lastSync = String(Date.parse("2026-06-26T10:00:00.000Z")); // epoch ms
    const editedLater = String(Date.parse("2026-06-26T10:30:00.000Z")); // epoch ms
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-PENDING-SYNC",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
      ace_sync_status: "Synced",
      ace_last_sync: lastSync,
      hs_lastmodifieddate: editedLater,
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    // Push is still available.
    expect(screen.getByText("Push updates to AWS")).toBeInTheDocument();
    // Submit is present but DISABLED because of unpushed edits.
    const submitBtn = screen.getByText("Submit for AWS Review").closest(
      "button",
    );
    expect(submitBtn).toBeDisabled();
    // And the reason is shown.
    expect(
      screen.getByText(/edits that aren.t on AWS yet/i),
    ).toBeInTheDocument();
  });

  test("Draft already saved (legacy empty aws_review_status, R11.2): Share shows 'Push updates to AWS' alongside Submit", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-LEGACY",
      // aws_review_status absent — the legacy "orphan opp" recovery state.
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(screen.getByText("Push updates to AWS")).toBeInTheDocument();
    expect(
      screen.queryByText("Share to AWS (creates and submits)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Share to AWS (save as draft)"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Submit for AWS Review"),
    ).toBeInTheDocument();
  });

  test("inFlight='submit': both Share and Submit are disabled, Submit label is 'Submitting…' (R9.1, R9.2, R9.3)", async () => {
    const actions = makeActions({
      description: "desc",
      ace_opportunity_id: "O-PENDING",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    // The fetch never resolves while we observe the in-flight UI.
    let resolveFetch: (value: {
      ok: true;
      status: 200;
      json: () => Promise<{ ok: true; message: string }>;
    }) => void = () => undefined;
    const pending = new Promise<{
      ok: true;
      status: 200;
      json: () => Promise<{ ok: true; message: string }>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchFn = vi.fn(() => pending) as unknown as FetchFn;
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />
    );
    const submitBtn = await screen.findByText("Submit for AWS Review");
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    // Submit button now reads "Submitting…".
    await waitFor(() => {
      expect(screen.queryByText(/Submitting/i)).toBeInTheDocument();
    });
    const busySubmitBtn = screen.getByText(/Submitting/i).closest("button");
    expect(busySubmitBtn).not.toBeNull();
    expect(busySubmitBtn).toBeDisabled();
    // Share ("Push updates to AWS") is still rendered for the saved
    // draft, but disabled while the Submit is in flight.
    const pushBtn = screen.getByText("Push updates to AWS").closest("button");
    expect(pushBtn).toBeDisabled();
    // Create-mode labels never apply once an opp exists.
    expect(
      screen.queryByText("Share to AWS (creates and submits)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Share to AWS (save as draft)"),
    ).not.toBeInTheDocument();
    // Resolve the pending fetch so the test cleans up.
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, message: "ok" }),
      });
      await pending;
    });
  });
});


// ---------------------------------------------------------------------------
// Share-readiness checklist tests
// ---------------------------------------------------------------------------

describe("AceShareCard — share-readiness checklist", () => {
  /**
   * Build a deal that satisfies every required precondition by default.
   * Individual tests blank out one field at a time to exercise the
   * "missing" path.
   */
  function fullyPopulatedDeal(): Record<string, string> {
    return {
      description:
        "Customer needs to migrate ten workloads to AWS by Q3.",
      dealname: "Acme Migration",
      dealstage: "qualifiedtobuy",
      amount: "12000",
      closedate: futureDate(),
      ace_country_code: "US",
      ace_state_or_region: "WA",
      ace_postal_code: "98101",
      ace_industry: "Software and Internet",
      ace_website_url: "https://acme.com",
      ace_currency_code: "USD",
      ace_solutions: "S-0000001",
      ace_marketing_source: "No",
    };
  }

  test("All required fields populated → checklist collapses to 'Ready to share' one-liner", async () => {
    const actions = makeActions(fullyPopulatedDeal());
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
    // Detailed labels are NOT rendered when collapsed.
    expect(
      screen.queryByText("Customer postal code"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Description (≥ 20 characters)"),
    ).not.toBeInTheDocument();
  });

  test("Missing closedate → checklist expands and lists 'Close date' as missing", async () => {
    const deal = fullyPopulatedDeal();
    deal.closedate = "";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // Checklist heading reflects the missing count.
    expect(screen.getByText(/1 field missing/)).toBeInTheDocument();
    // Close date is rendered with its red icon prefix.
    expect(
      screen.getByText((content) =>
        content.includes("❌") && content.includes("Close date"),
      ),
    ).toBeInTheDocument();
  });

  test("Solution Offering: ace_other_solution_description satisfies the rule (no Solution ID needed)", async () => {
    const deal = fullyPopulatedDeal();
    deal.ace_solutions = "";
    deal.ace_other_solution_description =
      "Custom integration outside Partner Central catalog.";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // No "Solution Offering" missing entry.
    expect(
      screen.queryByText(/❌.*Solution Offering/),
    ).not.toBeInTheDocument();
    // Heading shows ready (collapsed or expanded with advisories only).
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
  });

  test("Solution Offering: both ace_solutions and other-description blank → missing", async () => {
    const deal = fullyPopulatedDeal();
    deal.ace_solutions = "";
    deal.ace_other_solution_description = "";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((content) =>
        content.includes("❌") && content.includes("Solution Offering"),
      ),
    ).toBeInTheDocument();
  });

  test("State is N/A (gray) when country is not US", async () => {
    const deal = fullyPopulatedDeal();
    deal.ace_country_code = "IE";
    deal.ace_state_or_region = "";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // Should NOT be flagged as missing despite blank state.
    expect(
      screen.queryByText((content) =>
        content.includes("❌") && content.includes("Customer state"),
      ),
    ).not.toBeInTheDocument();
    // The checklist is collapsed since no required item is missing.
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
  });

  test("State is required (red) when country is US and state is blank", async () => {
    const deal = fullyPopulatedDeal();
    deal.ace_country_code = "US";
    deal.ace_state_or_region = "";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((content) =>
        content.includes("❌") && content.includes("Customer state"),
      ),
    ).toBeInTheDocument();
  });

  test("Marketing fields are advisory (yellow) when source is Yes and they are blank", async () => {
    const deal = fullyPopulatedDeal();
    deal.ace_marketing_source = "Yes";
    deal.ace_marketing_campaign_name = "";
    deal.ace_marketing_channels = "";
    deal.ace_aws_funding_used = "";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // Heading shows advisories only — required fields are all OK.
    expect(
      screen.getByText(/optional field.*worth setting/),
    ).toBeInTheDocument();
    // Each Marketing field renders with the yellow icon.
    expect(
      screen.getByText((content) =>
        content.includes("⚠️") && content.includes("Marketing campaign name"),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) =>
        content.includes("⚠️") && content.includes("Marketing channels"),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText((content) =>
        content.includes("⚠️") && content.includes("AWS funding used"),
      ),
    ).toBeInTheDocument();
  });

  test("Marketing fields are NOT shown when source is No (n/a, omitted from list)", async () => {
    const deal = fullyPopulatedDeal();
    deal.ace_marketing_source = "No";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // No marketing entries on screen.
    expect(
      screen.queryByText(/Marketing campaign name/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Marketing channels/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AWS funding used/)).not.toBeInTheDocument();
  });

  test("Checklist is hidden when the deal already has an opportunity (post-create)", async () => {
    const deal = fullyPopulatedDeal();
    // Once the deal is on AWS, the create-time preconditions are
    // past — the checklist hides.
    deal.ace_opportunity_id = "O-EXISTING";
    deal.aws_review_status = "Pending Submission";
    deal.ace_involvement_type = "Co-Sell";
    deal.ace_visibility = "Full";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    // Wait for refresh to render (Refresh appears once oppId is set).
    await screen.findByText(/Refresh from AWS Partner Central/i);
    expect(
      screen.queryByText(/Ready to share to AWS/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Required to share/),
    ).not.toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// Share-readiness checklist — company-fallback tests
// ---------------------------------------------------------------------------

describe("AceShareCard — checklist deal→company fallback", () => {
  /**
   * Build a deal whose customer fields are all on the company side,
   * not on the deal — i.e. the rep set country/state/zip on the
   * associated company instead of duplicating on the deal. The
   * checklist must pull from `companyProps` and show ✅ for these
   * entries.
   */
  function dealWithoutCustomerOverrides(): Record<string, string> {
    return {
      description:
        "Customer needs to migrate ten workloads to AWS by Q3.",
      dealname: "Acme Migration",
      dealstage: "qualifiedtobuy",
      amount: "12000",
      closedate: futureDate(),
      // Deliberately blank — the values live on the company.
      ace_country_code: "",
      ace_state_or_region: "",
      ace_postal_code: "",
      // Industry / currency have no company fallback, and website is set
      // on the deal so these fallback tests stay focused on country/state/
      // postal.
      ace_industry: "Software and Internet",
      ace_currency_code: "USD",
      ace_website_url: "https://acme.com",
      ace_solutions: "S-0000001",
      ace_marketing_source: "No",
    };
  }

  test("country/state/postal on the company → checklist shows ✅ via fallback", async () => {
    const actions = makeActions(dealWithoutCustomerOverrides());
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
        companyProps={{
          hs_country_code: "US",
          state: "WA",
          zip: "98101",
        }}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // Collapsed because every required item is OK once we pick up
    // the company-level values.
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
    // No red entries for any customer field.
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer country code"),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer state"),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer postal code"),
      ),
    ).not.toBeInTheDocument();
  });

  test("blank on both deal and company → checklist shows ❌ with deal-or-company hint", async () => {
    const actions = makeActions(dealWithoutCustomerOverrides());
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
        companyProps={{}} // No company association data.
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((c) =>
        c.includes("❌") && c.includes("Customer country code"),
      ),
    ).toBeInTheDocument();
    // The "set on deal OR company" hint appears under both country
    // and postal entries (both blank), so use getAllByText.
    expect(
      screen.getAllByText(/Set on the deal directly OR on the associated company/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("country on company but state blank everywhere (US) → state shows ❌", async () => {
    const actions = makeActions(dealWithoutCustomerOverrides());
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
        companyProps={{
          hs_country_code: "US",
          state: "",
          zip: "98101",
        }}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((c) =>
        c.includes("❌") && c.includes("Customer state"),
      ),
    ).toBeInTheDocument();
    // Country and postal still ✅ (no red marker for them).
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer country code"),
      ),
    ).not.toBeInTheDocument();
  });

  test("country on company, non-US → state is N/A (gray), no missing entry", async () => {
    const actions = makeActions(dealWithoutCustomerOverrides());
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
        companyProps={{
          hs_country_code: "IE",
          state: "",
          zip: "D02 X285",
        }}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer state"),
      ),
    ).not.toBeInTheDocument();
  });

  test("deal override wins when both deal and company carry the value", async () => {
    const deal = dealWithoutCustomerOverrides();
    deal.ace_country_code = "GB";
    deal.ace_state_or_region = "England";
    deal.ace_postal_code = "SW1A 1AA";
    const actions = makeActions(deal);
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
        companyProps={{
          hs_country_code: "US",
          state: "CA",
          zip: "94103",
        }}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // Country is GB → state is N/A (only required when US). No
    // "Inherited from the associated company" hints because the
    // deal-level value won.
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Inherited from the associated company/),
    ).not.toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// Share button visibility — review-locked + post-create states
// ---------------------------------------------------------------------------

describe("AceShareCard — Share visibility across review states", () => {
  test.each([
    "Submitted",
    "In Review",
  ])(
    "Share button is HIDDEN when aws_review_status is %s (review-blocked)",
    async (state) => {
      // AWS rejects every UpdateOpportunity during the review
      // window, so the create-mode "save as draft" / "creates and
      // submits" framing is wrong AND clicking the button would
      // hard-fail the precondition gate. Hide it. The
      // "Updates blocked while AWS is reviewing" Alert remains
      // visible to explain the situation.
      const actions = makeActions({
        description: "desc with enough characters to satisfy the rule",
        ace_opportunity_id: "O-IN-REVIEW",
        aws_review_status: state,
        ace_involvement_type: "Co-Sell",
        ace_visibility: "Full",
      });
      const fetchFn = makeFetchFn({ ok: true, message: "" });
      render(
        <AceShareCard
          dealId={42}
          apiBaseUrl={API}
          actions={actions}
          fetchFn={fetchFn}
        />,
      );
      await screen.findByText(/Refresh from AWS Partner Central/i);
      // None of the Share label variants render.
      expect(
        screen.queryByText("Share to AWS (creates and submits)"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Share to AWS (save as draft)"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Push updates to AWS"),
      ).not.toBeInTheDocument();
      // The review-blocked Alert IS shown.
      expect(
        screen.getByText(/Updates blocked while AWS is reviewing/),
      ).toBeInTheDocument();
    },
  );

  test.each([
    "Approved",
    "Action Required",
    "Disqualified",
    "Rejected",
  ])(
    "Share button shows 'Push updates to AWS' (no helper line) when opp exists with editable status %s",
    async (state) => {
      // These states accept UpdateOpportunity (with the locked-
      // customer passthrough where applicable). Share's role is to
      // push HubSpot edits to AWS — not to "save as draft" or
      // "create and submit". Render a neutral label instead.
      const actions = makeActions({
        description: "desc with enough characters to satisfy the rule",
        ace_opportunity_id: "O-EDIT",
        aws_review_status: state,
        ace_involvement_type: "Co-Sell",
        ace_visibility: "Full",
      });
      const fetchFn = makeFetchFn({ ok: true, message: "" });
      render(
        <AceShareCard
          dealId={42}
          apiBaseUrl={API}
          actions={actions}
          fetchFn={fetchFn}
        />,
      );
      await screen.findByText(/Refresh from AWS Partner Central/i);
      expect(
        screen.getByText("Push updates to AWS"),
      ).toBeInTheDocument();
      // The create-mode helper lines MUST NOT render.
      expect(
        screen.queryByText(
          "This click will submit the opportunity to AWS for review.",
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText((c) =>
          c.includes("save the opportunity to AWS as a draft"),
        ),
      ).not.toBeInTheDocument();
      // The original create-mode share labels MUST NOT render.
      expect(
        screen.queryByText("Share to AWS (creates and submits)"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Share to AWS (save as draft)"),
      ).not.toBeInTheDocument();
    },
  );
});


// ---------------------------------------------------------------------------
// AWS cross-field incompatibility detection + humanized failure messages
// ---------------------------------------------------------------------------

describe("AceShareCard — AWS incompatibility detection", () => {
  test("Co-Sell + Limited surfaces a red checklist row before Share is clicked", async () => {
    // No oppId yet so the readiness checklist is rendered.
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      dealname: "Acme Migration",
      dealstage: "qualifiedtobuy",
      amount: "12000",
      closedate: futureDate(),
      ace_country_code: "US",
      ace_state_or_region: "WA",
      ace_postal_code: "98101",
      ace_solutions: "S-0000001",
      ace_marketing_source: "No",
      // The trigger.
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Limited",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((c) =>
        c.includes("❌") &&
        c.includes("Incompatible: Co-Sell + Limited Visibility"),
      ),
    ).toBeInTheDocument();
    // Hint includes the structural fix.
    expect(
      screen.getByText(/Change Visibility to "Full"/),
    ).toBeInTheDocument();
  });

  test("Co-Sell + Limited disables the Submit button and renders a warning Alert", async () => {
    // OppId present so Submit renders. Co-Sell + Limited is the
    // structural blocker — Submit must be disabled and a warning
    // banner must appear above it.
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "O-INCOMPAT",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Limited",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText("Submit for AWS Review");
    const submitBtn = screen.getByText("Submit for AWS Review").closest(
      "button",
    );
    expect(submitBtn).toBeDisabled();
    // The warning Alert above Submit.
    expect(
      screen.getByText(/Incompatible: Co-Sell \+ Limited Visibility/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /AWS rejects Co-Sell opportunities with Limited Visibility/,
      ),
    ).toBeInTheDocument();
  });

  test("Co-Sell + Full does NOT trigger the incompatibility (control)", async () => {
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "O-OK",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    const submitBtn = (
      await screen.findByText("Submit for AWS Review")
    ).closest("button");
    expect(submitBtn).not.toBeDisabled();
    expect(
      screen.queryByText(/Incompatible: Co-Sell \+ Limited Visibility/),
    ).not.toBeInTheDocument();
  });

  test("For Visibility Only + Limited does NOT trigger the incompatibility", async () => {
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "O-OK-LIMITED",
      aws_review_status: "Pending Submission",
      ace_involvement_type: "For Visibility Only",
      ace_visibility: "Limited",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "For Visibility Only",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    const submitBtn = (
      await screen.findByText("Submit for AWS Review")
    ).closest("button");
    expect(submitBtn).not.toBeDisabled();
    expect(
      screen.queryByText(/Incompatible: Co-Sell \+ Limited Visibility/),
    ).not.toBeInTheDocument();
  });
});

describe("AceShareCard — humanized submission failure", () => {
  test("Co-Sell + Limited rejection: Last-failed Alert shows summary + fix + raw AWS message", async () => {
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "O-FAIL",
      // Cleared to Full afterwards so the rep CAN re-Submit; the
      // ace_sync_error is what carries the past failure context.
      aws_review_status: "Pending Submission",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
      ace_sync_error:
        "StartEngagement: BUSINESS_VALIDATION_EXCEPTION primaryNeedsFromAws:Cannot set visibility to limited on a Co-Sell opportunity;ACTION_NOT_PERMITTED:You cannot perform Submit action. Opportunity cannot be submitted or updated to Limited Visibility",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText("Submit for AWS Review");
    expect(screen.getByText("Last submission failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        /AWS rejects Co-Sell opportunities with Limited Visibility/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/How to fix:.*Visibility to "Full"/),
    ).toBeInTheDocument();
    // The raw AWS message is still surfaced in italics so the rep can
    // copy-paste the full diagnostic.
    expect(
      screen.getByText(
        /AWS message:.*BUSINESS_VALIDATION_EXCEPTION primaryNeedsFromAws/,
      ),
    ).toBeInTheDocument();
  });

  test("Past TargetCloseDate rejection is humanized", async () => {
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "",
      ace_sync_error:
        "StartEngagement: BUSINESS_VALIDATION_EXCEPTION lifeCycle.targetCloseDate:Invalid Data: Target Close Date should be a future date",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    // The error renders in the legacy "Last sync error" banner
    // (not the Submit-side "Last submission failed" alert) because
    // there's no oppId yet — Submit isn't visible. So we look for
    // the raw text rather than asserting the curated explanation
    // here.
    expect(
      screen.getByText(/Target Close Date should be a future date/),
    ).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// Live property updates — onCrmPropertiesUpdate
// ---------------------------------------------------------------------------

describe("AceShareCard — live property updates", () => {
  test("Filling a missing field via sidebar flips the checklist row from ❌ to ✅ without a manual Refresh", async () => {
    // Capture the subscription callback so the test can fire it
    // manually as a stand-in for HubSpot's push notification.
    let pushUpdate:
      | ((changed: Record<string, string>) => void)
      | undefined;
    const onCrmPropertiesUpdate = vi.fn(
      (
        _properties: string[] | "*",
        callback: (
          changed: Record<string, string>,
          error?: { message: string },
        ) => void,
      ) => {
        pushUpdate = (changed) => callback(changed);
      },
    );

    const actions = makeActions(
      {
        description: "desc with enough characters to satisfy the rule",
        dealname: "Acme Migration",
        dealstage: "qualifiedtobuy",
        amount: "12000",
        closedate: futureDate(),
        ace_country_code: "",
        ace_state_or_region: "",
        ace_postal_code: "",
        ace_industry: "Software and Internet",
        ace_currency_code: "USD",
        ace_website_url: "https://acme.com",
        ace_solutions: "S-0000001",
        ace_marketing_source: "No",
      },
      { onCrmPropertiesUpdate },
    );
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
        // No company association data, so country/postal must come
        // from the deal-level overrides only.
        companyProps={{}}
      />,
    );

    // Initial render: country and postal are red.
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((c) =>
        c.includes("❌") && c.includes("Customer country code"),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText((c) =>
        c.includes("❌") && c.includes("Customer postal code"),
      ),
    ).toBeInTheDocument();

    // The card subscribed during mount.
    expect(onCrmPropertiesUpdate).toHaveBeenCalledTimes(1);
    expect(pushUpdate).toBeDefined();

    // Simulate the rep filling country + postal in the HubSpot sidebar.
    await act(async () => {
      pushUpdate!({ ace_country_code: "US", ace_postal_code: "98101" });
    });

    // Country flipped to ✅, but state is now ❌ because country is US
    // and state is still empty.
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer country code"),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText((c) =>
        c.includes("❌") && c.includes("Customer postal code"),
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText((c) =>
        c.includes("❌") && c.includes("Customer state"),
      ),
    ).toBeInTheDocument();

    // Now the rep fills state. All required items go green and the
    // checklist collapses to the one-liner.
    await act(async () => {
      pushUpdate!({ ace_state_or_region: "WA" });
    });
    expect(screen.getByText(/Ready to share to AWS/)).toBeInTheDocument();
  });

  test("Errors from the subscription callback are silent (best-effort live sync)", async () => {
    let pushError:
      | ((err: { message: string }) => void)
      | undefined;
    const onCrmPropertiesUpdate = vi.fn(
      (
        _properties: string[] | "*",
        callback: (
          changed: Record<string, string>,
          error?: { message: string },
        ) => void,
      ) => {
        pushError = (err) => callback({}, err);
      },
    );

    const actions = makeActions(
      { description: "desc with enough characters to satisfy the rule" },
      { onCrmPropertiesUpdate },
    );
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(pushError).toBeDefined();

    // Fire an error — should NOT crash the card and should NOT
    // surface a toast (this is a best-effort live sync).
    await act(async () => {
      pushError!({ message: "transient hub error" });
    });
    expect(actions.addAlert).not.toHaveBeenCalled();
    // Card still rendered.
    expect(screen.getByText(/Share to AWS \(/i)).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// AWS Products integration
// ---------------------------------------------------------------------------

describe("AceShareCard — AWS Products", () => {
  test("DescriptionList shows AWS Products row with the deal value", async () => {
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "O-WITH-PRODUCTS",
      aws_review_status: "Pending Submission",
      ace_solutions: "S-0066145",
      ace_aws_products: "AmazonEC2P5;S3IntelligentTiering",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText("AWS Products");
    expect(
      screen.getByText("AmazonEC2P5;S3IntelligentTiering"),
    ).toBeInTheDocument();
  });

  test("AWS Products checklist row appears (advisory) when populated, omitted when blank", async () => {
    // Populated case → row shows count.
    const populatedActions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      dealname: "Acme",
      dealstage: "qualifiedtobuy",
      amount: "12000",
      closedate: futureDate(),
      ace_country_code: "US",
      ace_state_or_region: "WA",
      ace_postal_code: "98101",
      ace_solutions: "S-0066145",
      ace_aws_products: "AmazonEC2P5;S3IntelligentTiering;AWSLambda",
      ace_marketing_source: "No",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    const { unmount } = render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={populatedActions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.getByText((c) =>
        c.includes("ℹ️") && c.includes("AWS Products (3 associated)"),
      ),
    ).toBeInTheDocument();
    unmount();

    // Blank case → no AWS Products row in the checklist.
    const blankActions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      dealname: "Acme",
      dealstage: "qualifiedtobuy",
      amount: "12000",
      closedate: futureDate(),
      ace_country_code: "US",
      ace_state_or_region: "WA",
      ace_postal_code: "98101",
      ace_solutions: "S-0066145",
      ace_aws_products: "",
      ace_marketing_source: "No",
    });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={blankActions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText(/Share to AWS \(/i);
    expect(
      screen.queryByText(/AWS Products \(\d+ associated\)/),
    ).not.toBeInTheDocument();
  });

  test("AWS Products with codes containing dots and spaces (legitimate AWS catalog values) render verbatim", async () => {
    const actions = makeActions({
      description: "desc with enough characters to satisfy the rule",
      ace_opportunity_id: "O-EDGECASE",
      aws_review_status: "Pending Submission",
      ace_solutions: "S-0066145",
      ace_aws_products: "CODE.AWS;Amazon GameCast",
      ace_involvement_type: "Co-Sell",
      ace_visibility: "Full",
      ace_delivery_model: "SaaS or PaaS",
      ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
      ace_customer_use_case: "Business Applications & Contact Center",
      ace_sales_activities: "Initialized discussions with customer",
    });
    const fetchFn = makeFetchFn({ ok: true, message: "" });
    render(
      <AceShareCard
        dealId={42}
        apiBaseUrl={API}
        actions={actions}
        fetchFn={fetchFn}
      />,
    );
    await screen.findByText("AWS Products");
    // Verbatim display — preserves the dot and the internal space.
    expect(
      screen.getByText("CODE.AWS;Amazon GameCast"),
    ).toBeInTheDocument();
  });
});
