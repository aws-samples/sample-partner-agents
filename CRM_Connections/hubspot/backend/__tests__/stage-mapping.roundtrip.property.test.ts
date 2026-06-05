import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  VALID_ACE_STAGES,
  parseStageMapping,
  forwardMap,
  reverseMap,
} from "../lib/stage-mapping";

// Feature: hubspot-ace-share-refresh-buttons
// Property 3: forward-then-reverse round trip is consistent at the ACE-stage level.
//
// For any mapping M and any HubSpot stage ID `hs` that is a key in M:
//   let a   = forwardMap(hs, M)              // known ACE stage
//   let hs' = reverseMap(a, M)               // some HS ID, possibly different from hs
//   then forwardMap(hs', M) === a            // round-trip lands on the same ACE stage
//
// Validates: Requirements 4.2

const TOKEN_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.";

const hsStageId = () =>
  fc.stringOf(fc.constantFrom(...TOKEN_CHARS.split("")), {
    minLength: 1,
    maxLength: 20,
  });
const validAceStage = () => fc.constantFrom(...VALID_ACE_STAGES);

// Arbitrary mapping: generate a list of {id, stage} pairs (duplicate ids allowed;
// first-occurrence wins), serialize, and parse.
const arbitraryMapping = () =>
  fc
    .array(fc.tuple(hsStageId(), validAceStage()), {
      minLength: 1,
      maxLength: 15,
    })
    .map((pairs) => {
      const raw = pairs.map(([id, stage]) => `${id}=${stage}`).join(";");
      const { mapping } = parseStageMapping(raw);
      return mapping;
    })
    .filter((m) => Object.keys(m).length > 0);

describe("forwardMap / reverseMap — Property 3", () => {
  test("round trip forward→reverse→forward lands on the same ACE stage for any key", () => {
    fc.assert(
      fc.property(arbitraryMapping(), (mapping) => {
        for (const hs of Object.keys(mapping)) {
          const a = forwardMap(hs, mapping);
          expect(a).toBeDefined();
          const hsPrime = reverseMap(a!, mapping);
          expect(hsPrime).toBeDefined();
          // The round trip lands on the same ACE stage (not necessarily the same HS id).
          expect(forwardMap(hsPrime!, mapping)).toBe(a);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("reverseMap returns undefined for an ACE stage absent from the mapping", () => {
    fc.assert(
      fc.property(
        arbitraryMapping(),
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter(
            (s) => !(VALID_ACE_STAGES as readonly string[]).includes(s),
          ),
        (mapping, absentStage) => {
          const hsPrime = reverseMap(absentStage, mapping);
          // If absentStage happens to equal an in-mapping value, it's not absent; skip.
          const valuesInMapping = new Set(Object.values(mapping));
          if (valuesInMapping.has(absentStage as never)) return;
          expect(hsPrime).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
