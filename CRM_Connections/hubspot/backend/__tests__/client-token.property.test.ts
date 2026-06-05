import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { generateClientToken, PAYLOAD_VERSION } from "../lib/client-token";

// Feature: hubspot-ace-share-refresh-buttons
// Property 2: generateClientToken is deterministic and injective in the HubSpot deal ID.
//
// - Deterministic: calling with the same dealId always returns the same UUID.
// - Injective:     distinct dealIds always produce distinct UUIDs.
//                  (UUIDv5 collisions are bounded by the hash's birthday limit and
//                  are effectively impossible for int64 inputs.)
//
// Validates: Requirements 2.4

describe("generateClientToken — Property 2", () => {
  test("deterministic: same input produces same output across calls", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (dealId) => {
        const a = generateClientToken(dealId);
        const b = generateClientToken(dealId);
        expect(a).toBe(b);
        // Shape check: UUID v5 format.
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }),
      { numRuns: 100 }
    );
  });

  test("injective: distinct dealIds produce distinct tokens", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (x, y) => {
          fc.pre(x !== y); // skip equal-pair cases
          expect(generateClientToken(x)).not.toBe(generateClientToken(y));
        }
      ),
      { numRuns: 200 } // higher run count for injectivity
    );
  });

  test("equal iff equal (combined direction)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (x, y) => {
          const equalInputs = x === y;
          const equalTokens = generateClientToken(x) === generateClientToken(y);
          expect(equalTokens).toBe(equalInputs);
        }
      ),
      { numRuns: 100 }
    );
  });

  test("PAYLOAD_VERSION is pinned — bump invalidates every previously-generated token", () => {
    expect(PAYLOAD_VERSION).toBe("v6");
  });
});
