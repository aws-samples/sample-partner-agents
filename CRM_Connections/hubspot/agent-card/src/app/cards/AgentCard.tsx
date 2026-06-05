/**
 * `AgentCard` — HubSpot UI Extension Custom Card.
 *
 * Conversational interface to the AWS Partner Central Agent (MCP) on
 * the deal record sidebar. The card sends user-typed messages and
 * approval responses to a single backend endpoint (`POST /agent`)
 * which proxies them via SigV4 to the AWS Partner Central Agent MCP
 * server. Every write the agent proposes (UpdateOpportunity,
 * SubmitOpportunity, etc.) returns a `requires_approval` payload that
 * the card renders as an inline Approve / Reject / Override panel.
 *
 * Design constraints from the protocol (see
 * docs.aws.amazon.com/partner-central/.../mcp-tools-reference.html):
 *   - sendMessage rate limit: 2 req/min, burst 10. The composer
 *     enforces a 30-second cooldown so the typical user can't trip
 *     the burst.
 *   - Sessions live 48 hours absolute. The card holds `sessionId`
 *     in component state — closing/reopening starts a fresh session.
 *   - SSE streaming is NOT used in v1 because `hubspot.fetch` is a
 *     JSON request/response wrapper. Every call is non-streaming.
 *
 * Like `AceShareCard`, this component accepts injected dependencies
 * (`actions`, `fetchFn`, `apiBaseUrl`) so it's testable under jsdom
 * without HubSpot's remote-ui runtime.
 *
 * Configuration:
 *   The `AGENT_API_BASE_URL` constant below MUST match the value in
 *   `app-hsmeta.json:config.permittedUrls.fetch`. `agent-infra/deploy.sh`
 *   patches both in lockstep after every backend deploy. If the card
 *   shows a "not configured" toast, run the deploy script.
 */

import {
  hubspot,
  Flex,
  Text,
  Button,
  Alert,
  Divider,
  LoadingSpinner,
  Input,
} from "@hubspot/ui-extensions";
import { useCallback, useEffect, useRef, useState } from "react";

import { renderMarkdown } from "./markdown";
import { BulkImportPanel } from "./BulkImportPanel";
// Per-deployment API base URL. The file is gitignored — `npm install`
// materialises it from `config.local.ts.example` if missing, and the
// deploy script (`agent-infra/deploy.sh`) overwrites it with the
// actual `ApiUrl` stack output. Tests pass an explicit `apiBaseUrl`
// prop and don't depend on this import's runtime value.
import { AGENT_API_BASE_URL } from "./config.local";

/**
 * Default per-send cooldown. Set to 0 — we let the MCP server's
 * `MCP_RATE_LIMITED` (-32004) signal be the actual gate. When the
 * server rate-limits a request, the catch path in `callAgent` extends
 * the cooldown to `RATE_LIMIT_COOLDOWN_MS` automatically.
 */
const COMPOSER_COOLDOWN_MS = 0;

/** Extended cooldown when MCP responds with -32004 LIMIT_EXCEEDED. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Wire types — narrow mirrors of the agent-backend's AgentResponse envelope.
// ---------------------------------------------------------------------------

type AgentBlock =
  | { type: "text"; text: string }
  | {
      type: "approval_request";
      toolUseId: string;
      toolName: string;
      parameters: Record<string, unknown>;
    };

type AgentSuccess = {
  ok: true;
  status: "complete" | "requires_approval";
  sessionId: string;
  blocks: AgentBlock[];
};

type AgentErrorBody = {
  ok: false;
  code: string;
  message: string;
};

type AgentResponseBody = AgentSuccess | AgentErrorBody;

// ---------------------------------------------------------------------------
// Transcript entries — the source of truth for the visible chat.
// ---------------------------------------------------------------------------

type UserEntry = { kind: "user"; text: string };
type AgentTextEntry = { kind: "agent_text"; text: string };
type AgentApprovalEntry = {
  kind: "approval_request";
  toolUseId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  /** Latched once the user has acted on it — disables the buttons. */
  acted?: "approve" | "reject" | "override";
};

type TranscriptEntry = UserEntry | AgentTextEntry | AgentApprovalEntry;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** `actions` shape we depend on. Mirrors `@hubspot/ui-extensions` extensionApi. */
type CardActions = {
  addAlert: (args: { type: "success" | "danger"; message: string }) => void;
};

/** Network surface — typed loosely to keep the test seam simple. */
type FetchFn = (
  url: string,
  init: { method: string; body?: object; timeout?: number }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type AgentCardProps = {
  dealId: number;
  /** Optional override for tests. Production uses `AGENT_API_BASE_URL`. */
  apiBaseUrl?: string;
  actions: CardActions;
  /** Optional override for tests. Production uses `hubspot.fetch`. */
  fetchFn?: FetchFn;
  /** Override the per-send cooldown. Defaults to `COMPOSER_COOLDOWN_MS`. */
  cooldownMs?: number;
  /** Override the rate-limit cooldown. Defaults to `RATE_LIMIT_COOLDOWN_MS`. */
  rateLimitCooldownMs?: number;
  /**
   * Polling interval for the async agent path (ms). Production uses
   * 1500 — slow enough to stay well under the MCP rate limit, fast
   * enough to feel responsive. Tests pass 0 to flush immediately.
   */
  pollIntervalMs?: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AgentCard = ({
  dealId,
  apiBaseUrl,
  actions,
  fetchFn,
  cooldownMs = COMPOSER_COOLDOWN_MS,
  rateLimitCooldownMs = RATE_LIMIT_COOLDOWN_MS,
  pollIntervalMs = 1500,
}: AgentCardProps) => {
  const effectiveApiBaseUrl = apiBaseUrl ?? AGENT_API_BASE_URL;

  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [inFlight, setInFlight] = useState<boolean>(false);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());

  // Per-approval override-message draft, keyed by toolUseId. Lifted out of
  // the entry so re-renders during typing don't fight controlled-input edits.
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>(
    {}
  );
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});

  // Tick `now` each second so cooldown countdowns re-render naturally.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  /**
   * Default fetch implementation. The HubSpot SDK's `hubspot.fetch` already
   * handles JWT signing for us; tests pass an explicit `fetchFn`.
   */
  const realFetch = useCallback<FetchFn>(
    async (url, init) => {
      const f = (
        hubspot as unknown as {
          fetch: (
            u: string,
            i: { method: string; body?: object; timeout?: number }
          ) => Promise<{
            ok: boolean;
            status: number;
            json: () => Promise<unknown>;
          }>;
        }
      ).fetch;
      // hubspot.fetch rejects GET/HEAD requests that include a body.
      // Strip it from the init when the method has no body semantics
      // even if our local code passed `{}`.
      const cleanInit =
        init.method === "GET" || init.method === "HEAD"
          ? { method: init.method, ...(init.timeout !== undefined ? { timeout: init.timeout } : {}) }
          : init;
      return f(url, cleanInit);
    },
    []
  );

  const callAgent = useCallback(
    async (
      message:
        | { type: "text"; text: string }
        | {
            type: "tool_approval_response";
            toolUseId: string;
            decision: "approve" | "reject" | "override";
            message?: string;
          },
      opts: { freshSession?: boolean } = {},
    ): Promise<{ ok: boolean; errorMessage?: string }> => {
      if (!effectiveApiBaseUrl) {
        actions.addAlert({
          type: "danger",
          message:
            "Agent backend not configured. Run agent-infra/deploy.sh and reload.",
        });
        return { ok: false, errorMessage: "Agent backend not configured." };
      }
      if (inFlight) return { ok: false, errorMessage: "Already in flight." };
      setInFlight(true);

      const f = fetchFn ?? realFetch;
      try {
        const body: Record<string, unknown> = { dealId, message };
        // Omit sessionId when the caller asks for a fresh session.
        // Bulk-import batches do this to avoid context bloat: a single
        // 30-row CSV with multiple retries per row can balloon the
        // server-held context to where MCP `sendMessage` takes 25-29s
        // to respond, which trips our 29s Lambda timeout. Each bulk
        // batch gets its own clean session; the regular chat keeps
        // session-stickiness so follow-up questions retain context.
        if (sessionId && !opts.freshSession) body.sessionId = sessionId;

        const resp = await f(`${effectiveApiBaseUrl}/agent`, {
          method: "POST",
          body,
          // Match the Lambda timeout (29s) — the API Gateway HTTP API
          // also caps at 29s. Setting this lower just shortens the
          // window relative to a Lambda that may legitimately need
          // every available millisecond. MCP responses on tool-call
          // approvals routinely sit in the 20-25s range; a 25s
          // client cap fires "Gateway took too long" on a Lambda
          // that's still 4-5 seconds from completing successfully.
          timeout: 29_000,
        });

        let payload: AgentResponseBody;
        try {
          payload = (await resp.json()) as AgentResponseBody;
        } catch {
          payload = {
            ok: false,
            code: "INTERNAL",
            message: "Could not read agent response.",
          };
        }

        if (resp.status === 401 && (!("ok" in payload) || !payload.ok)) {
          actions.addAlert({
            type: "danger",
            message:
              "Authorization failed. Reload the HubSpot page and try again.",
          });
          return { ok: false, errorMessage: "Authorization failed." };
        }

        if ("ok" in payload && payload.ok === true) {
          setSessionId(payload.sessionId);
          appendAgentBlocks(setTranscript, payload.blocks);
          if (payload.status === "requires_approval") {
            // Don't surface a toast — the inline panel is the actual UI.
            return { ok: true };
          }
          return { ok: true };
        }

        const errBody = payload as AgentErrorBody;
        const isRateLimited = errBody.code === "MCP_RATE_LIMITED";
        if (isRateLimited) {
          setCooldownUntil(Date.now() + rateLimitCooldownMs);
        }
        // Stale-session recovery: when MCP returns NOT_FOUND for an
        // active sessionId, our local copy is dead. Drop it so the
        // next user action starts a fresh session instead of poking
        // the same dead session repeatedly.
        if (errBody.code === "MCP_NOT_FOUND") {
          setSessionId(undefined);
        }
        actions.addAlert({
          type: "danger",
          message: errBody.message ?? "Agent request failed.",
        });
        return {
          ok: false,
          errorMessage: errBody.message ?? "Agent request failed.",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actions.addAlert({
          type: "danger",
          message: `Agent request failed: ${msg}`,
        });
        return { ok: false, errorMessage: msg };
      } finally {
        setInFlight(false);
        // Always start the standard cooldown after a send. If a rate-limit
        // path already extended it, that longer value wins. When
        // `cooldownMs <= 0` (tests), skip updating to keep the composer
        // immediately ready for the next send.
        if (cooldownMs > 0) {
          setCooldownUntil((prev) =>
            Math.max(prev, Date.now() + cooldownMs)
          );
        }
      }
    },
    [
      actions,
      cooldownMs,
      dealId,
      effectiveApiBaseUrl,
      fetchFn,
      inFlight,
      rateLimitCooldownMs,
      realFetch,
      sessionId,
    ]
  );

  /**
   * Async variant of `callAgent`. Used by the bulk-import panel so a
   * single `sendMessage` can take 30+ seconds without tripping the
   * 29s API Gateway HTTP API ceiling.
   *
   * Wire flow:
   *   1. POST /agent/start → returns { jobId } in <100 ms.
   *   2. GET /agent/poll?jobId=... every 1500 ms until status =
   *      complete or error (or we exceed `maxPollMs`, which we set
   *      well above the worker Lambda's 5-minute hard ceiling so
   *      the only way to time out here is the worker actually
   *      hanging — at which point a manual reset is the right
   *      escape hatch).
   *   3. Render the resulting AgentResponse the same way the sync
   *      path does (sessionId capture + appendAgentBlocks for
   *      success, danger toast for error).
   *
   * Errors surface via the same `actions.addAlert` channel as the
   * sync path so the user UX is consistent.
   */
  const callAgentAsync = useCallback(
    async (
      message:
        | { type: "text"; text: string }
        | {
            type: "tool_approval_response";
            toolUseId: string;
            decision: "approve" | "reject" | "override";
            message?: string;
          },
      opts: { freshSession?: boolean } = {},
    ): Promise<{ ok: boolean; errorMessage?: string }> => {
      if (!effectiveApiBaseUrl) {
        actions.addAlert({
          type: "danger",
          message:
            "Agent backend not configured. Run agent-infra/deploy.sh and reload.",
        });
        return { ok: false, errorMessage: "Agent backend not configured." };
      }
      if (inFlight) return { ok: false, errorMessage: "Already in flight." };
      setInFlight(true);

      const f = fetchFn ?? realFetch;
      try {
        const startBody: Record<string, unknown> = { dealId, message };
        if (sessionId && !opts.freshSession) startBody.sessionId = sessionId;

        const startResp = await f(`${effectiveApiBaseUrl}/agent/start`, {
          method: "POST",
          body: startBody,
          timeout: 10_000,
        });

        let startPayload: { ok?: boolean; jobId?: string; message?: string };
        try {
          startPayload = (await startResp.json()) as typeof startPayload;
        } catch {
          startPayload = { ok: false, message: "Could not read agent start response." };
        }

        if (!startPayload.ok || !startPayload.jobId) {
          const msg = startPayload.message ?? "Agent did not accept the request.";
          actions.addAlert({ type: "danger", message: msg });
          return { ok: false, errorMessage: msg };
        }
        const jobId = startPayload.jobId;

        // Poll loop. Each iteration sends a fresh GET; the polling is
        // cheap enough that we don't bother with exponential backoff
        // — a steady 1.5 s rhythm matches the chat UX expectation of
        // "the agent is thinking" feedback.
        const POLL_INTERVAL_MS = pollIntervalMs;
        const MAX_POLL_MS = 5 * 60 * 1000;
        const startedAt = Date.now();

        for (;;) {
          if (Date.now() - startedAt > MAX_POLL_MS) {
            const msg =
              "Agent did not finish within 5 minutes. Try again or use a fresh conversation.";
            actions.addAlert({ type: "danger", message: msg });
            return { ok: false, errorMessage: msg };
          }
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

          const pollResp = await f(
            `${effectiveApiBaseUrl}/agent/poll?jobId=${encodeURIComponent(jobId)}`,
            { method: "GET", timeout: 10_000 },
          );
          let pollPayload: {
            ok?: boolean;
            status?: "pending" | "running" | "complete" | "error";
            response?: AgentResponseBody;
            errorMessage?: string;
            message?: string;
          };
          try {
            pollPayload = (await pollResp.json()) as typeof pollPayload;
          } catch {
            // Transient parse failure — keep polling.
            continue;
          }

          if (!pollPayload.ok) {
            const msg = pollPayload.message ?? "Agent poll failed.";
            actions.addAlert({ type: "danger", message: msg });
            return { ok: false, errorMessage: msg };
          }

          const status = pollPayload.status;
          if (status === "pending" || status === "running") {
            continue;
          }

          // Terminal: complete or error.
          const body = pollPayload.response;
          if (body && "ok" in body && body.ok === true) {
            setSessionId(body.sessionId);
            appendAgentBlocks(setTranscript, body.blocks);
            return { ok: true };
          }
          if (body && "ok" in body && body.ok === false) {
            const errBody = body;
            const isRateLimited = errBody.code === "MCP_RATE_LIMITED";
            if (isRateLimited) {
              setCooldownUntil(Date.now() + rateLimitCooldownMs);
            }
            // Stale-session recovery (see callAgent above).
            if (errBody.code === "MCP_NOT_FOUND") {
              setSessionId(undefined);
            }
            actions.addAlert({
              type: "danger",
              message: errBody.message ?? "Agent request failed.",
            });
            return {
              ok: false,
              errorMessage: errBody.message ?? "Agent request failed.",
            };
          }
          // Worker errored without a body.
          const msg =
            pollPayload.errorMessage ?? "Agent worker failed without details.";
          actions.addAlert({ type: "danger", message: msg });
          return { ok: false, errorMessage: msg };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actions.addAlert({
          type: "danger",
          message: `Agent request failed: ${msg}`,
        });
        return { ok: false, errorMessage: msg };
      } finally {
        setInFlight(false);
        // Apply the standard cooldown after every async send too.
        // The async path is now the only path (sync was retired due
        // to MCP session-by-IAM-principal scoping), so cooldown
        // logic has to live here too — not just in the sync helper.
        if (cooldownMs > 0) {
          setCooldownUntil((prev) =>
            Math.max(prev, Date.now() + cooldownMs),
          );
        }
      }
    },
    [
      actions,
      cooldownMs,
      dealId,
      effectiveApiBaseUrl,
      fetchFn,
      inFlight,
      rateLimitCooldownMs,
      realFetch,
      sessionId,
      pollIntervalMs,
    ],
  );

  /**
   * Reset the conversation: drop the server-held MCP session and
   * clear the visible transcript. Used to recover from agent
   * slowness — large session contexts make `sendMessage` take 25-29s
   * to respond, which trips our 29s Lambda timeout. Starting a new
   * session is the cleanest way out (the alternative is waiting
   * 48 hours for the session's natural TTL to expire server-side).
   */
  const onNewConversation = useCallback(() => {
    if (inFlight) return;
    setTranscript([]);
    setSessionId(undefined);
    setOverrideDrafts({});
    setRejectDrafts({});
  }, [inFlight]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (text === "") return;
    if (now < cooldownUntil) return;
    if (inFlight) return;

    setTranscript((prev) => [...prev, { kind: "user", text }]);
    setDraft("");
    // Route through the async path so all calls — chat, approvals,
    // bulk imports — hit MCP from the same IAM principal. The MCP
    // server scopes sessions by SigV4 caller identity; mixing the
    // sync (ace-agent-lambda-execution role) and async
    // (ace-agent-async-lambda-execution role) paths within one
    // session causes "Session not found" errors as the principals
    // don't share session visibility.
    await callAgentAsync({ type: "text", text });
  }, [callAgentAsync, cooldownUntil, draft, inFlight, now]);

  /**
   * Bulk-import bridge. The bulk panel renders the per-batch prompt
   * itself; we only need to push it through the same text-message
   * channel the composer uses, plus echo a short summary into the
   * transcript so the user can see "Sent batch 2 of 4" in-line with
   * the agent's responses (the full prompt body is too long to dump
   * into the transcript readably).
   *
   * The first batch of a bulk run forces a fresh MCP session so the
   * agent's server-held context starts clean — accumulated chat
   * history from before the bulk run was triggered would otherwise
   * compound with the per-row context and push response times past
   * our 29s Lambda timeout. Subsequent batches reuse the new session
   * so the agent retains its memory of which rows it already
   * created.
   *
   * Throws on failure so the panel surfaces the error inline. The
   * underlying `callAgent` already showed a toast; the throw is what
   * stops the panel from advancing to the next batch.
   */
  const sendBulkBatch = useCallback(
    async (
      text: string,
      bulkOpts: { isFirstBatch?: boolean } = {},
    ): Promise<void> => {
      if (inFlight) throw new Error("Another request is in flight.");
      // Show a short receipt rather than the full multi-row prompt.
      const summary = summariseBulkPrompt(text);
      setTranscript((prev) => [...prev, { kind: "user", text: summary }]);
      // Bulk batches go through the async path so the worker can
      // take 30+ s without tripping the API Gateway 30 s ceiling.
      // The card polls until the worker writes the result to DDB.
      const result = await callAgentAsync(
        { type: "text", text },
        { freshSession: bulkOpts.isFirstBatch === true },
      );
      if (!result.ok) {
        throw new Error(result.errorMessage ?? "Agent request failed.");
      }
    },
    [callAgentAsync, inFlight],
  );

  const onApprovalAction = useCallback(
    async (
      entryIndex: number,
      decision: "approve" | "reject" | "override"
    ) => {
      const entry = transcript[entryIndex];
      if (!entry || entry.kind !== "approval_request") return;
      if (entry.acted) return;
      if (inFlight) return;

      let optMessage: string | undefined;
      if (decision === "override") {
        const draftMsg = overrideDrafts[entry.toolUseId]?.trim() ?? "";
        if (draftMsg === "") return;
        optMessage = draftMsg;
      } else if (decision === "reject") {
        const draftMsg = rejectDrafts[entry.toolUseId]?.trim() ?? "";
        if (draftMsg !== "") optMessage = draftMsg;
      }

      // Latch the decision on the entry so the buttons disappear.
      setTranscript((prev) =>
        prev.map((e, i) =>
          i === entryIndex && e.kind === "approval_request"
            ? { ...e, acted: decision }
            : e
        )
      );

      // Approval responses go through the async path because tool
      // approvals (especially CreateOpportunity) can take 25-40 s
      // server-side. Routing them via /agent/start + /agent/poll
      // sidesteps the 30 s API Gateway integration ceiling.
      await callAgentAsync({
        type: "tool_approval_response",
        toolUseId: entry.toolUseId,
        decision,
        ...(optMessage ? { message: optMessage } : {}),
      });
    },
    [callAgentAsync, inFlight, overrideDrafts, rejectDrafts, transcript]
  );

  const cooldownRemaining = Math.max(
    0,
    Math.ceil((cooldownUntil - now) / 1000)
  );
  const sendDisabled =
    inFlight || cooldownRemaining > 0 || draft.trim().length === 0;

  return (
    <Flex direction="column" gap="md">
      <Text format={{ fontWeight: "bold" }}>AWS Partner Central Agent</Text>
      <Text variant="microcopy">
        Ask about this deal — pipeline insights, funding eligibility, next
        steps. Any write the agent proposes will pause for your approval.
      </Text>

      {transcript.length > 0 ? (
        <Flex direction="column" gap="sm">
          {transcript.map((entry, idx) =>
            renderEntry(
              entry,
              idx,
              {
                onApprove: () => onApprovalAction(idx, "approve"),
                onReject: () => onApprovalAction(idx, "reject"),
                onOverride: () => onApprovalAction(idx, "override"),
              },
              {
                overrideDrafts,
                setOverrideDrafts,
                rejectDrafts,
                setRejectDrafts,
              },
              isLikelyDuplicateApproval(transcript, idx),
            )
          )}
          {inFlight ? (
            <LoadingSpinner label="Thinking..." />
          ) : null}
        </Flex>
      ) : (
        <Text variant="microcopy">
          Try: "Summarise this deal", "What's blocking this opportunity?", or
          "Am I eligible for MAP funding for this deal?"
        </Text>
      )}

      <Divider />

      <Flex direction="column" gap="xs">
        <Input
          name="agent-composer"
          label="Message"
          value={draft}
          onChange={(value: string) => setDraft(value)}
          placeholder="Type your question..."
        />
        <Flex direction="row" gap="sm">
          <Button
            variant="primary"
            onClick={onSend}
            disabled={sendDisabled}
          >
            {inFlight
              ? "Sending..."
              : cooldownRemaining > 0
                ? `Wait ${cooldownRemaining}s`
                : "Send"}
          </Button>
          <Button
            onClick={onNewConversation}
            disabled={inFlight || (transcript.length === 0 && !sessionId)}
          >
            New conversation
          </Button>
        </Flex>
      </Flex>

      {cooldownRemaining > 0 && cooldownUntil - Date.now() > cooldownMs ? (
        <Alert title="Rate limited" variant="warning">
          AWS Partner Central rate-limited the request. The composer is
          paused for {cooldownRemaining}s.
        </Alert>
      ) : null}

      <Divider />

      <BulkImportPanel sendBatch={sendBulkBatch} parentInFlight={inFlight} />
    </Flex>
  );
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function renderEntry(
  entry: TranscriptEntry,
  idx: number,
  cb: {
    onApprove: () => void;
    onReject: () => void;
    onOverride: () => void;
  },
  drafts: {
    overrideDrafts: Record<string, string>;
    setOverrideDrafts: (
      updater: (prev: Record<string, string>) => Record<string, string>
    ) => void;
    rejectDrafts: Record<string, string>;
    setRejectDrafts: (
      updater: (prev: Record<string, string>) => Record<string, string>
    ) => void;
  },
  isLikelyDuplicate: boolean,
) {
  if (entry.kind === "user") {
    return (
      <Flex key={idx} direction="column" gap="xs">
        <Text format={{ fontWeight: "bold" }}>You</Text>
        <Text>{entry.text}</Text>
      </Flex>
    );
  }
  if (entry.kind === "agent_text") {
    return (
      <Flex key={idx} direction="column" gap="xs">
        <Text format={{ fontWeight: "bold" }}>Agent</Text>
        {renderMarkdown(entry.text)}
      </Flex>
    );
  }
  // approval_request
  const acted = entry.acted;
  const overrideDraft = drafts.overrideDrafts[entry.toolUseId] ?? "";
  const rejectDraft = drafts.rejectDrafts[entry.toolUseId] ?? "";
  const overrideDisabled = overrideDraft.trim().length === 0;

  return (
    <Alert
      key={idx}
      title={`Action proposed: ${entry.toolName}`}
      variant={isLikelyDuplicate ? "danger" : "warning"}
    >
      <Flex direction="column" gap="xs">
        {isLikelyDuplicate && !acted ? (
          <Text format={{ fontWeight: "bold" }}>
            ⚠ Duplicate of a previously-approved action. Approving again
            may create a duplicate record. Reject this prompt unless you
            intended to retry.
          </Text>
        ) : null}
        <Text format={{ fontWeight: "bold" }}>Parameters</Text>
        <Text>{JSON.stringify(entry.parameters, null, 2)}</Text>
        {acted ? (
          <Text variant="microcopy">
            {acted === "approve"
              ? "Approved."
              : acted === "reject"
                ? "Rejected."
                : "Overridden."}
          </Text>
        ) : (
          <Flex direction="column" gap="xs">
            <Flex direction="row" gap="sm">
              <Button variant="primary" onClick={cb.onApprove}>
                Approve
              </Button>
              <Button onClick={cb.onReject}>Reject</Button>
              <Button
                onClick={cb.onOverride}
                disabled={overrideDisabled}
              >
                Override
              </Button>
            </Flex>
            <Input
              name={`reject-msg-${entry.toolUseId}`}
              label="Reject reason (optional)"
              value={rejectDraft}
              onChange={(value: string) =>
                drafts.setRejectDrafts((prev) => ({
                  ...prev,
                  [entry.toolUseId]: value,
                }))
              }
            />
            <Input
              name={`override-msg-${entry.toolUseId}`}
              label="Override instructions (required for Override)"
              value={overrideDraft}
              onChange={(value: string) =>
                drafts.setOverrideDrafts((prev) => ({
                  ...prev,
                  [entry.toolUseId]: value,
                }))
              }
            />
          </Flex>
        )}
      </Flex>
    </Alert>
  );
}

function appendAgentBlocks(
  setTranscript: (
    updater: (prev: TranscriptEntry[]) => TranscriptEntry[]
  ) => void,
  blocks: AgentBlock[]
): void {
  setTranscript((prev) => {
    const out = [...prev];
    for (const b of blocks) {
      if (b.type === "text") {
        out.push({ kind: "agent_text", text: b.text });
      } else {
        out.push({
          kind: "approval_request",
          toolUseId: b.toolUseId,
          toolName: b.toolName,
          parameters: b.parameters,
        });
      }
    }
    return out;
  });
}

/**
 * Render a one-line summary of a bulk-import prompt for the
 * transcript. The full prompt is many lines of `Row N: ... ` and
 * would clutter the transcript scrollback. The user can always
 * recover the full input from their browser's clipboard / the CSV
 * paste textarea, so the transcript only carries a short receipt.
 */
function summariseBulkPrompt(text: string): string {
  const m = text.match(/batch (\d+) of (\d+)/i);
  const rowMatches = text.match(/^Row \d+:/gm);
  const rowCount = rowMatches ? rowMatches.length : 0;
  if (m) {
    return `Sent ${rowCount} row${rowCount === 1 ? "" : "s"} (batch ${m[1]} of ${m[2]}).`;
  }
  return `Sent ${rowCount} row${rowCount === 1 ? "" : "s"} for bulk import.`;
}

/**
 * Detect whether the approval_request at `idx` is byte-identical to a
 * previously-approved one earlier in the transcript. The agent has a
 * known failure mode where it re-emits the same tool call after a
 * successful approval — the user clicks Approve a second time
 * thinking it's the next row, and AWS creates a duplicate record.
 *
 * The check is conservative: same `toolName` AND same JSON-serialised
 * parameters AND the earlier instance was actually approved (a prior
 * Reject doesn't count as "already done"). If any of those three
 * conditions fail, returns false.
 *
 * Returns false for non-approval entries.
 */
function isLikelyDuplicateApproval(
  transcript: TranscriptEntry[],
  idx: number,
): boolean {
  const entry = transcript[idx];
  if (!entry || entry.kind !== "approval_request") return false;
  if (entry.acted) return false;

  const params = JSON.stringify(entry.parameters);
  for (let i = 0; i < idx; i += 1) {
    const prior = transcript[i];
    if (
      prior.kind === "approval_request" &&
      prior.acted === "approve" &&
      prior.toolName === entry.toolName &&
      JSON.stringify(prior.parameters) === params
    ) {
      return true;
    }
  }
  return false;
}

// HubSpot UI Extension entrypoint. Tests render `<AgentCard>` directly.
type ExtensionContext = {
  crm: { objectId: number };
};
hubspot.extend<"crm.record.tab">(({ actions, context }) => {
  const ctx = context as unknown as ExtensionContext;
  return (
    <AgentCard
      dealId={ctx.crm.objectId}
      actions={actions as unknown as CardActions}
    />
  );
});
