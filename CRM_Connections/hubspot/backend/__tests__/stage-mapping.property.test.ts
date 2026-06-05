import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  VALID_ACE_STAGES,
  parseStageMapping,
} from "../lib/stage-mapping";

// Feature: hubspot-ace-share-refresh-buttons
// Property 5: parseStageMapping round-trips valid input and flags exactly the
// off-list ACE stages.
//
// Two sub-properties covered here:
//   (a) invalidEntries is exactly the list of off-list `id=stage` pairs from
//       the raw input (in order of appearance), and no off-list stage leaks
//       into the mapping.
//   (b) For valid-only inputs, mapping equals the first-occurrence-wins
//       reduction of the generated entries.
//   (c) Serialize-parse idempotence: reserializing a parsed mapping as
//       `id1=v1;id2=v2;...` and reparsing yields the same mapping with no
//       invalid entries.
//
// Validates: Requirements 9.1, 9.2, 9.4

// Tokens are generated pre-trimmed and pre-stripped of the separator chars
// `=` and `;` so that reserialization round-trips cleanly. The parser itself
// trims each entry, so the trimmed/separator-free arbitraries match exactly
// what the parser would normalize the input to.
const TOKEN_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.";

// Arbitrary: a valid HubSpot stage ID token (non-empty, no '=' or ';',
// no leading/trailing whitespace).
const hsStageId = () =>
  fc
    .stringOf(fc.constantFrom(...TOKEN_CHARS.split("")), {
      minLength: 1,
      maxLength: 20,
    });

// Arbitrary: an on-list ACE stage.
const validAceStage = () => fc.constantFrom(...VALID_ACE_STAGES);

// Arbitrary: an off-list ACE stage — a non-empty token that is not a member
// of VALID_ACE_STAGES. Using the same token alphabet keeps the value free of
// separator chars and whitespace.
const invalidAceStage = () =>
  fc
    .stringOf(fc.constantFrom(...TOKEN_CHARS.split("")), {
      minLength: 1,
      maxLength: 20,
    })
    .filter(
      (s) => !(VALID_ACE_STAGES as readonly string[]).includes(s),
    );

type RawEntry = { id: string; stage: string; valid: boolean };

const rawEntry = () =>
  fc.oneof(
    fc
      .tuple(hsStageId(), validAceStage())
      .map(([id, stage]) => ({ id, stage, valid: true })),
    fc
      .tuple(hsStageId(), invalidAceStage())
      .map(([id, stage]) => ({ id, stage, valid: false })),
  );

const validRawEntry = () =>
  fc
    .tuple(hsStageId(), validAceStage())
    .map(([id, stage]) => ({ id, stage }));

function toRawString(entries: { id: string; stage: string }[]): string {
  return entries.map((e) => `${e.id}=${e.stage}`).join(";");
}

describe("parseStageMapping — Property 5", () => {
  test("invalidEntries is exactly the list of off-list entries in order, and no off-list stage leaks into mapping", () => {
    fc.assert(
      fc.property(
        fc.array(rawEntry(), { minLength: 0, maxLength: 20 }),
        (entries) => {
          const raw = toRawString(entries);
          const { mapping, invalidEntries } = parseStageMapping(raw);

          // (a1) Every off-list entry in the raw input appears in
          // invalidEntries in the order it was generated. The parser pushes
          // every off-list entry (duplicate-key filtering happens AFTER the
          // off-list check), so this is a straightforward order-preserving
          // filter.
          const expectedInvalid = entries
            .filter((e) => !e.valid)
            .map((e) => `${e.id}=${e.stage}`);
          expect(invalidEntries).toEqual(expectedInvalid);

          // (a2) No off-list ACE stage leaked into the forward mapping.
          for (const stage of Object.values(mapping)) {
            expect(
              (VALID_ACE_STAGES as readonly string[]).includes(stage),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("first-occurrence wins for duplicate HubSpot IDs on valid-only inputs", () => {
    fc.assert(
      fc.property(
        fc.array(validRawEntry(), { minLength: 0, maxLength: 20 }),
        (entries) => {
          const raw = toRawString(entries);
          const { mapping, invalidEntries } = parseStageMapping(raw);

          // Build the expected first-occurrence map from the raw entries.
          // Use Object.prototype.hasOwnProperty.call to match the parser's
          // own guard against prototype-pollution names like `constructor`.
          const expected: Record<string, string> = {};
          for (const e of entries) {
            if (!Object.prototype.hasOwnProperty.call(expected, e.id)) {
              expected[e.id] = e.stage;
            }
          }
          expect(mapping).toEqual(expected);
          // All inputs were on-list, so invalidEntries must be empty.
          expect(invalidEntries).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("serialize-parse idempotence: reserializing a parsed mapping re-parses to the same mapping", () => {
    fc.assert(
      fc.property(
        fc.array(validRawEntry(), { minLength: 0, maxLength: 20 }),
        (entries) => {
          const raw = toRawString(entries);
          const { mapping: mapping1 } = parseStageMapping(raw);

          // Reserialize mapping1 using the same grammar and parse it again.
          const reserialized = Object.entries(mapping1)
            .map(([id, stage]) => `${id}=${stage}`)
            .join(";");
          const { mapping: mapping2, invalidEntries } =
            parseStageMapping(reserialized);

          expect(mapping2).toEqual(mapping1);
          expect(invalidEntries).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("empty raw input produces empty result", () => {
    expect(parseStageMapping("")).toEqual({ mapping: {}, invalidEntries: [] });
  });
});
