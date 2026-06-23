import { describe, test, expect } from "vitest";

import { formatAceError } from "../core/run-share";

/**
 * Unit tests for `formatAceError`.
 *
 * Partner Central `ValidationException`s put the actionable detail in a
 * structured `ErrorList` (`FieldName` / `Code` / `Message`) and/or a
 * `Reason`, while the top-level `.message` is frequently the unhelpful
 * literal `"UnknownError"`. `formatAceError` exists to surface the real
 * cause so the card alert and `ace_sync_error` are actionable instead of
 * showing `UnknownError`.
 */
describe("formatAceError", () => {
    test("extracts field-level detail from ErrorList (the ESC/EUR case)", () => {
        const err = Object.assign(new Error("UnknownError"), {
            name: "ValidationException",
            ErrorList: [
                {
                    FieldName: "ExpectedCustomerSpend.CurrencyCode",
                    Code: "INVALID_VALUE",
                    Message: "ESC cloud partition requires EUR currency",
                },
            ],
        });
        expect(formatAceError(err)).toBe(
            "ValidationException: ExpectedCustomerSpend.CurrencyCode: ESC cloud partition requires EUR currency [INVALID_VALUE]"
        );
    });

    test("joins multiple ErrorList entries with '; '", () => {
        const err = Object.assign(new Error("UnknownError"), {
            name: "ValidationException",
            ErrorList: [
                { FieldName: "customer.account.companyName", Code: "REQUIRED_FIELD_MISSING", Message: "companyName is required" },
                { FieldName: "customer.account.industry", Code: "REQUIRED_FIELD_MISSING", Message: "industry is required" },
            ],
        });
        expect(formatAceError(err)).toBe(
            "ValidationException: customer.account.companyName: companyName is required [REQUIRED_FIELD_MISSING]; customer.account.industry: industry is required [REQUIRED_FIELD_MISSING]"
        );
    });

    test("falls back to Reason when ErrorList is empty", () => {
        const err = Object.assign(new Error("UnknownError"), {
            name: "ValidationException",
            Reason: "Opportunity is in a locked review state",
            ErrorList: [],
        });
        expect(formatAceError(err)).toBe(
            "ValidationException: Opportunity is in a locked review state"
        );
    });

    test("falls back to a meaningful message, ignoring the UnknownError noise", () => {
        const withMessage = Object.assign(new Error("boom"), {
            name: "ValidationException",
        });
        expect(formatAceError(withMessage)).toBe("boom");

        const onlyUnknown = Object.assign(new Error("UnknownError"), {
            name: "ValidationException",
        });
        // No ErrorList / Reason / meaningful message → name the exception type.
        expect(formatAceError(onlyUnknown)).toBe("ValidationException");
    });

    test("handles non-object inputs defensively", () => {
        expect(formatAceError("raw string error")).toBe("raw string error");
        expect(formatAceError(undefined)).toBe("unknown error");
        expect(formatAceError(null)).toBe("unknown error");
    });
});
