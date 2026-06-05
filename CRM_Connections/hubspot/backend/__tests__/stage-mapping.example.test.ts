import { describe, test, expect } from "vitest";
import {
  parseStageMapping,
  parseStageDisplayNames,
  forwardMap,
  reverseMap,
} from "../lib/stage-mapping";

// Feature: hubspot-ace-share-refresh-buttons
// Unit tests for the STAGE_MAPPING / STAGE_DISPLAY_NAMES parser and the
// forward/reverse helpers. These are example-based tests; property-based
// round-trip coverage lives in stage-mapping.property.test.ts and
// stage-mapping.roundtrip.property.test.ts (tasks 3.3 and 3.4).
//
// Requirements covered: 9.1, 9.2, 9.3, 9.4

describe("parseStageMapping", () => {
  test("happy path: valid entries parse into mapping", () => {
    const raw =
      "qualified=Qualified;techvalid=Technical Validation;closedlost=Closed Lost";
    const { mapping, invalidEntries } = parseStageMapping(raw);
    expect(mapping).toEqual({
      qualified: "Qualified",
      techvalid: "Technical Validation",
      closedlost: "Closed Lost",
    });
    expect(invalidEntries).toEqual([]);
  });

  test("off-list ACE stages go to invalidEntries, not mapping", () => {
    const raw = "qualified=Qualified;bogus=NotAStage";
    const { mapping, invalidEntries } = parseStageMapping(raw);
    expect(mapping).toEqual({ qualified: "Qualified" });
    expect(invalidEntries).toEqual(["bogus=NotAStage"]);
  });

  test("duplicate HubSpot IDs: first-occurrence wins", () => {
    const raw = "qualified=Qualified;qualified=Committed";
    const { mapping, invalidEntries } = parseStageMapping(raw);
    expect(mapping).toEqual({ qualified: "Qualified" });
    expect(invalidEntries).toEqual([]);
  });

  test("whitespace tolerance around = and ;, with trailing ;", () => {
    const raw = " qualified = Qualified ; techvalid = Technical Validation ; ";
    const { mapping, invalidEntries } = parseStageMapping(raw);
    expect(mapping).toEqual({
      qualified: "Qualified",
      techvalid: "Technical Validation",
    });
    expect(invalidEntries).toEqual([]);
  });

  test("empty entries are silently skipped", () => {
    const raw = ";;qualified=Qualified;;;";
    const { mapping } = parseStageMapping(raw);
    expect(mapping).toEqual({ qualified: "Qualified" });
  });

  test("entries without '=' are silently skipped", () => {
    const raw = "foo;qualified=Qualified";
    const { mapping, invalidEntries } = parseStageMapping(raw);
    expect(mapping).toEqual({ qualified: "Qualified" });
    expect(invalidEntries).toEqual([]);
  });

  test("empty input returns empty result", () => {
    expect(parseStageMapping("")).toEqual({ mapping: {}, invalidEntries: [] });
  });
});

describe("parseStageDisplayNames", () => {
  test("parses valid entries", () => {
    const raw = "qualified=Qualified;techvalid=Technical Validation";
    expect(parseStageDisplayNames(raw)).toEqual({
      qualified: "Qualified",
      techvalid: "Technical Validation",
    });
  });

  test("accepts arbitrary non-empty display names (no ACE stage validation)", () => {
    const raw = "foo=Anything Goes Here";
    expect(parseStageDisplayNames(raw)).toEqual({ foo: "Anything Goes Here" });
  });

  test("empty string returns empty map", () => {
    expect(parseStageDisplayNames("")).toEqual({});
  });

  test("undefined returns empty map", () => {
    expect(parseStageDisplayNames(undefined)).toEqual({});
  });

  test("whitespace-only returns empty map", () => {
    expect(parseStageDisplayNames("  ; ; ")).toEqual({});
  });

  test("duplicate keys: first-occurrence wins", () => {
    expect(parseStageDisplayNames("a=X;a=Y")).toEqual({ a: "X" });
  });
});

describe("forwardMap", () => {
  test("returns mapped ACE stage", () => {
    const mapping = { qualified: "Qualified", closedlost: "Closed Lost" } as const;
    expect(forwardMap("qualified", mapping)).toBe("Qualified");
  });

  test("returns undefined for unmapped ID", () => {
    const mapping = { qualified: "Qualified" } as const;
    expect(forwardMap("missing", mapping)).toBeUndefined();
  });
});

describe("reverseMap", () => {
  test("returns a HubSpot ID that maps to the given ACE stage", () => {
    const mapping = { qualified: "Qualified", committed: "Committed" } as const;
    expect(reverseMap("Qualified", mapping)).toBe("qualified");
  });

  test("returns the first-inserted HS id when multiple HS ids collapse to the same ACE stage", () => {
    const mapping = {
      closedlost: "Closed Lost",
      closed_lost_competitor: "Closed Lost",
    } as const;
    expect(reverseMap("Closed Lost", mapping)).toBe("closedlost");
  });

  test("returns undefined for an absent ACE stage", () => {
    const mapping = { qualified: "Qualified" } as const;
    expect(reverseMap("Launched", mapping)).toBeUndefined();
  });
});
