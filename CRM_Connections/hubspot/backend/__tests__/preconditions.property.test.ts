import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  validatePreconditions,
  parseSolutionIds,
  parseAwsProductIds,
  PRECONDITION_KEYS,
  type DealProps,
  type CompanyProps,
  type PreconditionKey,
} from "../lib/preconditions";
import type { StageMapping } from "../lib/stage-mapping";

// Feature: hubspot-ace-share-refresh-buttons
// Property 1: validatePreconditions returns exactly the set of violated rules.
//
// Strategy: for each of the five rules, generate an input that is valid or
// invalid (with a Boolean decision variable). Assemble a full deal/company/
// mapping from those choices and assert the violation set equals the set of
// rules marked invalid. This covers the "iff" direction in both directions:
// every invalid-input rule shows up in the result, and every valid-input rule
// stays out.
//
// Validates: Requirements 2.2, 2.3

// Fixed stage mapping used across all runs. Three mapped HubSpot stage IDs
// keep the arbitrary's "valid stage" branch simple and deterministic. Values
// are drawn from VALID_ACE_STAGES so the mapping itself is well-formed.
const FIXED_MAPPING: StageMapping = {
  qualified: "Qualified",
  techvalid: "Technical Validation",
  closedlost: "Closed Lost",
};

// Rule-level arbitraries. Each yields `{ value, valid }` so the caller knows
// what the rule's verdict should be for that input. "Invalid" arbitraries are
// constrained to values that actually violate the rule under test; "valid"
// arbitraries are constrained to values that cannot violate it.

// closedate — invalid: empty/whitespace/undefined; valid: any non-empty
// trimmed string (ISO date shape is not checked by the validator).
const arbCloseDate = () =>
  fc.oneof(
    fc
      .constantFrom("", "   ", undefined as unknown as string)
      .map((v) => ({ closedate: v, valid: false })),
    fc
      .constantFrom("2025-06-15", "2030-01-01T00:00:00.000Z", "tomorrow")
      .map((v) => ({ closedate: v, valid: true })),
  );

// amount — invalid: empty, whitespace, non-numeric, zero, negative, undefined;
// valid: positive finite number serialized via `String(n)`. `Number(String(n))`
// round-trips for every finite JS number, so the valid branch is guaranteed
// to pass the `Number.isFinite(x) && x > 0` check the validator performs.
const arbAmount = () =>
  fc.oneof(
    fc
      .constantFrom(
        "",
        "   ",
        "-5",
        "0",
        "not-a-number",
        undefined as unknown as string,
      )
      .map((v) => ({ amount: v, valid: false })),
    fc
      .double({ min: 0.01, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
      .map((n) => ({ amount: String(n), valid: true })),
  );

// company — produces a CompanyProps with per-rule validity decisions for
// the company-side rules. `stateRequired` mirrors the validator's
// conditional rule: stateOrRegion is required ONLY when hs_country_code
// is "US"; for all other countries the validator skips it.
const arbCompany = () =>
  fc.oneof(
    fc.constant({
      company: undefined as CompanyProps,
      countryValid: false,
      stateRequired: false,
      stateValid: false,
      zipValid: false,
    }),
    fc
      .tuple(
        fc.oneof(
          fc.constantFrom("", "   ", undefined as unknown as string).map(
            (v) => ({ value: v, valid: false, isUS: false }),
          ),
          fc.constant({ value: "US", valid: true, isUS: true }),
          fc.constantFrom("DE", "JP", "BR").map(
            (v) => ({ value: v, valid: true, isUS: false }),
          ),
        ),
        fc.oneof(
          fc.constantFrom("", "   ", undefined as unknown as string).map(
            (v) => ({ value: v, valid: false }),
          ),
          fc.constantFrom("WA", "California", "Tokyo", "Bavaria").map(
            (v) => ({ value: v, valid: true }),
          ),
        ),
        fc.oneof(
          fc.constantFrom("", "   ", undefined as unknown as string).map(
            (v) => ({ value: v, valid: false }),
          ),
          fc.constantFrom("98101", "10115", "100-0001", "01000").map(
            (v) => ({ value: v, valid: true }),
          ),
        ),
      )
      .map(([cc, st, zp]) => ({
        company: {
          name: "Acme",
          hs_country_code: cc.value,
          state: st.value,
          zip: zp.value,
        } as CompanyProps,
        countryValid: cc.valid,
        // The state precondition only fires when the country is US.
        stateRequired: cc.isUS,
        stateValid: st.valid,
        zipValid: zp.valid,
      })),
  );

// description — invalid: trimmed length <20 (short string, or undefined);
// valid: trimmed length ≥20. The `.filter` on the valid branch guards
// against fast-check producing a long-but-mostly-whitespace string that
// would fail the trim check.
const arbDescription = () =>
  fc.oneof(
    fc
      .string({ minLength: 0, maxLength: 19 })
      .map((s) => ({ description: s, valid: false })),
    fc
      .constant(undefined as unknown as string)
      .map((v) => ({ description: v, valid: false })),
    fc
      .string({ minLength: 20, maxLength: 200 })
      .filter((s) => s.trim().length >= 20)
      .map((s) => ({ description: s, valid: true })),
  );

// dealstage — invalid: empty/whitespace/undefined, or a non-empty id not
// present in FIXED_MAPPING; valid: one of the mapped ids.
const arbStage = () =>
  fc.oneof(
    fc
      .constantFrom("qualified", "techvalid", "closedlost")
      .map((s) => ({ stage: s, valid: true })),
    fc
      .constantFrom(
        "",
        "   ",
        "unmapped-stage",
        "closed_won",
        undefined as unknown as string,
      )
      .map((s) => ({ stage: s, valid: false })),
  );

// ace_solutions — invalid: empty / whitespace / undefined / `;`-only /
// only-non-`S-…` entries; valid: at least one `S-[0-9]+` ID.
const arbSolutions = () =>
  fc.oneof(
    fc
      .constantFrom(
        "",
        "   ",
        ";",
        " ; ;",
        "Other",
        "S-abc",
        "Other;not-a-solution",
        undefined as unknown as string,
      )
      .map((v) => ({ solutions: v, valid: false })),
    fc
      .constantFrom(
        "S-0000001",
        "S-0000001;S-0000002",
        "  S-0000001  ;  S-0000002  ",
        "S-0000001;;S-0000002",
        // Real ID + invalid junk is still a pass — junk gets filtered.
        "S-0000001;Other",
      )
      .map((v) => ({ solutions: v, valid: true })),
  );

// ace_closed_lost_reason — invalid (when stage maps to Closed Lost):
// empty / whitespace / undefined; valid: any non-empty string. The
// payload builder doesn't enforce enum membership at the validator
// level — that's an ACE-side check that surfaces as `INVALID_ENUM_VALUE`
// rather than as a precondition.
const arbClosedLostReason = () =>
  fc.oneof(
    fc
      .constantFrom("", "   ", undefined as unknown as string)
      .map((v) => ({ reason: v, present: false })),
    fc
      .constantFrom(
        "Price",
        "Lost to Competitor - Microsoft",
        "Customer Deficiency",
      )
      .map((v) => ({ reason: v, present: true })),
  );

describe("validatePreconditions — Property 1", () => {
  test("violation set equals the set of rules with invalid input", () => {
    fc.assert(
      fc.property(
        arbCloseDate(),
        arbAmount(),
        arbCompany(),
        arbDescription(),
        arbStage(),
        arbSolutions(),
        arbClosedLostReason(),
        (cd, amt, co, desc, st, sol, clr) => {
          const deal: DealProps = {
            closedate: cd.closedate,
            amount: amt.amount,
            description: desc.description,
            dealstage: st.stage,
            ace_solutions: sol.solutions,
            ace_closed_lost_reason: clr.reason,
          };
          const violations = validatePreconditions(
            deal,
            co.company,
            FIXED_MAPPING,
          );
          const expected = new Set<PreconditionKey>();
          if (!cd.valid) expected.add("closedate");
          if (!amt.valid) expected.add("amount");
          if (!co.countryValid) expected.add("countryCode");
          // stateOrRegion is conditionally required: only when country is "US".
          // The arbitrary's `stateRequired` flag captures this from the
          // company shape so the test mirrors the validator's logic.
          if (co.stateRequired && !co.stateValid)
            expected.add("stateOrRegion");
          if (!co.zipValid) expected.add("postalCode");
          if (!desc.valid) expected.add("descriptionLength");
          if (!st.valid) expected.add("stageMappable");
          if (!sol.valid) expected.add("solutions");
          // closedLostReason fires only when the mapped ACE stage is
          // Closed Lost — i.e. when the HubSpot stage id is the one
          // that maps to "Closed Lost" in FIXED_MAPPING. For other
          // mapped stages (or unmapped stages) the rule is a no-op.
          if (st.stage === "closedlost" && !clr.present)
            expected.add("closedLostReason");
          expect(new Set(violations)).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("violations appear in the canonical PRECONDITION_KEYS order", () => {
    fc.assert(
      fc.property(
        arbCloseDate(),
        arbAmount(),
        arbCompany(),
        arbDescription(),
        arbStage(),
        arbSolutions(),
        arbClosedLostReason(),
        (cd, amt, co, desc, st, sol, clr) => {
          const deal: DealProps = {
            closedate: cd.closedate,
            amount: amt.amount,
            description: desc.description,
            dealstage: st.stage,
            ace_solutions: sol.solutions,
            ace_closed_lost_reason: clr.reason,
          };
          const violations = validatePreconditions(
            deal,
            co.company,
            FIXED_MAPPING,
          );
          const indices = violations.map((v) => PRECONDITION_KEYS.indexOf(v));
          for (let i = 1; i < indices.length; i++) {
            expect(indices[i]).toBeGreaterThan(indices[i - 1]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("empty violations iff all preconditions hold", () => {
    // All valid → empty violations.
    const deal: DealProps = {
      closedate: "2025-06-15",
      amount: "5000",
      description:
        "A sufficiently long business problem description here.",
      dealstage: "qualified",
      ace_solutions: "S-0000001",
    };
    const company: CompanyProps = {
      name: "Acme",
      hs_country_code: "US",
      state: "WA",
      zip: "98101",
    };
    expect(validatePreconditions(deal, company, FIXED_MAPPING)).toEqual([]);

    // Breaking any one rule surfaces that rule in the violations list.
    expect(
      validatePreconditions({ ...deal, closedate: "" }, company, FIXED_MAPPING),
    ).toContain("closedate");
    // Missing state on a US company violates stateOrRegion.
    expect(
      validatePreconditions(deal, { ...company, state: "" }, FIXED_MAPPING),
    ).toContain("stateOrRegion");
    // Missing state on a NON-US company is NOT a violation (ACE drops
    // StateOrRegion silently for non-US addresses, so we don't gate on it).
    const ieCompany: CompanyProps = {
      ...company,
      hs_country_code: "IE",
      state: "",
    };
    expect(
      validatePreconditions(deal, ieCompany, FIXED_MAPPING),
    ).not.toContain("stateOrRegion");
    // Missing zip violates postalCode regardless of country.
    expect(
      validatePreconditions(deal, { ...company, zip: "" }, FIXED_MAPPING),
    ).toContain("postalCode");
    // Missing or whitespace-only ace_solutions violates the solutions rule.
    expect(
      validatePreconditions(
        { ...deal, ace_solutions: "" },
        company,
        FIXED_MAPPING,
      ),
    ).toContain("solutions");
    // `;`-only / whitespace-only entries are dropped by parseSolutionIds,
    // so they also trigger the violation.
    expect(
      validatePreconditions(
        { ...deal, ace_solutions: "   ;   " },
        company,
        FIXED_MAPPING,
      ),
    ).toContain("solutions");
    // The `solutions` rule is satisfied by EITHER a real Solution
    // Offering ID OR a non-blank `ace_other_solution_description` —
    // the latter mirrors the Partner Central UI's "Other" path,
    // which writes to `Project.OtherSolutionDescription` and skips
    // AssociateOpportunity entirely.
    expect(
      validatePreconditions(
        {
          ...deal,
          ace_solutions: "",
          ace_other_solution_description:
            "Custom integration not covered by an existing Solution Offering.",
        },
        company,
        FIXED_MAPPING,
      ),
    ).not.toContain("solutions");
    // The literal "Other" alone in `ace_solutions` is filtered out
    // (AWS rejects it with `INVALID_VALUE`); without an `ace_other_solution_description`,
    // the rule still fails.
    expect(
      validatePreconditions(
        { ...deal, ace_solutions: "Other" },
        company,
        FIXED_MAPPING,
      ),
    ).toContain("solutions");

    // closedLostReason rule: only fires when the mapped ACE stage is
    // Closed Lost. A Closed Lost deal without `ace_closed_lost_reason`
    // violates the rule.
    expect(
      validatePreconditions(
        { ...deal, dealstage: "closedlost" },
        company,
        FIXED_MAPPING,
      ),
    ).toContain("closedLostReason");
    // With a reason set, the violation goes away.
    expect(
      validatePreconditions(
        {
          ...deal,
          dealstage: "closedlost",
          ace_closed_lost_reason: "Price",
        },
        company,
        FIXED_MAPPING,
      ),
    ).not.toContain("closedLostReason");
    // For non-Closed-Lost stages the rule never fires, even with an
    // empty `ace_closed_lost_reason`.
    expect(
      validatePreconditions(
        { ...deal, ace_closed_lost_reason: "" },
        company,
        FIXED_MAPPING,
      ),
    ).not.toContain("closedLostReason");
    // An unmapped stage doesn't trigger closedLostReason either —
    // the rule is gated on the *mapped* ACE stage being Closed Lost.
    expect(
      validatePreconditions(
        { ...deal, dealstage: "unmapped-stage" },
        company,
        FIXED_MAPPING,
      ),
    ).not.toContain("closedLostReason");
  });

  test("deal-level customer overrides satisfy preconditions when no company is associated", () => {
    // The reverse-sync from EventBridge creates HubSpot deals with
    // no associated HubSpot company but populates `ace_country_code`,
    // `ace_postal_code`, and friends from the AWS opportunity. Share
    // must accept those deals without forcing the rep to attach a
    // company first.
    const deal: DealProps = {
      dealstage: "qualified",
      closedate: "2026-12-15",
      amount: "1000",
      description: "A long enough description for ACE precondition.",
      ace_solutions: "S-0000010",
      ace_country_code: "US",
      ace_postal_code: "98101",
      ace_state_or_region: "WA",
      ace_company_name: "Reverse-synced Co",
    };
    expect(validatePreconditions(deal, undefined, FIXED_MAPPING)).toEqual([]);
  });

  test("deal-level country override falls back to company when missing", () => {
    // Company-only flow still works (the original v1 behaviour).
    const deal: DealProps = {
      dealstage: "qualified",
      closedate: "2026-12-15",
      amount: "1000",
      description: "A long enough description for ACE precondition.",
      ace_solutions: "S-0000010",
    };
    const company = {
      hs_country_code: "IE",
      zip: "D02 X285",
    };
    expect(validatePreconditions(deal, company, FIXED_MAPPING)).toEqual([]);
  });

  test("deal-level postal-code override survives a missing company", () => {
    const deal: DealProps = {
      dealstage: "qualified",
      closedate: "2026-12-15",
      amount: "1000",
      description: "A long enough description for ACE precondition.",
      ace_solutions: "S-0000010",
      ace_country_code: "AU",
      ace_postal_code: "2000",
    };
    expect(validatePreconditions(deal, undefined, FIXED_MAPPING)).toEqual([]);
  });

  test("US deal still requires stateOrRegion via either source", () => {
    const deal: DealProps = {
      dealstage: "qualified",
      closedate: "2026-12-15",
      amount: "1000",
      description: "A long enough description for ACE precondition.",
      ace_solutions: "S-0000010",
      ace_country_code: "US",
      ace_postal_code: "98101",
    };
    // Neither source has a state — violation surfaces.
    expect(
      validatePreconditions(deal, undefined, FIXED_MAPPING),
    ).toContain("stateOrRegion");
    // Deal-level state satisfies the rule.
    expect(
      validatePreconditions(
        { ...deal, ace_state_or_region: "WA" },
        undefined,
        FIXED_MAPPING,
      ),
    ).toEqual([]);
  });
});

describe("parseSolutionIds", () => {
  test("undefined / empty / whitespace return []", () => {
    expect(parseSolutionIds(undefined)).toEqual([]);
    expect(parseSolutionIds("")).toEqual([]);
    expect(parseSolutionIds("   ")).toEqual([]);
    expect(parseSolutionIds(";;")).toEqual([]);
  });

  test("trims, deduplicates, and preserves first-seen order", () => {
    expect(parseSolutionIds(" S-0000010 ;  S-0000020 ; S-0000010 ")).toEqual([
      "S-0000010",
      "S-0000020",
    ]);
  });

  test("single id returns a single-element array", () => {
    expect(parseSolutionIds("S-0000099")).toEqual(["S-0000099"]);
  });

  test("`;`-separated ids preserve input order", () => {
    expect(parseSolutionIds("S-0000030;S-0000010;S-0000020")).toEqual([
      "S-0000030",
      "S-0000010",
      "S-0000020",
    ]);
  });

  test("non-`S-[0-9]+` entries (e.g. literal 'Other', typos) are dropped", () => {
    // The HubSpot-side picklist may carry an "Other" sentinel value
    // for partners using `Project.OtherSolutionDescription`. We must
    // drop it before forwarding to AssociateOpportunity, which would
    // otherwise reject with `INVALID_VALUE`.
    expect(parseSolutionIds("Other")).toEqual([]);
    expect(parseSolutionIds("Other;S-0000010")).toEqual(["S-0000010"]);
    expect(parseSolutionIds("S-foo;not-a-solution;S-0000020")).toEqual([
      "S-0000020",
    ]);
    // `S-` alone or `S-` with letters is not a real Solution Offering ID.
    expect(parseSolutionIds("S-;S-abc")).toEqual([]);
  });

  test("accepts comma, whitespace, or mixed separators (rep-friendly)", () => {
    // Reps using a free-text field commonly type commas instead of
    // `;` — accept those too. HubSpot multi-select pickists still
    // produce `;` natively. Mixed separators (e.g. paste from a
    // spreadsheet) should also resolve.
    expect(parseSolutionIds("S-0000010,S-0000020")).toEqual([
      "S-0000010",
      "S-0000020",
    ]);
    expect(parseSolutionIds("S-0000010, S-0000020")).toEqual([
      "S-0000010",
      "S-0000020",
    ]);
    expect(parseSolutionIds("S-0000010 S-0000020")).toEqual([
      "S-0000010",
      "S-0000020",
    ]);
    expect(parseSolutionIds("S-0000010\nS-0000020")).toEqual([
      "S-0000010",
      "S-0000020",
    ]);
    expect(parseSolutionIds("S-0000010;S-0000020,S-0000030 S-0000010")).toEqual(
      ["S-0000010", "S-0000020", "S-0000030"],
    );
  });
});

describe("parseAwsProductIds", () => {
  test("undefined / empty / whitespace return []", () => {
    expect(parseAwsProductIds(undefined)).toEqual([]);
    expect(parseAwsProductIds("")).toEqual([]);
    expect(parseAwsProductIds("   ")).toEqual([]);
    expect(parseAwsProductIds(";;,, ,")).toEqual([]);
  });

  test("accepts alphanumeric Product Codes from the AWS catalog", () => {
    // Empirically validated from
    // aws-samples/partner-crm-integration-samples/resources/SampleAWSProducts.csv:
    // codes are alphanumeric tokens, occasional dot or space.
    expect(parseAwsProductIds("AmazonEC2P5")).toEqual(["AmazonEC2P5"]);
    expect(parseAwsProductIds("S3IntelligentTiering")).toEqual([
      "S3IntelligentTiering",
    ]);
    expect(parseAwsProductIds("AWSPrivateCA")).toEqual(["AWSPrivateCA"]);
  });

  test("preserves order and deduplicates `;`-separated lists", () => {
    expect(
      parseAwsProductIds("AmazonEC2P5;AmazonS3;AmazonEC2P5;AWSLambda"),
    ).toEqual(["AmazonEC2P5", "AmazonS3", "AWSLambda"]);
  });

  test("accepts comma separators alongside `;`", () => {
    // Reps typing in a free-text field commonly use commas.
    expect(parseAwsProductIds("AmazonEC2P5,AmazonS3")).toEqual([
      "AmazonEC2P5",
      "AmazonS3",
    ]);
    expect(parseAwsProductIds("AmazonEC2P5;AmazonS3,AWSLambda")).toEqual([
      "AmazonEC2P5",
      "AmazonS3",
      "AWSLambda",
    ]);
  });

  test("preserves codes with internal dots or spaces (legitimate AWS codes)", () => {
    // The AWS catalog includes `CODE.AWS` (dot) and
    // `Amazon GameCast` (internal space) — preserve both.
    expect(parseAwsProductIds("CODE.AWS")).toEqual(["CODE.AWS"]);
    expect(parseAwsProductIds("Amazon GameCast")).toEqual([
      "Amazon GameCast",
    ]);
    // Two codes separated by `;` — internal spaces survive because
    // we only split on `;`/`,`, not whitespace.
    expect(parseAwsProductIds("Amazon GameCast;AmazonEC2P5")).toEqual([
      "Amazon GameCast",
      "AmazonEC2P5",
    ]);
  });

  test("intentionally permissive: malformed tokens flow through to AWS for validation", () => {
    // Unlike `parseSolutionIds`, we don't enforce a regex — the AWS
    // Product catalog has codes with dots and spaces, so a strict
    // regex would reject legitimate values. AWS rejects unknown
    // codes at AssociateOpportunity time with `INVALID_VALUE`.
    expect(parseAwsProductIds("not-a-real-code")).toEqual([
      "not-a-real-code",
    ]);
    // Whitespace-only entries are still dropped.
    expect(parseAwsProductIds("AmazonEC2P5;   ;AmazonS3")).toEqual([
      "AmazonEC2P5",
      "AmazonS3",
    ]);
  });
});
