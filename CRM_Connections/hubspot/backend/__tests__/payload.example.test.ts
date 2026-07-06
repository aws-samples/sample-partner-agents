import { describe, test, expect } from "vitest";
import {
  buildCreatePayload,
  buildUpdatePayload,
} from "../lib/payload";
import type { StageMapping } from "../lib/stage-mapping";
import type { DealProps, CompanyProps } from "../lib/preconditions";

// Feature: hubspot-ace-share-refresh-buttons
// Example tests for the ACE payload builders. These verify the full design.md
// §Payload mapping table shape without doing PBT — the transformations are
// finite, structural, and best asserted by hand.
//
// Requirements covered: 2.5, 2.6, 3.2, 3.3

type SpendLine = {
  Amount: string;
  CurrencyCode: string;
  Frequency: string;
  TargetCompany: string;
};

const MAPPING: StageMapping = {
  qualified: "Qualified",
  techvalid: "Technical Validation",
  bizvalid: "Business Validation",
  committed: "Committed",
  launched: "Launched",
  closedlost: "Closed Lost",
};

function baseDeal(): DealProps {
  return {
    dealstage: "qualified",
    dealname: "Acme Migration",
    amount: "12000",
    contract_term__months_: "12",
    closedate: "2025-12-15",
    description: "Customer needs to migrate SAP to AWS cloud.",
    // Previously-defaulted fields are now deal-property-driven. A fully
    // populated base deal lets the create/update tests assert real values;
    // the "minimal deal omits everything" test below proves nothing is
    // injected when these are blank.
    ace_currency_code: "USD",
    ace_industry: "Software and Internet",
    ace_delivery_model: "SaaS or PaaS",
    ace_customer_use_case: "Business Applications & Contact Center",
    ace_primary_need_from_aws: "Co-Sell - Architectural Validation",
    ace_opportunity_type: "Net New Business",
    ace_national_security: "No",
    hs_next_step: "Discuss with AWS",
  };
}

function baseCompany(): CompanyProps {
  return {
    name: "Acme Corp",
    hs_country_code: "US",
    state: "WA",
    zip: "98101",
  };
}

describe("buildCreatePayload", () => {
  test("emits only deal-driven fields + derived ClientToken for dealId=12345 (no hardcoded defaults)", () => {
    const payload = buildCreatePayload(
      12345,
      baseDeal(),
      baseCompany(),
      MAPPING,
      {}
    );
    expect(payload.Catalog).toBe("Sandbox");
    // Cross-language verified with Python uuid.uuid5 (PAYLOAD_VERSION="v6"):
    //   uuid.uuid5(uuid.NAMESPACE_URL, "hubspot-deal-12345-v6")
    //   → 4e848cd7-2c56-5f88-b8c8-160af5cf1b45
    expect(payload.ClientToken).toBe("4e848cd7-2c56-5f88-b8c8-160af5cf1b45");
    // PartnerOpportunityIdentifier is REQUIRED for ACE to populate
    // Lifecycle.ReviewStatus on Create. We use the dealId stringified.
    expect(payload.PartnerOpportunityIdentifier).toBe("12345");
    // `Origin` is no longer sent at all (was hardcoded "Partner Referral").
    expect((payload as Record<string, unknown>).Origin).toBeUndefined();
    // OpportunityType / PrimaryNeedsFromAws / NationalSecurity now flow from
    // the deal properties — not hardcoded constants.
    expect(payload.OpportunityType).toBe("Net New Business");
    expect(payload.PrimaryNeedsFromAws).toEqual([
      "Co-Sell - Architectural Validation",
    ]);
    expect(payload.NationalSecurity).toBe("No");
    // Marketing is omitted entirely when ace_marketing_source is blank
    // (no "None" default).
    expect(payload.Marketing).toBeUndefined();

    // Create stage reflects the deal's OWN mapped stage (no hardcoded
    // "Qualified"). NextSteps comes from hs_next_step (omitted when blank).
    expect(payload.LifeCycle.Stage).toBe("Qualified");
    expect(payload.LifeCycle.NextSteps).toBe("Discuss with AWS");
    expect(payload.LifeCycle.TargetCloseDate).toBe("2025-12-15");

    expect(payload.Project.Title).toBe("Acme Migration");
    expect(payload.Project.CustomerBusinessProblem).toBe(
      "Customer needs to migrate SAP to AWS cloud."
    );
    expect(payload.Project.DeliveryModels).toEqual(["SaaS or PaaS"]);
    expect(payload.Project.CustomerUseCase).toBe(
      "Business Applications & Contact Center"
    );
    // SalesActivities is omitted when ace_sales_activities is blank
    // (no canned "Initialized discussions…" default).
    expect(payload.Project.SalesActivities).toBeUndefined();

    const spend = (payload.Project.ExpectedCustomerSpend as SpendLine[])[0];
    expect(spend).toEqual({
      Amount: "1000",
      CurrencyCode: "USD",
      Frequency: "Monthly",
      TargetCompany: "Acme Corp",
    });

    const account = payload.Customer.Account;
    expect(account.CompanyName).toBe("Acme Corp");
    expect(account.Industry).toBe("Software and Internet");
    expect(account.Address).toEqual({
      CountryCode: "US",
      PostalCode: "98101",
      StateOrRegion: "WA",
    });
  });

  test("minimal deal omits every optional field (no hardcoded defaults injected)", () => {
    // A deal with only the structurally-required fields populated must
    // produce a payload that carries NONE of the previously-defaulted
    // values. This is the core no-defaults guarantee.
    const minimal: DealProps = {
      dealstage: "qualified",
      dealname: "Bare Deal",
      amount: "12000",
      contract_term__months_: "12",
      closedate: "2025-12-15",
      description: "Customer needs to migrate SAP to AWS cloud.",
    };
    const payload = buildCreatePayload(1, minimal, baseCompany(), MAPPING, {});

    expect((payload as Record<string, unknown>).Origin).toBeUndefined();
    expect(payload.OpportunityType).toBeUndefined();
    expect(payload.Marketing).toBeUndefined();
    expect(payload.PrimaryNeedsFromAws).toBeUndefined();
    expect(payload.NationalSecurity).toBeUndefined();
    expect(payload.Project.DeliveryModels).toBeUndefined();
    expect(payload.Project.CustomerUseCase).toBeUndefined();
    expect(payload.Project.SalesActivities).toBeUndefined();
    expect(payload.LifeCycle.NextSteps).toBeUndefined();
    expect(payload.Customer.Account.Industry).toBeUndefined();
    // CurrencyCode dropped from the spend line when ace_currency_code blank.
    const spend = (payload.Project.ExpectedCustomerSpend as Partial<SpendLine>[])[0];
    expect(spend.CurrencyCode).toBeUndefined();
    expect(spend.Amount).toBe("1000");
    expect(spend.Frequency).toBe("Monthly");
  });

  test("create stage reflects the deal's mapped stage (no hardcoded Qualified)", () => {
    const deal = { ...baseDeal(), dealstage: "techvalid" };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.LifeCycle.Stage).toBe("Technical Validation");
  });

  test("create throws when the deal's stage cannot be mapped", () => {
    const deal = { ...baseDeal(), dealstage: "bogus-stage" };
    expect(() =>
      buildCreatePayload(1, deal, baseCompany(), MAPPING, {})
    ).toThrow();
  });

  test("Project.Title is the dealname verbatim (no 'Partner Opportunity' default)", () => {
    const deal = { ...baseDeal(), dealname: "New Title from Deal" };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.Title).toBe("New Title from Deal");
  });

  test("Project.Title is empty when dealname is blank (precondition gates this upstream)", () => {
    const deal = { ...baseDeal(), dealname: "  " };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.Title).toBe("");
  });

  test("CustomerUseCase: per-deal property takes precedence over env default", () => {
    const deal = {
      ...baseDeal(),
      ace_customer_use_case: "Containers & Serverless",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {
      aceDefaultUseCase: "Database",
    });
    expect(payload.Project.CustomerUseCase).toBe("Containers & Serverless");
  });

  test("CustomerUseCase: env default applies when per-deal property is empty", () => {
    const deal = { ...baseDeal(), ace_customer_use_case: "  " };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {
      aceDefaultUseCase: "Database",
    });
    expect(payload.Project.CustomerUseCase).toBe("Database");
  });

  test("CustomerUseCase: omitted when neither per-deal nor env is set (no hard default)", () => {
    const deal = { ...baseDeal(), ace_customer_use_case: "" };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.CustomerUseCase).toBeUndefined();
  });

  test("Marketing.Source: 'Yes' translates to 'Marketing Activity'; AwsFundingUsed flows from the deal", () => {
    const deal = {
      ...baseDeal(),
      ace_marketing_source: "Yes",
      ace_aws_funding_used: "No",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Marketing?.Source).toBe("Marketing Activity");
    expect(payload.Marketing?.AwsFundingUsed).toBe("No");
  });

  test("Marketing.Source: legacy literal 'Marketing Activity' passes through", () => {
    const deal = {
      ...baseDeal(),
      ace_marketing_source: "Marketing Activity",
      ace_aws_funding_used: "Yes",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Marketing?.Source).toBe("Marketing Activity");
    expect(payload.Marketing?.AwsFundingUsed).toBe("Yes");
  });

  test("Marketing.Source: 'No' on the deal maps to 'None' with no AwsFundingUsed", () => {
    const deal = { ...baseDeal(), ace_marketing_source: "No" };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Marketing).toEqual({ Source: "None" });
  });

  test("Marketing.Source: env default applies when per-deal is blank", () => {
    const payload = buildCreatePayload(1, baseDeal(), baseCompany(), MAPPING, {
      aceDefaultMarketingSource: "Yes",
      aceDefaultAwsFundingUsed: "No",
    });
    expect(payload.Marketing?.Source).toBe("Marketing Activity");
    expect(payload.Marketing?.AwsFundingUsed).toBe("No");
  });

  test("Marketing is omitted entirely when nothing is set (no 'None' default)", () => {
    // baseDeal carries no ace_marketing_source and the config is empty.
    const payload = buildCreatePayload(1, baseDeal(), baseCompany(), MAPPING, {});
    expect(payload.Marketing).toBeUndefined();
  });

  test("optional address fields flow to Customer.Account.Address", () => {
    const company = {
      ...baseCompany(),
      city: "Seattle",
      zip: "98101",
      state: "WA",
    };
    const payload = buildCreatePayload(1, baseDeal(), company, MAPPING, {});
    expect(payload.Customer.Account.Address).toEqual({
      CountryCode: "US",
      City: "Seattle",
      PostalCode: "98101",
      StateOrRegion: "WA",
    });
  });

  test("ace_sales_activities override flows to Project.SalesActivities", () => {
    const deal = {
      ...baseDeal(),
      ace_sales_activities:
        "Initialized discussions with customer;Conducted POC / Demo",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.SalesActivities).toEqual([
      "Initialized discussions with customer",
      "Conducted POC / Demo",
    ]);
  });

  test("blank ace_sales_activities omits Project.SalesActivities (no canned default)", () => {
    const deal = { ...baseDeal(), ace_sales_activities: "" };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.SalesActivities).toBeUndefined();
  });

  test("editable Project fields are omitted when blank (no empty strings on wire)", () => {
    const payload = buildCreatePayload(1, baseDeal(), baseCompany(), MAPPING, {});
    expect(payload.Project.AdditionalComments).toBeUndefined();
    expect(payload.Project.OtherCompetitorNames).toBeUndefined();
    expect(payload.Project.OtherSolutionDescription).toBeUndefined();
    expect(payload.Project.CompetitorName).toBeUndefined();
    expect(payload.Project.AwsPartition).toBeUndefined();
    expect(payload.Project.ApnPrograms).toBeUndefined();
  });

  test("editable Project fields land on the wire when set", () => {
    const deal: DealProps = {
      ...baseDeal(),
      ace_additional_comments: "extra info",
      ace_other_competitor_names: "Acme Cloud",
      ace_other_solution_description: "custom thing",
      ace_competitor_name: "*Other",
      ace_aws_partition: "aws-eusc",
      ace_apn_programs: "Well-Architected;Windows",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.AdditionalComments).toBe("extra info");
    expect(payload.Project.OtherCompetitorNames).toBe("Acme Cloud");
    expect(payload.Project.OtherSolutionDescription).toBe("custom thing");
    expect(payload.Project.CompetitorName).toBe("*Other");
    expect(payload.Project.AwsPartition).toBe("aws-eusc");
    expect(payload.Project.ApnPrograms).toEqual([
      "Well-Architected",
      "Windows",
    ]);
  });

  test("Customer.Account.AwsAccountId / Duns / StreetAddress are omitted when blank", () => {
    const payload = buildCreatePayload(1, baseDeal(), baseCompany(), MAPPING, {});
    expect(payload.Customer.Account.AwsAccountId).toBeUndefined();
    expect(payload.Customer.Account.Duns).toBeUndefined();
    const address = payload.Customer.Account.Address as
      | Record<string, string>
      | undefined;
    expect(address?.StreetAddress).toBeUndefined();
  });

  test("Customer.Account regex-validated overrides land on the wire when set", () => {
    const deal: DealProps = {
      ...baseDeal(),
      ace_aws_account_id: "123456789012",
      ace_duns: "987654321",
      ace_street_address: "1 Infinite Loop",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Customer.Account.AwsAccountId).toBe("123456789012");
    expect(payload.Customer.Account.Duns).toBe("987654321");
    const address = payload.Customer.Account.Address as Record<string, string>;
    expect(address.StreetAddress).toBe("1 Infinite Loop");
  });

  test("website with scheme passes through unchanged", () => {
    const company = { ...baseCompany(), website: "https://acme.io" };
    const payload = buildCreatePayload(1, baseDeal(), company, MAPPING, {});
    expect(payload.Customer.Account.WebsiteUrl).toBe("https://acme.io");
  });

  test("website without scheme gets 'https://' prepended", () => {
    const company = { ...baseCompany(), website: "acme.io" };
    const payload = buildCreatePayload(1, baseDeal(), company, MAPPING, {});
    expect(payload.Customer.Account.WebsiteUrl).toBe("https://acme.io");
  });

  test("domain fallback when no website", () => {
    const company = { ...baseCompany(), domain: "acme.io" };
    const payload = buildCreatePayload(1, baseDeal(), company, MAPPING, {});
    expect(payload.Customer.Account.WebsiteUrl).toBe("https://acme.io");
  });

  test("ace_website_url on the deal wins over the company website", () => {
    const company = { ...baseCompany(), website: "https://from-company.io" };
    const deal = { ...baseDeal(), ace_website_url: "deal-site.com" };
    const payload = buildCreatePayload(1, deal, company, MAPPING, {});
    expect(payload.Customer.Account.WebsiteUrl).toBe("https://deal-site.com");
  });

  test("monthly amount: whole-number result formatted as integer", () => {
    const deal = { ...baseDeal(), amount: "1500", contract_term__months_: "3" };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    const spend = (payload.Project.ExpectedCustomerSpend as SpendLine[])[0];
    expect(spend.Amount).toBe("500");
  });

  test("monthly amount: fractional result formatted to 2dp", () => {
    const deal = {
      ...baseDeal(),
      amount: "1234.5",
      contract_term__months_: "2",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    const spend = (payload.Project.ExpectedCustomerSpend as SpendLine[])[0];
    expect(spend.Amount).toBe("617.25");
  });

  test("monthly amount: contract_term__months_ of 0 defaults to 12", () => {
    const deal = {
      ...baseDeal(),
      amount: "5000",
      contract_term__months_: "0",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    const spend = (payload.Project.ExpectedCustomerSpend as SpendLine[])[0];
    expect(spend.Amount).toBe("416.67");
  });

  test("20-char description preserved verbatim in CustomerBusinessProblem", () => {
    // "This is 20 chars ok." is exactly 20 characters — the minimum accepted
    // by the create-path precondition (R2.2 rule 4).
    const deal = {
      ...baseDeal(),
      description: "This is 20 chars ok.",
    };
    const payload = buildCreatePayload(1, deal, baseCompany(), MAPPING, {});
    expect(payload.Project.CustomerBusinessProblem).toBe("This is 20 chars ok.");
  });

  test("ExpectedCustomerSpend.TargetCompany falls back through company → ace_company_name → 'AWS'", () => {
    // AWS validates TargetCompany against `(?s).{1,80}`. An empty
    // string fails INVALID_STRING_FORMAT — the fix is a 3-level
    // fallback so the field always carries something non-empty.
    // Case 1: associated company name wins.
    const deal1 = baseDeal();
    let p = buildCreatePayload(1, deal1, baseCompany(), MAPPING, {});
    expect(
      (p.Project.ExpectedCustomerSpend as SpendLine[])[0].TargetCompany
    ).toBe("Acme Corp");

    // Case 2: no company → deal-level ace_company_name takes over.
    const deal2 = { ...baseDeal(), ace_company_name: "Reverse-synced Co" };
    p = buildCreatePayload(1, deal2, undefined, MAPPING, {});
    expect(
      (p.Project.ExpectedCustomerSpend as SpendLine[])[0].TargetCompany
    ).toBe("Reverse-synced Co");

    // Case 3: neither → "AWS" sentinel keeps the request valid.
    const deal3 = baseDeal();
    p = buildCreatePayload(1, deal3, undefined, MAPPING, {});
    expect(
      (p.Project.ExpectedCustomerSpend as SpendLine[])[0].TargetCompany
    ).toBe("AWS");
  });

  test("TargetCompany is truncated to 80 chars (regex max)", () => {
    const longName = "A".repeat(120);
    const deal = { ...baseDeal(), ace_company_name: longName };
    const p = buildCreatePayload(1, deal, undefined, MAPPING, {});
    expect(
      (p.Project.ExpectedCustomerSpend as SpendLine[])[0].TargetCompany,
    ).toHaveLength(80);
  });
});

describe("buildUpdatePayload", () => {
  test("forward-maps stage and attaches matching NextSteps", () => {
    const deal = { ...baseDeal(), dealstage: "techvalid" };
    const payload = buildUpdatePayload(
      99,
      deal,
      baseCompany(),
      "O-123",
      "2025-04-29T12:00:00Z",
      MAPPING
    );
    expect(payload.Catalog).toBe("Sandbox");
    expect(payload.Identifier).toBe("O-123");
    expect(payload.LastModifiedDate).toBe("2025-04-29T12:00:00Z");
    expect(payload.LifeCycle.Stage).toBe("Technical Validation");
    expect(payload.LifeCycle.NextSteps).toBe("Discuss with AWS");
    // Update preserves the partner-side identifier so ACE keeps the
    // opportunity's submission state coherent.
    expect(payload.PartnerOpportunityIdentifier).toBe("99");
  });

  test("Closed Lost stage maps correctly", () => {
    const deal = { ...baseDeal(), dealstage: "closedlost" };
    const payload = buildUpdatePayload(
      99,
      deal,
      baseCompany(),
      "O-999",
      "2025-04-29T12:00:00Z",
      MAPPING
    );
    expect(payload.LifeCycle.Stage).toBe("Closed Lost");
    expect(payload.LifeCycle.NextSteps).toBe("Discuss with AWS");
  });

  test("ace_closed_lost_reason is sent only when stage is Closed Lost", () => {
    // Non-Closed-Lost stage: reason is dropped even when set on the deal.
    const dealQualified = {
      ...baseDeal(),
      dealstage: "qualified",
      ace_closed_lost_reason: "Price",
    };
    const payloadQualified = buildUpdatePayload(
      99,
      dealQualified,
      baseCompany(),
      "O-1",
      "D",
      MAPPING
    );
    expect(payloadQualified.LifeCycle.ClosedLostReason).toBeUndefined();

    // Closed Lost stage: reason flows through.
    const dealLost = {
      ...baseDeal(),
      dealstage: "closedlost",
      ace_closed_lost_reason: "Price",
    };
    const payloadLost = buildUpdatePayload(
      99,
      dealLost,
      baseCompany(),
      "O-2",
      "D",
      MAPPING
    );
    expect(payloadLost.LifeCycle.ClosedLostReason).toBe("Price");
  });

  test("unmapped dealstage throws", () => {
    const deal = { ...baseDeal(), dealstage: "unknown" };
    expect(() =>
      buildUpdatePayload(99, deal, baseCompany(), "O-1", "2025-04-29T12:00:00Z", MAPPING)
    ).toThrow();
  });

  test("update payload carries TargetCloseDate, Title, ExpectedCustomerSpend, Customer", () => {
    const payload = buildUpdatePayload(99, baseDeal(), baseCompany(), "O-1", "D", MAPPING);
    expect(payload.LifeCycle.TargetCloseDate).toBe("2025-12-15");
    expect(payload.Project.Title).toBe("Acme Migration");
    const spend = (payload.Project.ExpectedCustomerSpend as SpendLine[])[0];
    expect(spend).toMatchObject({
      Amount: "1000",
      CurrencyCode: "USD",
      Frequency: "Monthly",
      TargetCompany: "Acme Corp",
    });
    expect(payload.Customer.Account.CompanyName).toBe("Acme Corp");
  });

  test("Customer block uses lockedCustomer verbatim when ReviewStatus locks the opportunity", () => {
    // ACE rejects any change to `Customer.Account.*` once the opp is
    // past "Pending Submission" / "Action Required" (ACTION_NOT_PERMITTED),
    // but ALSO requires the block to be present and fully populated
    // (REQUIRED_FIELD_MISSING). The fix is to send AWS's existing
    // values verbatim, which the caller lifts from `GetOpportunity`
    // and passes via `options.lockedCustomer`. Each locked state below
    // was confirmed empirically against the Sandbox catalog.
    //
    // Submitted / In Review aren't tested here — those states are
    // caught by the orchestrator (`core/run-share.ts`) and never
    // reach buildUpdatePayload, because AWS blocks every update
    // during the review window.
    const lockedCustomer = {
      Account: {
        CompanyName: "Existing Inc",
        WebsiteUrl: "https://existing.example",
        Industry: "Software",
        Address: {
          CountryCode: "US",
          PostalCode: "98101",
          StateOrRegion: "WA",
        },
      },
      Contacts: [
        { FirstName: "Jo", LastName: "Doe", Email: "jo@existing.example" },
      ],
    };
    for (const reviewStatus of [
      "Approved",
      "Disqualified",
      "Action Required",
    ]) {
      const payload = buildUpdatePayload(
        99,
        baseDeal(),
        baseCompany(),
        "O-1",
        "D",
        MAPPING,
        {},
        { reviewStatus, lockedCustomer }
      );
      // Verbatim passthrough — neither buildCustomerAccount nor any
      // re-derivation from the HubSpot deal/company should run.
      expect(payload.Customer).toEqual(lockedCustomer);
      expect(
        (payload.Customer as typeof lockedCustomer).Account.CompanyName
      ).toBe("Existing Inc");
      // The other re-sent fields stay — they're not affected by the lock.
      expect(payload.OpportunityType).toBe("Net New Business");
      expect(payload.PartnerOpportunityIdentifier).toBe("99");
    }
  });

  test("Customer block falls back to buildCustomerAccount when locked but lockedCustomer omitted", () => {
    // Defensive: if a locked-state Update is invoked without the
    // caller passing `lockedCustomer`, we still emit a Customer block
    // (AWS would otherwise reject for REQUIRED_FIELD_MISSING). The
    // resulting ACTION_NOT_PERMITTED is at least diagnosable, whereas
    // an absent block produces a misleading error cascade.
    const payload = buildUpdatePayload(
      99,
      baseDeal(),
      baseCompany(),
      "O-1",
      "D",
      MAPPING,
      {},
      { reviewStatus: "Approved" }
    );
    expect(payload.Customer).toBeDefined();
    expect(payload.Customer.Account.CompanyName).toBe("Acme Corp");
  });

  test("Customer block IS built from HubSpot when ReviewStatus is editable (Pending Submission, Action Required, blank)", () => {
    for (const reviewStatus of [
      "Pending Submission",
      "Action Required",
      "",
      undefined as unknown as string,
    ]) {
      const payload = buildUpdatePayload(
        99,
        baseDeal(),
        baseCompany(),
        "O-1",
        "D",
        MAPPING,
        {},
        { reviewStatus }
      );
      expect(payload.Customer).toBeDefined();
      expect(payload.Customer.Account.CompanyName).toBe("Acme Corp");
    }
  });

  test("lockedCustomer is ignored when ReviewStatus is editable", () => {
    // Defensive: even if the caller passes `lockedCustomer` for an
    // unlocked state, the build path should still derive the block
    // from the HubSpot deal so user edits flow through.
    const lockedCustomer = {
      Account: { CompanyName: "Existing Inc" },
    };
    const payload = buildUpdatePayload(
      99,
      baseDeal(),
      baseCompany(),
      "O-1",
      "D",
      MAPPING,
      {},
      { reviewStatus: "Pending Submission", lockedCustomer }
    );
    expect(payload.Customer.Account.CompanyName).toBe("Acme Corp");
  });

  test("SoftwareRevenue is passed through verbatim when locked, omitted otherwise", () => {
    // AWS locks every SoftwareRevenue.* sub-field once the opp leaves
    // Pending Submission / Action Required and rejects "absent" as a
    // clear attempt (ACTION_NOT_PERMITTED on each sub-field). The fix
    // is the same as the Customer block: pass AWS's existing values
    // through verbatim.
    const lockedSoftwareRevenue = {
      DeliveryModel: "Pay-as-you-go",
      Value: { Amount: "6000.0", CurrencyCode: "USD" },
      EffectiveDate: "2026-05-20",
      ExpirationDate: "2027-05-20",
    };
    for (const reviewStatus of [
      "Approved",
      "Disqualified",
      "Action Required",
    ]) {
      const payload = buildUpdatePayload(
        99,
        baseDeal(),
        baseCompany(),
        "O-1",
        "D",
        MAPPING,
        {},
        { reviewStatus, lockedSoftwareRevenue }
      );
      expect(
        (payload as { SoftwareRevenue?: unknown }).SoftwareRevenue
      ).toEqual(lockedSoftwareRevenue);
    }
    // Unlocked state → field omitted (never built from the deal).
    const editable = buildUpdatePayload(
      99,
      baseDeal(),
      baseCompany(),
      "O-1",
      "D",
      MAPPING,
      {},
      { reviewStatus: "Pending Submission", lockedSoftwareRevenue }
    );
    expect(
      (editable as { SoftwareRevenue?: unknown }).SoftwareRevenue
    ).toBeUndefined();
    // No lockedSoftwareRevenue + locked state → still omitted (we
    // don't fabricate a block from nothing).
    const noPassthrough = buildUpdatePayload(
      99,
      baseDeal(),
      baseCompany(),
      "O-1",
      "D",
      MAPPING,
      {},
      { reviewStatus: "Approved" }
    );
    expect(
      (noPassthrough as { SoftwareRevenue?: unknown }).SoftwareRevenue
    ).toBeUndefined();
  });
});

import {
  snapshotFromOpportunity,
  snapshotToProps,
} from "../core/run-share";

describe("snapshotToProps round-trip (Refresh writes AWS → HubSpot)", () => {
  test("AWS TargetCloseDate flows back into HubSpot closedate", () => {
    const opp = {
      LifeCycle: { TargetCloseDate: "2026-09-30", Stage: "Prospect" },
    };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal());
    expect(props.closedate).toBe("2026-09-30");
  });

  test("AWS monthly spend × contract term → HubSpot amount", () => {
    const opp = {
      Project: {
        ExpectedCustomerSpend: [{ Amount: "142", CurrencyCode: "USD" }],
      },
    };
    const snap = snapshotFromOpportunity(opp, "Synced");
    // Default fixture has contract_term__months_ = "12".
    const props = snapshotToProps(snap, baseDeal());
    expect(props.amount).toBe("1704");
  });

  test("missing AWS spend leaves HubSpot amount untouched", () => {
    const opp = { LifeCycle: { Stage: "Prospect" } };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal());
    expect(props.amount).toBeUndefined();
  });

  test("missing close date leaves HubSpot closedate untouched", () => {
    const opp = { LifeCycle: { Stage: "Prospect" } };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal());
    expect(props.closedate).toBeUndefined();
  });

  test("missing deal arg means closedate / amount are NOT written", () => {
    const opp = {
      LifeCycle: { TargetCloseDate: "2026-09-30" },
      Project: {
        ExpectedCustomerSpend: [{ Amount: "142" }],
      },
    };
    const snap = snapshotFromOpportunity(opp, "Synced");
    // closedate doesn't need the deal — it flows through.
    const props = snapshotToProps(snap);
    expect(props.closedate).toBe("2026-09-30");
    // amount needs the contract term, so without `deal` it's omitted.
    expect(props.amount).toBeUndefined();
  });

  test("AwsOpportunitySummary fields land in the snapshot", () => {
    const opp = {
      LifeCycle: { Stage: "Prospect" },
      RelatedEntityIdentifiers: { Solutions: ["S-0000001", "S-0000002"] },
    };
    const summary = {
      InvolvementType: "Co-Sell",
      Visibility: "Full",
      // Solutions on the summary is fallback-only — the GetOpportunity
      // value above wins.
      RelatedEntityIds: { Solutions: ["S-IGNORED"] },
    };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_involvement_type).toBe("Co-Sell");
    expect(props.ace_visibility).toBe("Full");
    expect(props.ace_solutions).toBe("S-0000001;S-0000002");
  });

  test("Solutions falls back to the summary when GetOpportunity has none", () => {
    const opp = { LifeCycle: { Stage: "Prospect" } };
    const summary = {
      RelatedEntityIds: { Solutions: ["S-FROM-SUMMARY"] },
    };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_solutions).toBe("S-FROM-SUMMARY");
  });

  test("missing summary omits InvolvementType / Visibility / Solutions (non-destructive)", () => {
    // Non-destructive reverse-sync: when AWS has no value for a
    // partner-editable input, snapshotToProps OMITS the key rather than
    // writing "", so a locally-set value on the deal is preserved. This
    // is what lets a partner populate involvement/visibility and submit
    // without Refresh wiping them first.
    const opp = { LifeCycle: { Stage: "Prospect" } };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal()) as Record<string, string>;
    expect("ace_involvement_type" in props).toBe(false);
    expect("ace_visibility" in props).toBe(false);
    expect("ace_solutions" in props).toBe(false);
  });

  test("AwsOpportunitySummary.OpportunityTeam → AWS-team mirror fields", () => {
    // Mirrors what the Python batch's `_reverse_sync_aws_contacts`
    // writes. Each AWS-side role surfaces as
    // `"<First> <Last> (<email>)"`, plus a separate email-only mirror
    // for AM and Sales Rep. Roles AWS hasn't assigned yet stay blank.
    const opp = { LifeCycle: { Stage: "Qualified" } };
    const summary = {
      OpportunityTeam: [
        {
          BusinessTitle: "AWSAccountOwner",
          FirstName: "Alex",
          LastName: "Reviewer",
          Email: "alex@aws.example",
        },
        {
          BusinessTitle: "AWSSalesRep",
          FirstName: "Sam",
          LastName: "Sales",
          Email: "sam@aws.example",
        },
        {
          BusinessTitle: "PSM",
          FirstName: "Pat",
          LastName: "Smith",
          // No email — display falls back to just the name.
        },
        {
          BusinessTitle: "PDM",
          FirstName: "Dana",
          LastName: "Dev",
          Email: "dana@aws.example",
        },
        // Roles outside the documented enum are ignored.
        {
          BusinessTitle: "UnknownRole",
          FirstName: "Skip",
          LastName: "Me",
        },
      ],
    };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());

    expect(props.ace_aws_account_manager).toBe(
      "Alex Reviewer (alex@aws.example)"
    );
    expect(props.ace_aws_account_manager_email).toBe("alex@aws.example");
    expect(props.ace_aws_sales_rep).toBe("Sam Sales (sam@aws.example)");
    expect(props.ace_aws_sales_rep_email).toBe("sam@aws.example");
    // PSM has no email → display omits the parenthesised email.
    expect(props.ace_aws_partner_sales_manager).toBe("Pat Smith");
    expect(props.ace_aws_partner_development_manager).toBe(
      "Dana Dev (dana@aws.example)"
    );
  });

  test("public-sector role aliases collapse to the same partner-side fields", () => {
    // WWPSPDM (public-sector PSM) and ISVSM (ISV success manager)
    // surface as the standard PSM / PDM HubSpot fields so the same
    // deal layout serves all partner types.
    const opp = { LifeCycle: { Stage: "Qualified" } };
    const summary = {
      OpportunityTeam: [
        {
          BusinessTitle: "WWPSPDM",
          FirstName: "Pub",
          LastName: "Sector",
          Email: "pub@aws.example",
        },
        {
          BusinessTitle: "ISVSM",
          FirstName: "Isv",
          LastName: "Manager",
          Email: "isv@aws.example",
        },
      ],
    };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_aws_partner_sales_manager).toBe(
      "Pub Sector (pub@aws.example)"
    );
    expect(props.ace_aws_partner_development_manager).toBe(
      "Isv Manager (isv@aws.example)"
    );
  });

  test("missing OpportunityTeam leaves AWS-team mirrors blank", () => {
    const opp = { LifeCycle: { Stage: "Prospect" } };
    const snap = snapshotFromOpportunity(opp, "Synced", {});
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_aws_account_manager).toBe("");
    expect(props.ace_aws_account_manager_email).toBe("");
    expect(props.ace_aws_sales_rep).toBe("");
    expect(props.ace_aws_sales_rep_email).toBe("");
    expect(props.ace_aws_partner_sales_manager).toBe("");
    expect(props.ace_aws_partner_development_manager).toBe("");
  });

  test("OpportunityOwner / PartnerAccountManager (live wire role names) populate AWS-team mirrors", () => {
    // Live observation against the Sandbox catalog (May 2026): AWS
    // returns `OpportunityOwner` and `PartnerAccountManager` rather
    // than the documented `AWSAccountOwner` / `PSM` values. Extending
    // the role switch keeps the partner's HubSpot mirror populated.
    const opp = {
      LifeCycle: { Stage: "Prospect" },
      OpportunityTeam: [
        {
          BusinessTitle: "OpportunityOwner",
          FirstName: "Test Acc",
          LastName: "Alliance Lead",
          Email: "lead@aws.example",
        },
        {
          BusinessTitle: "PartnerAccountManager",
          FirstName: "Partner",
          LastName: "Pam",
          Email: "pam@aws.example",
        },
      ],
    };
    const snap = snapshotFromOpportunity(opp, "Synced", {});
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_aws_account_manager).toBe(
      "Test Acc Alliance Lead (lead@aws.example)"
    );
    expect(props.ace_aws_account_manager_email).toBe("lead@aws.example");
    expect(props.ace_aws_partner_sales_manager).toBe(
      "Partner Pam (pam@aws.example)"
    );
  });

  test("OpportunityTeam falls back from summary to GetOpportunity when summary is empty", () => {
    // The two AWS endpoints don't always agree on team membership.
    // Live observation: summary returns `OpportunityTeam: []` while
    // GetOpportunity carries the populated list. Snapshot picks the
    // populated source, summary first.
    const opp = {
      LifeCycle: { Stage: "Prospect" },
      OpportunityTeam: [
        {
          BusinessTitle: "OpportunityOwner",
          FirstName: "Live",
          LastName: "Owner",
          Email: "owner@aws.example",
        },
      ],
    };
    const summary = { OpportunityTeam: [] };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_aws_account_manager).toBe(
      "Live Owner (owner@aws.example)"
    );
  });

  test("OpportunityTeam: summary wins when populated, even if opp also has entries", () => {
    // When both sources have data, prefer the summary's team since
    // it's the documented authoritative source. Empirical: this case
    // has been observed for fully-accepted opps where summary was
    // backfilled.
    const opp = {
      LifeCycle: { Stage: "Prospect" },
      OpportunityTeam: [
        {
          BusinessTitle: "OpportunityOwner",
          FirstName: "Stale",
          LastName: "Owner",
          Email: "stale@aws.example",
        },
      ],
    };
    const summary = {
      OpportunityTeam: [
        {
          BusinessTitle: "AWSAccountOwner",
          FirstName: "Fresh",
          LastName: "Owner",
          Email: "fresh@aws.example",
        },
      ],
    };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_aws_account_manager).toBe(
      "Fresh Owner (fresh@aws.example)"
    );
  });

  test("Refresh: Marketing.Source 'Marketing Activity' → HubSpot 'Yes'", () => {
    const opp = { Marketing: { Source: "Marketing Activity", AwsFundingUsed: "Yes" } };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_marketing_source).toBe("Yes");
    expect(props.ace_aws_funding_used).toBe("Yes");
  });

  test("Refresh: Marketing.Source 'None' → HubSpot 'No'", () => {
    const opp = { Marketing: { Source: "None" } };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_marketing_source).toBe("No");
  });

  test("GetOpportunity's LifeCycle.NextSteps wins over the summary's", () => {
    // Real-world precedence: GetOpportunity returns the partner-side
    // editable NextSteps (what Share, Refresh, and the Partner Central
    // Agent all write to). The summary's NextSteps is the AWS-reviewer
    // annotation, which lags edits — using it would clobber a freshly
    // updated value.
    const opp = { LifeCycle: { NextSteps: "from-getopp" } };
    const summary = { LifeCycle: { NextSteps: "from-summary" } };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.hs_next_step).toBe("from-getopp");
  });

  test("Falls back to summary NextSteps when GetOpportunity has none", () => {
    // Symmetric coverage: when the partner-side value is blank we still
    // surface the AWS-reviewer-authored note rather than write an empty
    // string back to HubSpot.
    const opp = { LifeCycle: { NextSteps: "" } };
    const summary = { LifeCycle: { NextSteps: "from-summary" } };
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.hs_next_step).toBe("from-summary");
  });

  test("Falls back to GetOpportunity NextSteps when summary has none", () => {
    const opp = { LifeCycle: { NextSteps: "from-getopp" } };
    const summary = {};
    const snap = snapshotFromOpportunity(opp, "Synced", summary);
    const props = snapshotToProps(snap, baseDeal());
    expect(props.hs_next_step).toBe("from-getopp");
  });

  test("SalesActivities round-trip from AWS to HubSpot multi-select", () => {
    const opp = {
      Project: {
        SalesActivities: [
          "Initialized discussions with customer",
          "Conducted POC / Demo",
        ],
      },
    };
    const snap = snapshotFromOpportunity(opp, "Synced");
    const props = snapshotToProps(snap, baseDeal());
    expect(props.ace_sales_activities).toBe(
      "Initialized discussions with customer;Conducted POC / Demo"
    );
  });
});
