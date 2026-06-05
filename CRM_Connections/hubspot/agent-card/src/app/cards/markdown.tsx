/**
 * Lightweight markdown-to-HubSpot-component renderer for the Agent
 * card transcript.
 *
 * The Partner Central Agent emits responses in markdown — headings
 * (`##`), bold (`**text**`), bullet lists (`- ...`), numbered lists
 * (`1. ...`), GFM-style tables (`| a | b |\n|---|---|\n| 1 | 2 |`),
 * horizontal rules (`---`), and inline code (`` ` ``). Rendering that
 * with `<Text>{rawString}</Text>` gives us the literal markdown back,
 * which is what the user reported looked bad.
 *
 * This renderer is purpose-built for the agent's actual output:
 *   - It doesn't aim to be a full CommonMark / GFM implementation.
 *   - It handles only the constructs the agent demonstrably emits.
 *   - It outputs HubSpot UI-extension components, not HTML.
 *
 * If the agent ever emits a construct we don't recognise (links,
 * blockquotes, code fences), the line falls through to a plain
 * `<Text>` so the user still sees the content — they just see the
 * raw markdown for that line.
 *
 * Exported as a pure function so it's testable in isolation. The
 * card calls `renderMarkdown(text)` once per `agent_text` block.
 */

import {
  Divider,
  Flex,
  Heading,
  List,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from "@hubspot/ui-extensions";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Inline formatting (bold, italic, inline code) — converts a markdown
// fragment into a flat array of React nodes.
//
// We accept three styles only: **bold**, *italic*, and `code`. Everything
// else is treated as plain text so weirdly-balanced markup still renders
// readable copy.
// ---------------------------------------------------------------------------

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

/**
 * Split a single line into formatted spans. Each span becomes either
 * a plain string or a `<Text>` with `format` props.
 */
export function renderInline(line: string): ReactNode[] {
  const parts = line.split(INLINE_RE).filter((p) => p !== "");
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={i} format={{ fontWeight: "bold" }} inline>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <Text key={i} format={{ italic: true }} inline>
          {part.slice(1, -1)}
        </Text>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <Text key={i} format={{ fontWeight: "bold" }} inline>
          {part.slice(1, -1)}
        </Text>
      );
    }
    return part;
  });
}

// ---------------------------------------------------------------------------
// Block-level parsing.
// ---------------------------------------------------------------------------

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "rule" }
  | { kind: "blank" };

const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const UL_RE = /^[-*+]\s+(.+)$/;
const OL_RE = /^\d+\.\s+(.+)$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/**
 * Parse a markdown document into a sequence of blocks. Single-pass,
 * line-based, intentionally narrow.
 */
function parseBlocks(input: string): Block[] {
  const lines = input.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const line = raw.trim();

    if (line === "") {
      i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const hashes = heading[1] ?? "";
      const level = Math.min(3, hashes.length) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2] ?? "" });
      i++;
      continue;
    }

    // Table: a row of pipes followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length) {
      const sep = (lines[i + 1] ?? "").trim();
      if (TABLE_SEP_RE.test(sep)) {
        const headers = splitTableRow(line);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length) {
          const next = (lines[i] ?? "").trim();
          if (next === "" || !next.includes("|")) break;
          rows.push(splitTableRow(next));
          i++;
        }
        blocks.push({ kind: "table", headers, rows });
        continue;
      }
    }

    if (UL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        const m = UL_RE.exec(t);
        if (!m) break;
        items.push(m[1] ?? "");
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        const m = OL_RE.exec(t);
        if (!m) break;
        items.push(m[1] ?? "");
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph — accumulate until blank line or block-level construct.
    const paragraphLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const t = (lines[i] ?? "").trim();
      if (
        t === "" ||
        HEADING_RE.test(t) ||
        UL_RE.test(t) ||
        OL_RE.test(t) ||
        RULE_RE.test(t) ||
        (t.includes("|") && TABLE_SEP_RE.test((lines[i + 1] ?? "").trim()))
      ) {
        break;
      }
      paragraphLines.push(t);
      i++;
    }
    blocks.push({ kind: "paragraph", lines: paragraphLines });
  }
  return blocks;
}

/** Split a `| a | b | c |` row into `["a", "b", "c"]`. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// ---------------------------------------------------------------------------
// Render — Block[] → ReactNode
// ---------------------------------------------------------------------------

/**
 * Render markdown text as a column of HubSpot UI-extension components.
 * Intended to be called once per agent text block. Returns a single
 * `<Flex>` so the card's transcript can position it as one entry.
 */
export function renderMarkdown(text: string): ReactNode {
  const blocks = parseBlocks(text);
  return (
    <Flex direction="column" gap="xs">
      {blocks.map((b, i) => renderBlock(b, i))}
    </Flex>
  );
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      // HubSpot's `Heading` doesn't expose a level prop in 2025.2, so
      // we approximate H1/H2/H3 by toggling weight + size on `Text`.
      // Largest = bold + medium size; smallest = bold only.
      if (b.level === 1) {
        return (
          <Heading key={key}>
            {renderInline(b.text)}
          </Heading>
        );
      }
      return (
        <Text
          key={key}
          format={{ fontWeight: "bold" }}
          variant={b.level === 2 ? undefined : "microcopy"}
        >
          {renderInline(b.text)}
        </Text>
      );
    }

    case "paragraph":
      // Each line in a paragraph gets its own <Text> so newlines are
      // preserved. Markdown paragraphs that wrap across lines
      // collapse into space-joined sentences in CommonMark, but the
      // agent uses linebreaks meaningfully (e.g. "**Label:** value\n
      // **Label:** value"), so we keep them.
      return (
        <Flex key={key} direction="column" gap="xs">
          {b.lines.map((l, j) => (
            <Text key={j}>{renderInline(l)}</Text>
          ))}
        </Flex>
      );

    case "ul":
      return (
        <List key={key} variant="unordered">
          {b.items.map((item, j) => (
            <Text key={j}>{renderInline(item)}</Text>
          ))}
        </List>
      );

    case "ol":
      return (
        <List key={key} variant="ordered">
          {b.items.map((item, j) => (
            <Text key={j}>{renderInline(item)}</Text>
          ))}
        </List>
      );

    case "table":
      return (
        <Table key={key} bordered>
          <TableHead>
            <TableRow>
              {b.headers.map((h, j) => (
                <TableHeader key={j}>{renderInline(h)}</TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {b.rows.map((row, j) => (
              <TableRow key={j}>
                {row.map((cell, k) => (
                  <TableCell key={k}>{renderInline(cell)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );

    case "rule":
      return <Divider key={key} />;

    case "blank":
      return null;
  }
}

/** Test hook — exposes the block parser so unit tests can pin output. */
export const __test_only__ = { parseBlocks };
