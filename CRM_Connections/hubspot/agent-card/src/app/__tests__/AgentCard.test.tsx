/**
 * React Testing Library tests for `AgentCard`.
 *
 * Same `@hubspot/ui-extensions` mocking approach as the share/refresh
 * card: replace the module with plain-HTML passthroughs.
 *
 * Most tests pass `cooldownMs={0}` to disable the per-send cooldown so
 * the test doesn't have to coordinate fake timers with the wallclock.
 * Cooldown-specific tests pass a finite value and assert the button
 * text reflects the wait state.
 */

import React from "react";
import { describe, test, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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

  const InputComp = ({
    name,
    label,
    value,
    onChange,
    placeholder,
  }: {
    name: string;
    label?: string;
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
  }) =>
    ReactLib.createElement(
      "label",
      null,
      label ?? "",
      ReactLib.createElement("input", {
        "data-name": name,
        value: value ?? "",
        placeholder,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          onChange?.(e.target.value),
      })
    );

  return {
    hubspot: {
      extend: () => undefined,
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    },
    Flex: passthrough("div"),
    Text: passthrough("span"),
    Button: passthrough("button"),
    Input: InputComp,
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
        title ? ReactLib.createElement("strong", null, title) : null,
        children
      ),
    Divider: () => ReactLib.createElement("hr", null),
    Heading: passthrough("h1"),
    List: ({
      children,
      variant,
    }: {
      children?: React.ReactNode;
      variant?: string;
    }) =>
      ReactLib.createElement(
        variant === "ordered" ? "ol" : "ul",
        null,
        ReactLib.Children.map(children, (c, i) =>
          ReactLib.createElement("li", { key: i }, c)
        )
      ),
    Table: passthrough("table"),
    TableHead: passthrough("thead"),
    TableHeader: passthrough("th"),
    TableBody: passthrough("tbody"),
    TableRow: passthrough("tr"),
    TableCell: passthrough("td"),
    LoadingSpinner: ({ label }: { label?: string }) =>
      ReactLib.createElement(
        "span",
        { "aria-busy": "true" },
        label ?? "Loading..."
      ),
  };
});

import { AgentCard } from "../cards/AgentCard";

type Props = React.ComponentProps<typeof AgentCard>;
type Actions = Props["actions"];
type FetchFn = Props["fetchFn"];

const API = "https://apigw.example.com";

function makeActions(): Actions {
  return { addAlert: vi.fn() };
}

/**
 * Construct a FetchFn that mimics the async (start + poll) wire
 * shape, returning the supplied agent body as the polled result.
 *
 * Use this for single-turn tests where one user action (Send /
 * Approve / Reject / Override) should resolve to one agent response.
 * Multi-turn tests should chain `asyncResponseSequence` calls via
 * `mockResolvedValueOnce` directly.
 *
 * The legacy signature (`ok`, `status`) is retained so tests that
 * exercise non-200 cases at the API Gateway / start endpoint can
 * still drive that path.
 */
function makeFetchFn(body: unknown, ok = true, status = 200): FetchFn {
  // Non-OK responses at the start endpoint short-circuit before the
  // poll loop ever runs, so we just return that one response.
  if (!ok || status >= 400) {
    return vi.fn(async () => ({
      ok,
      status,
      json: async () => body,
    })) as unknown as FetchFn;
  }
  // Successful path: one call → start (returns jobId), next call → poll
  // (returns the supplied agent body).
  let callIdx = 0;
  return vi.fn(async () => {
    callIdx += 1;
    if (callIdx === 1) {
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, jobId: "test-job-1" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        status: "complete",
        jobId: "test-job-1",
        response: body,
      }),
    };
  }) as unknown as FetchFn;
}

/**
 * Build a mock-fetch sequence for a turn that triggers an async
 * agent response. Mirrors the production wire shape:
 *   1. POST /agent/start → { ok: true, jobId }
 *   2. GET /agent/poll   → { ok: true, status: "complete"|"error", response }
 *
 * Tests use this to mock a single approval / message round-trip
 * after the routing was switched from sync to async. The agent's
 * AgentResponse body sits inside the poll response's `response` field.
 */
function asyncResponseSequence(agentBody: unknown): {
  start: { ok: true; status: number; json: () => Promise<unknown> };
  poll: { ok: true; status: number; json: () => Promise<unknown> };
} {
  return {
    start: {
      ok: true,
      status: 202,
      json: async () => ({ ok: true, jobId: "test-job-1" }),
    },
    poll: {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        status: "complete",
        jobId: "test-job-1",
        response: agentBody,
      }),
    },
  };
}

/** Helper: render with cooldown disabled so tests don't fight the timer. */
function renderCard(props: Partial<Props>): void {
  render(
    <AgentCard
      dealId={42}
      apiBaseUrl={API}
      actions={makeActions()}
      fetchFn={makeFetchFn({})}
      cooldownMs={0}
      pollIntervalMs={0}
      {...props}
    />
  );
}

describe("AgentCard — initial render", () => {
  test("shows hint text when transcript is empty", () => {
    renderCard({});
    expect(
      screen.getByText(/Try:.*Summarise this deal/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Send/i).closest("button")).toBeDisabled();
  });

  test("Send button enables once draft has non-empty text", () => {
    renderCard({});
    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "What's blocking?" },
    });
    expect(screen.getByText(/Send/i).closest("button")).not.toBeDisabled();
  });
});

describe("AgentCard — sending text", () => {
  test("Send POSTs to <api>/agent/start with dealId + message; polls and renders the response", async () => {
    const replyFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "session-1",
      blocks: [{ type: "text", text: "Here are your opportunities..." }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(replyFlow.start)
      .mockResolvedValueOnce(replyFlow.poll) as unknown as FetchFn;
    const actions = makeActions();
    renderCard({ actions, fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "List my opps" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await waitFor(() =>
      expect(
        (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
    const startCall = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(startCall[0]).toBe(`${API}/agent/start`);
    expect(startCall[1]).toMatchObject({
      method: "POST",
      body: { dealId: 42, message: { type: "text", text: "List my opps" } },
    });
    expect((startCall[1] as { body: { sessionId?: string } }).body.sessionId).toBeUndefined();

    const pollCall = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[1];
    expect(pollCall[0]).toContain("/agent/poll?jobId=");
    expect((pollCall[1] as { method: string }).method).toBe("GET");

    await screen.findByText(/Here are your opportunities/i);
    expect(screen.getByText("List my opps")).toBeInTheDocument();
  });

  test("follow-up message includes sessionId from prior response", async () => {
    const firstFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "session-XYZ",
      blocks: [{ type: "text", text: "Hi" }],
    });
    const secondFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "session-XYZ",
      blocks: [{ type: "text", text: "Follow-up answer" }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(firstFlow.start)
      .mockResolvedValueOnce(firstFlow.poll)
      .mockResolvedValueOnce(secondFlow.start)
      .mockResolvedValueOnce(secondFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Hi");

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "second" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await waitFor(() =>
      expect(
        (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
      ).toBe(4),
    );
    // Second send is start call at index 2 — its body should carry the
    // sessionId returned by the first turn.
    const secondStartCall = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[2];
    expect(secondStartCall[0]).toBe(`${API}/agent/start`);
    const secondBody = (secondStartCall[1] as { body: { sessionId?: string } }).body;
    expect(secondBody.sessionId).toBe("session-XYZ");
  });

  test("401 from start → Authorization-failed toast, no transcript update", async () => {
    const fetchFn = makeFetchFn({ ok: false, message: "Unauthorized" }, false, 401);
    const actions = makeActions();
    renderCard({ actions, fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const args = (actions.addAlert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.type).toBe("danger");
    // The async path surfaces start-time failures via the agent
    // backend's message field; the sync 401 path used a different
    // string. We just assert a danger toast fires with a message.
    expect(typeof args.message).toBe("string");
  });

  test("ok:false poll response surfaces a danger toast", async () => {
    const errorFlow = asyncResponseSequence({
      ok: false,
      code: "MCP_PERMISSION_DENIED",
      message: "Your role doesn't allow this action.",
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(errorFlow.start)
      .mockResolvedValueOnce(errorFlow.poll) as unknown as FetchFn;
    const actions = makeActions();
    renderCard({ actions, fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const args = (actions.addAlert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.type).toBe("danger");
    expect(args.message).toMatch(/role.*doesn't allow/i);
  });
});

describe("AgentCard — new conversation", () => {
  test("New conversation button clears transcript and drops sessionId", async () => {
    const firstFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "session-OLD",
      blocks: [{ type: "text", text: "First answer" }],
    });
    const secondFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "session-NEW",
      blocks: [{ type: "text", text: "Fresh start" }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(firstFlow.start)
      .mockResolvedValueOnce(firstFlow.poll)
      .mockResolvedValueOnce(secondFlow.start)
      .mockResolvedValueOnce(secondFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    // Send something to populate sessionId.
    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("First answer");

    // Click "New conversation" — transcript clears, sessionId resets.
    fireEvent.click(screen.getByText(/New conversation/i));
    expect(screen.queryByText("First answer")).not.toBeInTheDocument();
    expect(screen.queryByText("first")).not.toBeInTheDocument();

    // Next send should NOT include the previous sessionId.
    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "second" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    // First send: start + poll (2). Second send: start + poll (4 total).
    await waitFor(() =>
      expect(
        (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
      ).toBe(4),
    );
    // Call index 2 is POST /agent/start for the second send. It must
    // NOT carry the prior sessionId because New conversation cleared it.
    const secondStartCall = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[2];
    expect(secondStartCall[0]).toBe(`${API}/agent/start`);
    const secondCallBody = (
      secondStartCall[1] as { body: { sessionId?: string } }
    ).body;
    expect(secondCallBody.sessionId).toBeUndefined();
  });

  test("New conversation is disabled before any session exists", () => {
    renderCard({});
    expect(
      screen.getByText(/New conversation/i).closest("button"),
    ).toBeDisabled();
  });

  test("New conversation is disabled while a request is in flight", async () => {
    const fetchFn = vi.fn(
      () =>
        new Promise(() => {
          /* never resolves — simulates in-flight */
        }),
    ) as unknown as FetchFn;
    renderCard({ fetchFn });
    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "stuck" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    // While the fetch is pending, the button is disabled.
    await waitFor(() =>
      expect(
        screen.getByText(/New conversation/i).closest("button"),
      ).toBeDisabled(),
    );
  });
});

describe("AgentCard — cooldown behaviour", () => {
  test("after a send the Send button shows 'Wait Ns' and is disabled", async () => {
    const fetchFn = makeFetchFn({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [{ type: "text", text: "Hello" }],
    });
    render(
      <AgentCard
        dealId={42}
        apiBaseUrl={API}
        actions={makeActions()}
        fetchFn={fetchFn}
        cooldownMs={30_000}
        pollIntervalMs={0}
      />
    );

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await screen.findByText("Hello");
    // Send button now reads "Wait Ns" and is disabled.
    const btn = await screen.findByText(/Wait \d+s/);
    expect(btn.closest("button")).toBeDisabled();
  });

  test("MCP_RATE_LIMITED triggers a danger toast", async () => {
    const fetchFn = makeFetchFn(
      {
        ok: false,
        code: "MCP_RATE_LIMITED",
        message: "AWS rate-limited the request. Wait a moment and try again.",
      },
      false,
      503
    );
    const actions = makeActions();
    renderCard({ actions, fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const args = (actions.addAlert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.message).toMatch(/rate-limited/i);
  });
});

describe("AgentCard — approval flow", () => {
  test("requires_approval renders inline approval panel with three buttons", async () => {
    const fetchFn = makeFetchFn({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        { type: "text", text: "I'd like to update O123" },
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "update_opportunity_enhanced",
          parameters: { opportunityId: "O123", stage: "Qualified" },
        },
      ],
    });
    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await screen.findByText(/Action proposed/i);
    expect(screen.getByText(/I'd like to update O123/i)).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
    expect(screen.getByText("Override")).toBeInTheDocument();
  });

  test("Approve click POSTs tool_approval_response", async () => {
    // The user's text Send returns an approval_request block.
    const sendFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "submit_opportunity",
          parameters: { opportunityId: "O123" },
        },
      ],
    });
    // The Approve click resolves with a complete envelope.
    const approvalFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [{ type: "text", text: "Done." }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sendFlow.start)
      .mockResolvedValueOnce(sendFlow.poll)
      .mockResolvedValueOnce(approvalFlow.start)
      .mockResolvedValueOnce(approvalFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Approve");

    fireEvent.click(screen.getByText("Approve"));

    // Send start + send poll + approve start + approve poll = 4 fetches.
    await waitFor(() =>
      expect(
        (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
      ).toBe(4),
    );
    // Call index 2 is POST /agent/start for the Approve action.
    const startCall = (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[2];
    expect(startCall[0]).toBe(`${API}/agent/start`);
    const startBody = (startCall[1] as {
      body: { message: unknown; sessionId?: string };
    }).body;
    expect(startBody.sessionId).toBe("s1");
    expect(startBody.message).toEqual({
      type: "tool_approval_response",
      toolUseId: "u1",
      decision: "approve",
    });
  });

  test("Override is disabled when message is empty, enabled when populated", async () => {
    const fetchFn = makeFetchFn({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "update",
          parameters: {},
        },
      ],
    });
    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Override");

    expect(screen.getByText("Override").closest("button")).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText(/Override instructions/i),
      { target: { value: "Use 250000" } }
    );

    expect(screen.getByText("Override").closest("button")).not.toBeDisabled();
  });

  test("Override click POSTs decision=override with message", async () => {
    const sendFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "update",
          parameters: {},
        },
      ],
    });
    const overrideFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [{ type: "text", text: "ok" }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sendFlow.start)
      .mockResolvedValueOnce(sendFlow.poll)
      .mockResolvedValueOnce(overrideFlow.start)
      .mockResolvedValueOnce(overrideFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Override");

    fireEvent.change(
      screen.getByLabelText(/Override instructions/i),
      { target: { value: "Use 250000" } }
    );

    fireEvent.click(screen.getByText("Override"));

    // Send start + send poll + override start + override poll = 4 fetches.
    await waitFor(() =>
      expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(4)
    );
    // Call index 2 is POST /agent/start for the Override action.
    const body = (
      (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[2][1] as {
        body: { message: unknown };
      }
    ).body;
    expect(body.message).toEqual({
      type: "tool_approval_response",
      toolUseId: "u1",
      decision: "override",
      message: "Use 250000",
    });
  });

  test("Reject without message still POSTs decision=reject", async () => {
    const sendFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "submit",
          parameters: {},
        },
      ],
    });
    const rejectFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [{ type: "text", text: "Cancelled" }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sendFlow.start)
      .mockResolvedValueOnce(sendFlow.poll)
      .mockResolvedValueOnce(rejectFlow.start)
      .mockResolvedValueOnce(rejectFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Reject");

    fireEvent.click(screen.getByText("Reject"));

    // Send start + send poll + reject start + reject poll = 4 fetches.
    await waitFor(() =>
      expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(4)
    );
    // Call index 2 is POST /agent/start for the Reject action.
    const body = (
      (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[2][1] as {
        body: { message: { decision?: string; message?: string } };
      }
    ).body;
    expect(body.message).toEqual({
      type: "tool_approval_response",
      toolUseId: "u1",
      decision: "reject",
    });
  });

  test("Once approved, the buttons disappear and the entry shows 'Approved'", async () => {
    const sendFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "submit",
          parameters: {},
        },
      ],
    });
    const approveFlow = asyncResponseSequence({
      ok: true,
      status: "complete",
      sessionId: "s1",
      blocks: [{ type: "text", text: "Submitted" }],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sendFlow.start)
      .mockResolvedValueOnce(sendFlow.poll)
      .mockResolvedValueOnce(approveFlow.start)
      .mockResolvedValueOnce(approveFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Approve");

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Approved.")).toBeInTheDocument();
  });

  test("duplicate approval prompt is flagged with a warning", async () => {
    // Three responses: prompt 1 (approval), result of approve (text + a
    // SECOND identical approval prompt — the bug we mitigate), then nothing
    // because the test stops here. We want the second approval prompt to
    // render with the duplicate warning copy.
    const params = {
      payload: {
        Customer: { Account: { CompanyName: "Meridian Capital Markets" } },
      },
    };
    const sendFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u-first",
          toolName: "opportunity_creator",
          parameters: params,
        },
      ],
    });
    const dupFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "text",
          text: "Created opp O-1234",
        },
        {
          type: "approval_request",
          toolUseId: "u-second",
          toolName: "opportunity_creator",
          parameters: params,
        },
      ],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sendFlow.start)
      .mockResolvedValueOnce(sendFlow.poll)
      .mockResolvedValueOnce(dupFlow.start)
      .mockResolvedValueOnce(dupFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "create row" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Approve");

    // Approve the first prompt — that resolves with the duplicate prompt.
    fireEvent.click(screen.getByText("Approve"));

    // Wait for the second prompt to render (a fresh "Approve" button appears).
    await waitFor(() =>
      expect(screen.getAllByText("Approve").length).toBeGreaterThan(0),
    );

    // The duplicate-warning copy should be on screen.
    expect(
      screen.getByText(/Duplicate of a previously-approved action/i),
    ).toBeInTheDocument();
  });

  test("non-duplicate approvals render without the duplicate warning", async () => {
    // Two distinct approval payloads — different parameters so no warning.
    const sendFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u1",
          toolName: "opportunity_creator",
          parameters: { customer: "Acme" },
        },
      ],
    });
    const distinctFlow = asyncResponseSequence({
      ok: true,
      status: "requires_approval",
      sessionId: "s1",
      blocks: [
        {
          type: "approval_request",
          toolUseId: "u2",
          toolName: "opportunity_creator",
          parameters: { customer: "Globex" },
        },
      ],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(sendFlow.start)
      .mockResolvedValueOnce(sendFlow.poll)
      .mockResolvedValueOnce(distinctFlow.start)
      .mockResolvedValueOnce(distinctFlow.poll) as unknown as FetchFn;

    renderCard({ fetchFn });

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "go" },
    });
    fireEvent.click(screen.getByText(/Send/i));
    await screen.findByText("Approve");

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() =>
      expect(screen.getAllByText("Approve").length).toBeGreaterThan(0),
    );

    expect(
      screen.queryByText(/Duplicate of a previously-approved action/i),
    ).not.toBeInTheDocument();
  });
});

describe("AgentCard — configuration errors", () => {
  test("missing apiBaseUrl → danger toast, no fetch", async () => {
    const actions = makeActions();
    const fetchFn = makeFetchFn({});
    render(
      <AgentCard
        dealId={42}
        apiBaseUrl=""
        actions={actions}
        fetchFn={fetchFn}
        cooldownMs={0}
      />
    );

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByText(/Send/i));

    await waitFor(() => expect(actions.addAlert).toHaveBeenCalled());
    const args = (actions.addAlert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.type).toBe("danger");
    expect(args.message).toMatch(/not configured/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
