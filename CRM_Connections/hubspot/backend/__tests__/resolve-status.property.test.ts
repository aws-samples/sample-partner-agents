import { describe, expect, test } from "vitest";
import fc from "fast-check";

import { resolveStatus } from "../lib/resolve-status";

// `resolveStatus` is the sync-health resolver for `ace_sync_status`.
// After the v8 collapse, the enum shrinks to:
//
//   "Not Synced" | "Synced" | "Sync Error"
//
// AWS-side state (Submitted / Approved / Rejected / etc.) lives in
// `aws_review_status`, not in this resolver's output.
//
// `resolveStatus` is invoked exclusively from successful read paths,
// so it always returns "Synced". The function still takes review /
// stage args for source-compatibility with snapshotFromOpportunity's
// call signature; both are intentionally ignored.

describe("resolveStatus — sync-health flag", () => {
  test('always returns "Synced" because it is only called on success paths', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.constantFrom(
            "Pending Submission",
            "Submitted",
            "In review",
            "Action Required",
            "Approved",
            "Rejected",
            "",
            "Unknown",
            "   "
          ),
          { nil: undefined }
        ),
        fc.option(
          fc.constantFrom(
            "Prospect",
            "Qualified",
            "Technical Validation",
            "Business Validation",
            "Committed",
            "Launched",
            "Closed Lost",
            ""
          ),
          { nil: undefined }
        ),
        (review, stage) => {
          expect(resolveStatus(review, stage)).toBe("Synced");
        }
      ),
      { numRuns: 100 }
    );
  });

  test("Closed Lost is no longer special-cased — still Synced", () => {
    // The previous version returned "Synced" for Closed Lost as a
    // terminal state. The new version returns "Synced" because every
    // success path returns "Synced". The behaviour is the same; the
    // reasoning changed.
    expect(resolveStatus("Approved", "Closed Lost")).toBe("Synced");
    expect(resolveStatus(undefined, "Closed Lost")).toBe("Synced");
  });

  test("Rejected ReviewStatus no longer surfaces here — lives in aws_review_status", () => {
    // Operators who care about AWS rejection should read
    // `aws_review_status` from the deal — it carries the raw
    // "Rejected" string verbatim.
    expect(resolveStatus("Rejected", "Qualified")).toBe("Synced");
  });
});
