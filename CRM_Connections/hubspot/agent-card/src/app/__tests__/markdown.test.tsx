/**
 * Tests for the markdown renderer used inside the agent card transcript.
 *
 * Two layers of coverage:
 *
 *   1. `parseBlocks` — pure function on input string → block array.
 *      Easier to assert structurally than poking through the DOM.
 *   2. `renderMarkdown` rendered output via React Testing Library, to
 *      confirm the agent's actual production output (a multi-block
 *      response with a heading, list, and table) survives the round trip.
 */

import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@hubspot/ui-extensions", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactLib = require("react") as typeof import("react");

  const passthrough = (tag: string) =>
    ReactLib.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
      const { children, format, variant, inline, direction, gap, ...rest } =
        props as Record<string, unknown>;
      void format;
      void direction;
      void gap;
      void rest;
      return ReactLib.createElement(
        tag,
        {
          ref,
          "data-variant": variant,
          "data-inline": inline ? "true" : undefined,
        },
        children as React.ReactNode
      );
    });

  return {
    Flex: passthrough("div"),
    Text: passthrough("span"),
    Heading: passthrough("h1"),
    Divider: () => ReactLib.createElement("hr", null),
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
  };
});

import { renderMarkdown, __test_only__ } from "../cards/markdown";

const { parseBlocks } = __test_only__;

// ---- parser unit tests ----

describe("parseBlocks", () => {
  test("plain paragraph", () => {
    expect(parseBlocks("hello world")).toEqual([
      { kind: "paragraph", lines: ["hello world"] },
    ]);
  });

  test("h1 / h2 / h3", () => {
    expect(parseBlocks("# Title")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
    ]);
    expect(parseBlocks("## Sub")).toEqual([
      { kind: "heading", level: 2, text: "Sub" },
    ]);
    expect(parseBlocks("### Detail")).toEqual([
      { kind: "heading", level: 3, text: "Detail" },
    ]);
  });

  test("unordered list with multiple items", () => {
    const blocks = parseBlocks("- one\n- two\n- three");
    expect(blocks).toEqual([
      { kind: "ul", items: ["one", "two", "three"] },
    ]);
  });

  test("ordered list", () => {
    const blocks = parseBlocks("1. first\n2. second");
    expect(blocks).toEqual([
      { kind: "ol", items: ["first", "second"] },
    ]);
  });

  test("horizontal rule", () => {
    expect(parseBlocks("---")).toEqual([{ kind: "rule" }]);
    expect(parseBlocks("***")).toEqual([{ kind: "rule" }]);
  });

  test("table with header + 2 rows", () => {
    const md = "| Name | Age |\n|------|-----|\n| Ana  | 30  |\n| Bo   | 25  |";
    expect(parseBlocks(md)).toEqual([
      {
        kind: "table",
        headers: ["Name", "Age"],
        rows: [
          ["Ana", "30"],
          ["Bo", "25"],
        ],
      },
    ]);
  });

  test("blank lines between blocks are skipped", () => {
    const blocks = parseBlocks("para 1\n\npara 2");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "paragraph", lines: ["para 1"] });
    expect(blocks[1]).toEqual({ kind: "paragraph", lines: ["para 2"] });
  });

  test("paragraph terminates at heading", () => {
    const blocks = parseBlocks("intro line\n## Heading\nmore text");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: "paragraph", lines: ["intro line"] });
    expect(blocks[1]).toEqual({ kind: "heading", level: 2, text: "Heading" });
    expect(blocks[2]).toEqual({ kind: "paragraph", lines: ["more text"] });
  });

  test("paragraph terminates at list", () => {
    const blocks = parseBlocks("description\n- item 1\n- item 2");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "paragraph", lines: ["description"] });
    expect(blocks[1]).toEqual({ kind: "ul", items: ["item 1", "item 2"] });
  });

  test("table line not followed by separator stays a paragraph", () => {
    const blocks = parseBlocks("| not | a | table | line");
    expect(blocks[0]?.kind).toBe("paragraph");
  });
});

// ---- render integration ----

describe("renderMarkdown", () => {
  test("renders an agent-style summary with heading, list, and table", () => {
    const md = `## Deal Summary: Test from Hubspot 6

**Basic Information:**

- **HubSpot Deal ID:** 502451771590
- **Deal Name:** Test from Hubspot 6
- **ACE Opportunity ID:** O13589660

---

| Opp ID | Stage | Amount |
|--------|-------|--------|
| O13589660 | Approved | $2,004 |
`;
    render(<>{renderMarkdown(md)}</>);

    // Heading text
    expect(
      screen.getByText(/Deal Summary: Test from Hubspot 6/)
    ).toBeInTheDocument();
    // Bold-inline label (split across nested <span>s, so query loosely)
    expect(screen.getByText(/HubSpot Deal ID/)).toBeInTheDocument();
    expect(screen.getByText("502451771590")).toBeInTheDocument();
    // List items become <li>
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    // Horizontal rule -> <hr>
    expect(document.querySelector("hr")).not.toBeNull();
    // Table headers + cells (the value also appears in the list above)
    expect(screen.getByText("Opp ID")).toBeInTheDocument();
    expect(screen.getAllByText("O13589660").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("$2,004")).toBeInTheDocument();
  });

  test("inline bold and italic render with format-bold / italic spans", () => {
    render(
      <>{renderMarkdown("This is **bold** and *italic*.")}</>
    );
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("italic")).toBeInTheDocument();
  });

  test("plain markdown without recognised constructs renders as paragraph text", () => {
    render(<>{renderMarkdown("just plain text here")}</>);
    expect(screen.getByText("just plain text here")).toBeInTheDocument();
  });
});
