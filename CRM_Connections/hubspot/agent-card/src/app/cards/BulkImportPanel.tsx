/**
 * `BulkImportPanel` — demo-grade bulk CSV → agent batched create flow.
 *
 * What it does
 * ============
 * The Partner Central Agent's `CreateOpportunity` tool is interactive
 * and human-in-the-loop: every write returns a `requires_approval`
 * block that the user must Approve / Reject / Override. The agent
 * itself caps the number of writes it'll propose in a single turn
 * around 10. Pasting a 40-row CSV in the regular composer therefore
 * gets you the first 10 rows and an agent that politely stops.
 *
 * This panel works around that by paginating client-side: parse the
 * pasted CSV in the browser, slice it into chunks of `BATCH_SIZE`,
 * and feed each chunk into the existing `callAgent` text channel as
 * a separate turn. Within a batch, the user still sees the agent's
 * normal HITL approval prompts; between batches, this panel shows a
 * "Continue with next batch" button so the user is always in control.
 *
 * Scope (intentional)
 * ===================
 * - **Demo / prototype only**. Caps total rows at `MAX_ROWS_DEMO`. A
 *   refresh of the deal record drops in-flight progress on the
 *   floor — there is no DynamoDB job table or resume logic.
 * - **No HubSpot deal writeback**. This panel only creates AWS
 *   opportunities through the agent. It does NOT create matching
 *   HubSpot deals. Use the per-deal Share button for that flow.
 * - **No file picker**. UI Extensions sandboxes the DOM, so the
 *   simplest path is paste-CSV-as-text. Partners drag a CSV out of
 *   Excel / a text editor and paste.
 *
 * When this stops being good enough
 * ==================================
 * Build a proper bulk-import Lambda backed by DynamoDB job state:
 * one row per opportunity, parallel CreateOpportunity calls without
 * the agent's HITL loop, durable progress, browser-survives-close
 * resume, and matching HubSpot deal creation. Roughly a week of
 * work — the agent flow is fine until the demo audience asks for
 * "what about 200 rows?"
 *
 * UX shape
 * ========
 * 1. User clicks the "Bulk import" disclosure.
 * 2. Pastes CSV. Panel previews row count + first row's first column
 *    as a sanity check.
 * 3. Clicks "Process N rows in batches of 10". Panel sends batch 1.
 * 4. Agent returns approval requests inline in the parent
 *    transcript. User approves / rejects each one.
 * 5. Once batch 1's approvals are settled (the parent's `inFlight`
 *    drops to false), the panel re-enables "Continue with batch 2".
 * 6. Repeats until all batches sent. Final status banner shows.
 *
 * The parent's transcript is the authoritative log — this panel
 * doesn't duplicate the conversation, it just pages the input.
 */

import { useCallback, useMemo, useState } from "react";
import {
  Flex,
  Text,
  Button,
  Alert,
  ProgressBar,
  TextArea,
} from "@hubspot/ui-extensions";

/** Hard cap on the total CSV size for the demo path. */
export const MAX_ROWS_DEMO = 30;

/** How many rows go into a single agent turn. */
export const BATCH_SIZE = 5;

/** Discriminated union of panel states. */
type PanelState =
  | { kind: "idle" }
  | {
      kind: "sending";
      rows: string[][];
      header: string[] | null;
      currentBatch: number;
      totalBatches: number;
    }
  | {
      kind: "between_batches";
      rows: string[][];
      header: string[] | null;
      nextBatch: number;
      totalBatches: number;
    }
  | { kind: "done"; rowsProcessed: number; totalBatches: number }
  | { kind: "error"; message: string };

export type BulkImportPanelProps = {
  /**
   * Bound `callAgent({type:"text", text})` from the parent. The parent
   * owns session state, cooldown, and the transcript — we just push
   * text turns through this channel. Pass `{ isFirstBatch: true }`
   * for the first batch of a bulk run so the parent forces a fresh
   * MCP session (avoids context bloat from prior chat turns).
   */
  sendBatch: (
    text: string,
    opts?: { isFirstBatch?: boolean },
  ) => Promise<void>;
  /**
   * Whether the parent is mid-request. The panel disables Continue
   * while this is true so we don't pile up pending requests.
   */
  parentInFlight: boolean;
};

export const BulkImportPanel = ({
  sendBatch,
  parentInFlight,
}: BulkImportPanelProps) => {
  const [open, setOpen] = useState<boolean>(false);
  const [csv, setCsv] = useState<string>("");
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  const parsed = useMemo(() => {
    if (csv.trim().length === 0) return null;
    return parseCsv(csv);
  }, [csv]);

  const sendNextBatch = useCallback(
    async (batchIdx: number, rows: string[][], header: string[] | null) => {
      const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
      const start = batchIdx * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, rows.length);
      const slice = rows.slice(start, end);

      setState({
        kind: "sending",
        rows,
        header,
        currentBatch: batchIdx + 1,
        totalBatches,
      });

      const text = renderBatchPrompt(
        slice,
        header,
        batchIdx + 1,
        totalBatches,
      );

      try {
        // Every batch starts a fresh MCP session. The agent doesn't
        // need cross-batch memory (each row is independent), and the
        // server-held context that accumulates within a session is
        // what drives MCP `sendMessage` response time toward our 29s
        // Lambda timeout. Resetting per batch caps per-turn latency.
        await sendBatch(text, { isFirstBatch: true });
      } catch (err) {
        setState({
          kind: "error",
          message: `Batch ${batchIdx + 1} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        return;
      }

      const isLast = batchIdx + 1 >= totalBatches;
      if (isLast) {
        setState({
          kind: "done",
          rowsProcessed: rows.length,
          totalBatches,
        });
      } else {
        setState({
          kind: "between_batches",
          rows,
          header,
          nextBatch: batchIdx + 1,
          totalBatches,
        });
      }
    },
    [sendBatch],
  );

  /**
   * Validate the parsed CSV against the demo limits. Returns null on
   * success, or an error message describing why the input can't be
   * processed. Called inline by `onStart` so the user gets a single
   * "Process" click that does the full validate-and-send dance.
   */
  const validate = useCallback((): string | null => {
    if (!parsed) return "Paste CSV content first.";
    if (parsed.rows.length === 0) {
      return "No data rows found. Did you paste only a header?";
    }
    if (parsed.rows.length > MAX_ROWS_DEMO) {
      return `Limit is ${MAX_ROWS_DEMO} rows; you pasted ${parsed.rows.length}. Trim and try again.`;
    }
    return null;
  }, [parsed]);

  const onStart = useCallback(() => {
    const err = validate();
    if (err) {
      setState({ kind: "error", message: err });
      return;
    }
    if (!parsed) return;
    void sendNextBatch(0, parsed.rows, parsed.header);
  }, [parsed, sendNextBatch, validate]);

  const onContinue = useCallback(() => {
    if (state.kind !== "between_batches") return;
    void sendNextBatch(state.nextBatch, state.rows, state.header);
  }, [sendNextBatch, state]);

  const onReset = useCallback(() => {
    setCsv("");
    setState({ kind: "idle" });
  }, []);

  if (!open) {
    return (
      <Flex direction="column" gap="xs">
        <Button onClick={() => setOpen(true)}>
          Bulk import — paste CSV
        </Button>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="sm">
      <Flex direction="row" gap="sm">
        <Text format={{ fontWeight: "bold" }}>Bulk import</Text>
        <Button onClick={() => setOpen(false)}>Hide</Button>
      </Flex>
      <Text variant="microcopy">
        Paste up to {MAX_ROWS_DEMO} CSV rows. The agent processes them in
        batches of {BATCH_SIZE}, pausing for your approval between
        batches. Closing the deal record drops in-flight progress.
      </Text>

      <TextArea
        name="bulk-import-csv"
        label="CSV"
        value={csv}
        onChange={(value: string) => setCsv(value)}
        placeholder="customerName,country,projectTitle,amount,closeDate,description&#10;Acme,US,Cloud Migration,50000,2026-09-30,Migrating Acme's stack to AWS"
      />

      {parsed ? (
        <Text variant="microcopy">
          Parsed {parsed.rows.length} data row
          {parsed.rows.length === 1 ? "" : "s"}
          {parsed.header
            ? ` with header (${parsed.header.length} columns)`
            : " (no header detected)"}
          .
        </Text>
      ) : null}

      {state.kind === "idle" ? (
        <Flex direction="row" gap="sm">
          <Button
            variant="primary"
            onClick={onStart}
            disabled={
              !parsed ||
              parsed.rows.length === 0 ||
              parsed.rows.length > MAX_ROWS_DEMO ||
              parentInFlight
            }
          >
            {parsed && parsed.rows.length > 0
              ? `Process ${parsed.rows.length} row${
                  parsed.rows.length === 1 ? "" : "s"
                } in ${Math.ceil(parsed.rows.length / BATCH_SIZE)} batch${
                  Math.ceil(parsed.rows.length / BATCH_SIZE) === 1 ? "" : "es"
                }`
              : "Process"}
          </Button>
        </Flex>
      ) : null}

      {state.kind === "sending" ? (
        <Flex direction="column" gap="xs">
          <Text variant="microcopy">
            Sending batch {state.currentBatch} of {state.totalBatches}...
          </Text>
          <ProgressBar
            value={state.currentBatch}
            maxValue={state.totalBatches}
          />
        </Flex>
      ) : null}

      {state.kind === "between_batches" ? (
        <Flex direction="column" gap="xs">
          <Text variant="microcopy">
            Batch {state.nextBatch} of {state.totalBatches} sent. Approve /
            reject each create above, then continue.
          </Text>
          <ProgressBar
            value={state.nextBatch}
            maxValue={state.totalBatches}
          />
          <Flex direction="row" gap="sm">
            <Button
              variant="primary"
              onClick={onContinue}
              disabled={parentInFlight}
            >
              Continue with batch {state.nextBatch + 1}
            </Button>
            <Button onClick={onReset}>Cancel</Button>
          </Flex>
        </Flex>
      ) : null}

      {state.kind === "done" ? (
        <Alert title="All batches sent" variant="success">
          <Text>
            Sent {state.rowsProcessed} row
            {state.rowsProcessed === 1 ? "" : "s"} across {state.totalBatches}{" "}
            batch{state.totalBatches === 1 ? "" : "es"}. The agent's
            approval prompts above are the authoritative record of what
            actually got created in AWS.
          </Text>
          <Flex direction="row" gap="sm">
            <Button onClick={onReset}>Start over</Button>
          </Flex>
        </Alert>
      ) : null}

      {state.kind === "error" ? (
        <Alert title="Bulk import error" variant="danger">
          <Text>{state.message}</Text>
          <Button onClick={onReset}>Reset</Button>
        </Alert>
      ) : null}
    </Flex>
  );
};

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Lightweight CSV parser. Handles:
 *   - quoted fields with embedded commas
 *   - quoted fields with embedded `""` to mean a literal `"`
 *   - both `\n` and `\r\n` line endings
 *   - trailing blank lines
 *
 * Does NOT handle: multi-line quoted fields with embedded newlines.
 * Demo input is rows out of Excel / a sales spreadsheet — those are
 * always single-line per row in practice.
 *
 * Header detection: the first row is treated as a header iff every
 * cell is non-numeric (no all-digit / decimal-only values). This
 * matches the AWS bulk-import template's first row of column titles.
 * If header detection fails, the whole CSV is treated as data rows.
 */
export function parseCsv(input: string): {
  header: string[] | null;
  rows: string[][];
} {
  const lines = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { header: null, rows: [] };

  const allParsed = lines.map((l) => parseCsvLine(l));

  const firstRow = allParsed[0];
  const isHeader = firstRow.every((cell) => isHeaderCell(cell));

  if (isHeader) {
    return { header: firstRow, rows: allParsed.slice(1) };
  }
  return { header: null, rows: allParsed };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = "";
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  out.push(cur.trim());
  return out;
}

function isHeaderCell(cell: string): boolean {
  if (cell === "") return false;
  // A purely-numeric cell looks like data, not a header.
  if (/^-?\d+(\.\d+)?$/.test(cell)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render a batch of rows as a text prompt the agent will understand.
 * The format is verbose on purpose — making the relationship between
 * column header and value explicit reduces the chance of the agent
 * mis-mapping fields. We also tell the agent up-front how many
 * batches there will be so it can keep approval prompts terse.
 */
export function renderBatchPrompt(
  rows: string[][],
  header: string[] | null,
  batchNum: number,
  totalBatches: number,
): string {
  const lines: string[] = [];
  lines.push(
    `Bulk-create opportunities — batch ${batchNum} of ${totalBatches}.`,
  );
  lines.push("");
  lines.push(
    "Create one Partner Central opportunity per row below. Pause for my " +
      "approval on each create before moving to the next row.",
  );
  lines.push("");
  rows.forEach((row, idx) => {
    lines.push(`Row ${idx + 1}:`);
    if (header && header.length > 0) {
      header.forEach((h, colIdx) => {
        const v = row[colIdx] ?? "";
        if (v.length > 0) lines.push(`  - ${h}: ${v}`);
      });
    } else {
      row.forEach((v, colIdx) => {
        if (v.length > 0) lines.push(`  - col${colIdx + 1}: ${v}`);
      });
    }
    lines.push("");
  });
  return lines.join("\n");
}
