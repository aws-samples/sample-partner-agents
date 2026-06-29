import { describe, test, expect } from "vitest";

import {
  SUBMISSION_REQUIRED_FIELDS,
  classifySubmissionMode,
  isSubmitActionVisible,
  missingSubmissionFields,
  type SubmissionInputs,
  type SubmissionMode,
} from "../lib/submission-mode";

/**
 * Table tests for the pure `submission-mode` classifier.
 *
 * Exercises all 16 cells of the (fieldState × aws_review_status) input space
 * called out in design §Testing Strategy → `submission-mode.test.ts`. Plus the
 * oppId-empty short-circuit for `isSubmitActionVisible` and the trim-
 * equivalence guarantee that backs Property 1 in the design.
 *
 * Requirements covered: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 7.1, 11.2, 11.3
 */

// All five Submission_Required_Fields populated with valid values. The
// 16-cell table varies ace_involvement_type / ace_visibility; the other
// three are held populated here so they never contribute to the missing
// set under those table cells. Tests that exercise the new fields do so
// explicitly.
const VALID_SUBMISSION_FIELDS = {
  ace_involvement_type: "Co-Sell",
  ace_visibility: "Full",
  ace_delivery_model: "SaaS or PaaS",
  ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
  ace_customer_use_case: "Business Applications & Contact Center",
  ace_sales_activities: "Initialized discussions with customer",
} as const;

// --- Field-state dimension --------------------------------------------------

type FieldStateName =
  | "both populated"
  | "only ace_involvement_type missing"
  | "only ace_visibility missing"
  | "both missing";

type FieldState = {
  name: FieldStateName;
  ace_involvement_type: string;
  ace_visibility: string;
  /** Field names expected to be reported as missing, in declaration order. */
  expectedMissing: ReadonlyArray<(typeof SUBMISSION_REQUIRED_FIELDS)[number]>;
};

const FIELD_STATES: ReadonlyArray<FieldState> = [
  {
    name: "both populated",
    ace_involvement_type: "Co-Sell",
    ace_visibility: "Full",
    expectedMissing: [],
  },
  {
    name: "only ace_involvement_type missing",
    ace_involvement_type: "",
    ace_visibility: "Full",
    expectedMissing: ["ace_involvement_type"],
  },
  {
    name: "only ace_visibility missing",
    ace_involvement_type: "Co-Sell",
    ace_visibility: "",
    expectedMissing: ["ace_visibility"],
  },
  {
    name: "both missing",
    ace_involvement_type: "",
    ace_visibility: "",
    expectedMissing: ["ace_involvement_type", "ace_visibility"],
  },
];

// --- Review-status dimension ------------------------------------------------

type ReviewStatusCategory =
  | "empty"
  | "Pending Submission"
  | "Submitted (or In Review / Action Required)"
  | "Approved";

type ReviewStatusCase = {
  category: ReviewStatusCategory;
  /** Representative value for the category. */
  value: string;
  /** True iff the value is in the SUBMITTABLE_STATES set per design. */
  submittable: boolean;
};

const REVIEW_STATUSES: ReadonlyArray<ReviewStatusCase> = [
  { category: "empty", value: "", submittable: true },
  { category: "Pending Submission", value: "Pending Submission", submittable: true },
  {
    category: "Submitted (or In Review / Action Required)",
    value: "Submitted",
    submittable: false,
  },
  { category: "Approved", value: "Approved", submittable: false },
];

// --- Expected-mode oracle ---------------------------------------------------

/**
 * Mirrors the requirements directly so the table doubles as documentation:
 *   • R1.2 — All required fields populated AND status not in the
 *     "blocked-from-fresh-submit" set ⇒ Create_And_Submit.
 *   • R1.3 / R7.1 — Pending Submission, Submitted, In Review, Action Required,
 *     Approved, Rejected ⇒ Create_Only.
 *   • R3.5 — Missing required fields downgrade to Create_Only.
 */
function expectedMode(field: FieldState, status: ReviewStatusCase): SubmissionMode {
  if (field.expectedMissing.length > 0) return "Create_Only";
  return status.submittable && status.value !== "Pending Submission"
    ? "Create_And_Submit"
    : "Create_Only";
}

// --- Tests ------------------------------------------------------------------

describe("submission-mode classifier", () => {
  describe("classifySubmissionMode — full 16-cell table", () => {
    for (const field of FIELD_STATES) {
      for (const status of REVIEW_STATUSES) {
        const expected = expectedMode(field, status);
        test(`${field.name} × aws_review_status="${status.value}" → ${expected}`, () => {
          const deal: SubmissionInputs = {
            ...VALID_SUBMISSION_FIELDS,
            ace_involvement_type: field.ace_involvement_type,
            ace_visibility: field.ace_visibility,
            aws_review_status: status.value,
          };
          expect(classifySubmissionMode(deal)).toBe(expected);
        });
      }
    }
  });

  describe("missingSubmissionFields — 4 field-state cases", () => {
    for (const field of FIELD_STATES) {
      test(`${field.name} → [${field.expectedMissing.join(", ")}]`, () => {
        const deal: SubmissionInputs = {
          ...VALID_SUBMISSION_FIELDS,
          ace_involvement_type: field.ace_involvement_type,
          ace_visibility: field.ace_visibility,
        };
        expect(missingSubmissionFields(deal)).toEqual([...field.expectedMissing]);
      });
    }

    test("undefined property values are treated as missing", () => {
      // R1.2 / R3.5: HubSpot may return `undefined` for unset properties; the
      // classifier must not blow up and must report them as missing in
      // declaration order — all five Submission_Required_Fields.
      expect(missingSubmissionFields({})).toEqual([
        "ace_involvement_type",
        "ace_visibility",
        "ace_delivery_model",
        "ace_primary_need_from_aws",
        "ace_customer_use_case",
        "ace_sales_activities",
      ]);
    });
  });

  describe("isSubmitActionVisible — opportunityId × review status grid", () => {
    // R5.1 / R11.1: empty oppId hides Submit unconditionally.
    for (const status of REVIEW_STATUSES) {
      test(`empty ace_opportunity_id + aws_review_status="${status.value}" → false`, () => {
        const deal: SubmissionInputs = {
          ace_opportunity_id: "",
          aws_review_status: status.value,
        };
        expect(isSubmitActionVisible(deal)).toBe(false);
      });
    }

    test("undefined ace_opportunity_id → false (R5.1)", () => {
      // Defensive: the card may not have populated the property yet.
      expect(isSubmitActionVisible({ aws_review_status: "Pending Submission" })).toBe(
        false
      );
    });

    // R5.2 / R5.3 / R11.2 / R11.3: with oppId set, visibility tracks the
    // SUBMITTABLE_STATES set.
    for (const status of REVIEW_STATUSES) {
      test(`oppId set + aws_review_status="${status.value}" → ${status.submittable}`, () => {
        const deal: SubmissionInputs = {
          ace_opportunity_id: "O-12345",
          aws_review_status: status.value,
        };
        expect(isSubmitActionVisible(deal)).toBe(status.submittable);
      });
    }

    test("R11.3 — empty aws_review_status is treated identically to 'Pending Submission'", () => {
      const empty: SubmissionInputs = {
        ace_opportunity_id: "O-12345",
        aws_review_status: "",
      };
      const pending: SubmissionInputs = {
        ace_opportunity_id: "O-12345",
        aws_review_status: "Pending Submission",
      };
      expect(isSubmitActionVisible(empty)).toBe(true);
      expect(isSubmitActionVisible(pending)).toBe(true);
    });
  });

  describe("trim-equivalence — '' and whitespace-only inputs collapse", () => {
    // Per design §Property 1: `""` and `"  "` MUST classify identically because
    // HubSpot serialises both to empty strings inconsistently.

    test("missingSubmissionFields treats whitespace-only as missing", () => {
      const dealEmpty: SubmissionInputs = {
        ...VALID_SUBMISSION_FIELDS,
        ace_involvement_type: "",
        ace_visibility: "",
      };
      const dealWhitespace: SubmissionInputs = {
        ...VALID_SUBMISSION_FIELDS,
        ace_involvement_type: "   ",
        ace_visibility: "\t \n",
      };
      expect(missingSubmissionFields(dealWhitespace)).toEqual(
        missingSubmissionFields(dealEmpty)
      );
      expect(missingSubmissionFields(dealWhitespace)).toEqual([
        "ace_involvement_type",
        "ace_visibility",
      ]);
    });

    test("classifySubmissionMode: whitespace-only required fields downgrade to Create_Only", () => {
      const deal: SubmissionInputs = {
        ...VALID_SUBMISSION_FIELDS,
        ace_involvement_type: "   ",
        ace_visibility: "Full",
        aws_review_status: "",
      };
      expect(classifySubmissionMode(deal)).toBe("Create_Only");
    });

    test("classifySubmissionMode: whitespace-only aws_review_status equates to empty (Create_And_Submit when fields populated)", () => {
      const dealEmpty: SubmissionInputs = {
        ...VALID_SUBMISSION_FIELDS,
        aws_review_status: "",
      };
      const dealWhitespace: SubmissionInputs = {
        ...VALID_SUBMISSION_FIELDS,
        aws_review_status: "   ",
      };
      expect(classifySubmissionMode(dealWhitespace)).toBe(
        classifySubmissionMode(dealEmpty)
      );
      expect(classifySubmissionMode(dealWhitespace)).toBe("Create_And_Submit");
    });

    test("isSubmitActionVisible: whitespace-only ace_opportunity_id hides Submit (R5.1)", () => {
      const deal: SubmissionInputs = {
        ace_opportunity_id: "   ",
        aws_review_status: "Pending Submission",
      };
      expect(isSubmitActionVisible(deal)).toBe(false);
    });

    test("isSubmitActionVisible: whitespace-only aws_review_status equates to empty (true when oppId set)", () => {
      const deal: SubmissionInputs = {
        ace_opportunity_id: "O-12345",
        aws_review_status: "   ",
      };
      expect(isSubmitActionVisible(deal)).toBe(true);
    });
  });
});
