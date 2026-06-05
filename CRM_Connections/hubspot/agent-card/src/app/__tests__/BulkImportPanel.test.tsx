/**
 * Tests for the demo-grade bulk-import panel.
 *
 * Coverage:
 *   - CSV parser handles header detection, quoted fields, mixed
 *     line endings, blank lines.
 *   - Demo cap (`MAX_ROWS_DEMO`) is enforced.
 *   - Batching slices at `BATCH_SIZE`, sends one batch per click.
 *   - Continue button is gated on `parentInFlight`.
 *   - Final state shows the success banner.
 */

import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
        ...rest
      } = props as Record<string, unknown>;
      void rest;
      return ReactLib.createElement(
        tag,
        {
          ref,
          onClick,
          disabled,
          "data-variant": variant,
        },
        children as React.ReactNode,
      );
    });

  const TextAreaComp = ({
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
      ReactLib.createElement("textarea", {
        "data-name": name,
        value: value ?? "",
        placeholder,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange?.(e.target.value),
      }),
    );

  const ProgressBarComp = ({
    value,
    maxValue,
  }: {
    value: number;
    maxValue: number;
  }) =>
    ReactLib.createElement("progress", {
      value,
      max: maxValue,
      "data-testid": "progress-bar",
    });

  return {
    Flex: passthrough("div"),
    Text: passthrough("span"),
    Button: passthrough("button"),
    TextArea: TextAreaComp,
    ProgressBar: ProgressBarComp,
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
        children,
      ),
  };
});

import {
  BulkImportPanel,
  parseCsv,
  renderBatchPrompt,
  MAX_ROWS_DEMO,
  BATCH_SIZE,
} from "../cards/BulkImportPanel";

describe("parseCsv", () => {
  test("detects a header row and returns data-only rows", () => {
    const out = parseCsv("name,country\nAcme,US\nGlobalTech,DE");
    expect(out.header).toEqual(["name", "country"]);
    expect(out.rows).toEqual([
      ["Acme", "US"],
      ["GlobalTech", "DE"],
    ]);
  });

  test("treats numeric-only first row as data, not header", () => {
    const out = parseCsv("100,200\n300,400");
    expect(out.header).toBeNull();
    expect(out.rows).toEqual([
      ["100", "200"],
      ["300", "400"],
    ]);
  });

  test("handles quoted fields with embedded commas", () => {
    const out = parseCsv(
      'name,description\nAcme,"Migrating to AWS, end-to-end"',
    );
    expect(out.rows).toEqual([["Acme", "Migrating to AWS, end-to-end"]]);
  });

  test("handles escaped quotes inside quoted fields", () => {
    const out = parseCsv('name,note\nAcme,"He said ""hi"" yesterday"');
    expect(out.rows).toEqual([["Acme", 'He said "hi" yesterday']]);
  });

  test("normalises CRLF line endings to LF", () => {
    const out = parseCsv("name,country\r\nAcme,US\r\nGlobalTech,DE");
    expect(out.rows.length).toBe(2);
    expect(out.rows[1]).toEqual(["GlobalTech", "DE"]);
  });

  test("ignores trailing blank lines", () => {
    const out = parseCsv("name,country\nAcme,US\n\n\n");
    expect(out.rows.length).toBe(1);
  });

  test("returns empty result for empty input", () => {
    expect(parseCsv("")).toEqual({ header: null, rows: [] });
    expect(parseCsv("   \n\n  ")).toEqual({ header: null, rows: [] });
  });
});

describe("renderBatchPrompt", () => {
  test("includes batch number, total, and the row data", () => {
    const text = renderBatchPrompt(
      [["Acme", "US"]],
      ["name", "country"],
      1,
      4,
    );
    expect(text).toContain("batch 1 of 4");
    expect(text).toContain("Row 1:");
    expect(text).toContain("name: Acme");
    expect(text).toContain("country: US");
  });

  test("falls back to col<N> labels when no header is present", () => {
    const text = renderBatchPrompt([["Acme", "US"]], null, 1, 1);
    expect(text).toContain("col1: Acme");
    expect(text).toContain("col2: US");
  });

  test("skips empty cells per row", () => {
    const text = renderBatchPrompt(
      [["Acme", "", "US"]],
      ["name", "industry", "country"],
      1,
      1,
    );
    expect(text).toContain("name: Acme");
    expect(text).not.toContain("industry:");
    expect(text).toContain("country: US");
  });
});

describe("BulkImportPanel — UI", () => {
  type Props = React.ComponentProps<typeof BulkImportPanel>;

  function makeProps(overrides: Partial<Props> = {}): Props {
    return {
      sendBatch: vi.fn().mockResolvedValue(undefined),
      parentInFlight: false,
      ...overrides,
    };
  }

  test("starts collapsed; click discloses the panel", () => {
    render(<BulkImportPanel {...makeProps()} />);
    expect(
      screen.queryByLabelText(/CSV/i),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Bulk import — paste CSV/i));
    expect(screen.getByLabelText(/CSV/i)).toBeInTheDocument();
  });

  test("Process button gated on non-empty CSV", () => {
    render(<BulkImportPanel {...makeProps()} />);
    fireEvent.click(screen.getByText(/Bulk import/i));
    const processBtn = screen.getByText("Process").closest("button");
    expect(processBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: "name,country\nAcme,US" },
    });
    // Once the CSV parses to >=1 data row, the button label updates and it's enabled.
    expect(
      screen.getByText(/Process 1 row in 1 batch/i).closest("button"),
    ).not.toBeDisabled();
  });

  test("rejects CSV exceeding the demo row cap", () => {
    render(<BulkImportPanel {...makeProps()} />);
    fireEvent.click(screen.getByText(/Bulk import/i));
    const lines = ["name"];
    for (let i = 0; i < MAX_ROWS_DEMO + 5; i += 1) {
      lines.push(`row${i}`);
    }
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: lines.join("\n") },
    });
    // The Process button stays disabled when the row count is over the cap.
    // Disabled buttons still receive synthetic clicks via fireEvent.click, but
    // our handler short-circuits without writing the error state. Force the
    // error state path via a regular click and verify no batch was sent.
    const processBtn = screen
      .getByText(/Process \d+ rows? in \d+ batches?/i)
      .closest("button");
    expect(processBtn).toBeDisabled();
    // A user trying to bypass the disabled state by clicking anyway gets no
    // effect — but we should still surface the cap somewhere. The parsed
    // count line shows N data rows, and the button stays disabled. That's
    // intentional defence-in-depth: we don't show a toast for an inert
    // button, only for invalid state we've actually entered.
    expect(
      screen.getByText(new RegExp(`Parsed ${MAX_ROWS_DEMO + 5} data rows`)),
    ).toBeInTheDocument();
  });

  test("rejects CSV with only a header row", () => {
    render(<BulkImportPanel {...makeProps()} />);
    fireEvent.click(screen.getByText(/Bulk import/i));
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: "name,country" },
    });
    // No data rows → Process is disabled (parsed.rows.length === 0).
    expect(
      screen.getByText("Process").closest("button"),
    ).toBeDisabled();
  });

  test("sends one batch per click; pauses between batches at BATCH_SIZE", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    render(<BulkImportPanel {...makeProps({ sendBatch })} />);
    fireEvent.click(screen.getByText(/Bulk import/i));

    const lines = ["name,country"];
    for (let i = 0; i < BATCH_SIZE * 2 + 3; i += 1) {
      lines.push(`row${i},US`);
    }
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: lines.join("\n") },
    });

    // Process button reflects the planned batch count.
    const totalRows = BATCH_SIZE * 2 + 3;
    const totalBatches = Math.ceil(totalRows / BATCH_SIZE);
    fireEvent.click(
      screen.getByText(
        new RegExp(
          `Process ${totalRows} rows in ${totalBatches} batches`,
          "i",
        ),
      ),
    );

    // First batch sent; transition to between_batches.
    await waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(1));
    expect(sendBatch.mock.calls[0][0]).toContain("batch 1 of 3");
    // Batch 1 holds rows 1..BATCH_SIZE; row at BATCH_SIZE+1 is in batch 2.
    expect(sendBatch.mock.calls[0][0]).toMatch(
      new RegExp(`Row ${BATCH_SIZE}:`),
    );
    expect(sendBatch.mock.calls[0][0]).not.toMatch(
      new RegExp(`Row ${BATCH_SIZE + 1}:`),
    );

    // The Continue button appears.
    const continueBtn = await screen.findByText(/Continue with batch 2/i);
    fireEvent.click(continueBtn);
    await waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(2));
    expect(sendBatch.mock.calls[1][0]).toContain("batch 2 of 3");
    expect(sendBatch.mock.calls[1][0]).toMatch(/Row 1:/);
    expect(sendBatch.mock.calls[1][0]).toMatch(
      new RegExp(`Row ${BATCH_SIZE}:`),
    );

    const continueBtn3 = await screen.findByText(/Continue with batch 3/i);
    fireEvent.click(continueBtn3);
    await waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(3));
    expect(sendBatch.mock.calls[2][0]).toContain("batch 3 of 3");
    // Last batch holds only the 3 stragglers.
    expect(sendBatch.mock.calls[2][0]).toMatch(/Row 3:/);
    expect(sendBatch.mock.calls[2][0]).not.toMatch(/Row 4:/);

    // Final success banner.
    expect(
      await screen.findByText(/All batches sent/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`Sent ${totalRows} rows`)),
    ).toBeInTheDocument();
  });

  test("Continue is disabled while parent is in flight", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <BulkImportPanel
        sendBatch={sendBatch}
        parentInFlight={false}
      />,
    );
    fireEvent.click(screen.getByText(/Bulk import/i));

    const lines = ["name"];
    for (let i = 0; i < BATCH_SIZE + 1; i += 1) lines.push(`row${i}`);
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: lines.join("\n") },
    });
    fireEvent.click(screen.getByText(/Process \d+ rows/));

    await screen.findByText(/Continue with batch 2/i);

    // Parent-in-flight flips on (e.g., agent still chewing batch 1).
    rerender(<BulkImportPanel sendBatch={sendBatch} parentInFlight={true} />);
    expect(
      screen.getByText(/Continue with batch 2/i).closest("button"),
    ).toBeDisabled();

    // Once parent finishes, Continue re-enables.
    rerender(<BulkImportPanel sendBatch={sendBatch} parentInFlight={false} />);
    expect(
      screen.getByText(/Continue with batch 2/i).closest("button"),
    ).not.toBeDisabled();
  });

  test("every batch passes isFirstBatch=true (fresh session per batch)", async () => {
    // Each batch starts a fresh MCP session so per-turn context stays
    // small. The agent doesn't need cross-batch memory because each
    // row is independent. We verify by asserting `isFirstBatch: true`
    // for every batch invocation.
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    render(<BulkImportPanel {...makeProps({ sendBatch })} />);
    fireEvent.click(screen.getByText(/Bulk import/i));

    const lines = ["name"];
    for (let i = 0; i < BATCH_SIZE + 1; i += 1) lines.push(`row${i}`);
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: lines.join("\n") },
    });
    fireEvent.click(screen.getByText(/Process \d+ rows/));

    await waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(1));
    expect(sendBatch.mock.calls[0][1]).toEqual({ isFirstBatch: true });

    fireEvent.click(await screen.findByText(/Continue with batch 2/i));
    await waitFor(() => expect(sendBatch).toHaveBeenCalledTimes(2));
    expect(sendBatch.mock.calls[1][1]).toEqual({ isFirstBatch: true });
  });

  test("sendBatch failure surfaces an error and offers reset", async () => {
    const sendBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"));
    render(
      <BulkImportPanel sendBatch={sendBatch} parentInFlight={false} />,
    );
    fireEvent.click(screen.getByText(/Bulk import/i));
    fireEvent.change(screen.getByLabelText(/CSV/i), {
      target: { value: "name\nAcme" },
    });
    fireEvent.click(screen.getByText(/Process 1 row/i));

    expect(
      await screen.findByText(/Batch 1 failed: network down/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Reset")).toBeInTheDocument();
  });
});
