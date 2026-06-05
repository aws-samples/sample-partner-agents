/**
 * HubSpot CRM wrapper for the Share / Refresh serverless functions
 * (Requirements 1.3, 4.8, 6.6).
 *
 * Provides three operations the handlers need:
 *   - `readDealProperties(dealId, propertyNames)` — fetch deal properties.
 *   - `readAssociatedCompany(dealId)` — fetch the primary associated
 *     company's properties.
 *   - `writeDealProperties(dealId, properties)` — patch deal properties.
 *
 * The wrapper is returned as a plain object type (`HubspotClient`) rather
 * than a class so call sites can mock it in Vitest with a literal record —
 * no subclassing of the SDK's discovery machinery required. The underlying
 * `@hubspot/api-client` `Client` is injectable via the optional `injected`
 * parameter for the same reason.
 *
 * ## Null normalisation
 *
 * The HubSpot REST shape `SimplePublicObjectWithAssociations.properties`
 * is `Record<string, string | null>`. Our `DealProps` / `CompanyProps`
 * types (in `preconditions.ts`) model missing values as `string |
 * undefined`, matching how HubSpot historically surfaced unset properties
 * and how the Python sync treats them. This module normalises `null →
 * undefined` at the boundary so no downstream code has to think about the
 * difference.
 *
 * ## Associated-company lookup
 *
 * ACE only needs the deal's primary associated company. Rather than make
 * two round-trips (one to list associations, one to read the company), we
 * use `deals.basicApi.getById(dealId, [], undefined, ["companies"])` which
 * returns both the deal and its `associations.companies.results` in a
 * single call, then fetch the first (primary) company by id via
 * `companies.basicApi.getById`. This keeps the request count low and
 * avoids pulling in the v4 associations API factory.
 *
 * ## Error surfacing
 *
 * Raw HubSpot 4xx / 5xx responses surface through the SDK as rejected
 * promises (the SDK's `HttpError` / `ApiException` shape). Callers decide
 * how to map those to `HUBSPOT_WRITE` / `HUBSPOT_READ` error codes in
 * their response envelope — this module does not catch or rewrap them.
 */

import { Client } from "@hubspot/api-client";

import type { CompanyProps, DealProps } from "./preconditions";

/**
 * Company properties we care about when building an ACE create / update
 * payload. Mirrors the set consumed by `payload.ts:buildCustomerAccount`
 * and `buildWebsiteUrl`. Add fields here if the payload builder grows new
 * dependencies on the company record.
 */
export const COMPANY_READ_PROPERTIES: readonly string[] = [
  "name",
  "hs_country_code",
  "city",
  "zip",
  "state",
  "website",
  "domain",
] as const;

/**
 * Public surface of the HubSpot wrapper. Expressed as a plain object type
 * so tests can substitute a literal record without importing any SDK
 * internals.
 */
export type HubspotClient = {
  /**
   * Fetch the named properties for a single deal. Missing values come back
   * as `undefined` (HubSpot returns `null` over the wire; we normalise).
   */
  readDealProperties(
    dealId: number,
    propertyNames: string[]
  ): Promise<DealProps>;

  /**
   * Fetch the primary associated company for a deal, populated with the
   * properties required by the payload builder. Returns `undefined` when
   * the deal has no associated company — preconditions will then flag the
   * missing `hs_country_code` on the create path.
   */
  readAssociatedCompany(dealId: number): Promise<CompanyProps>;

  /**
   * Patch deal properties. The SDK wraps this as a PATCH under the hood.
   * Resolves on HTTP 2xx; rejects on any non-2xx, leaving mapping to
   * `HUBSPOT_WRITE` up to the caller.
   */
  writeDealProperties(
    dealId: number,
    properties: Record<string, string>
  ): Promise<void>;

  /**
   * Find the HubSpot deal id (if any) carrying `ace_opportunity_id ==
   * aceOpportunityId`. Used by the EventBridge-driven pull Lambda to
   * decide between auto-refresh and auto-create. Returns `undefined`
   * when no deal carries the id; HubSpot's strict equality means there
   * should never be more than one match.
   */
  findDealByAceOpportunityId(
    aceOpportunityId: string
  ): Promise<number | undefined>;

  /**
   * Create a new deal with the supplied property bag. The HubSpot id of
   * the freshly-created deal is returned.
   */
  createDeal(properties: Record<string, string>): Promise<number>;
};

/**
 * Normalise a `Record<string, string | null>` (HubSpot SDK shape) into
 * `Record<string, string | undefined>` (the shape `DealProps` /
 * `CompanyProps` use). `null` and `undefined` both mean "not set" for our
 * purposes, and collapsing them here keeps downstream code from having to
 * handle both cases.
 */
function normaliseProperties(
  raw: Record<string, string | null> | undefined
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    out[key] = value === null ? undefined : value;
  }
  return out;
}

/**
 * Build a `HubspotClient` bound to `privateAppToken`. Pass `injected` to
 * substitute a pre-constructed `Client` in tests; in production the
 * serverless function lets this function construct the real SDK client
 * from the token loaded via `loadConfig`.
 *
 * @param privateAppToken  HubSpot private-app access token.
 * @param injected         Optional pre-built SDK client (test seam).
 */
export function createHubspotClient(
  privateAppToken: string,
  injected?: Client
): HubspotClient {
  const client = injected ?? new Client({ accessToken: privateAppToken });

  async function readDealProperties(
    dealId: number,
    propertyNames: string[]
  ): Promise<DealProps> {
    // `getById(dealId, properties, propertiesWithHistory?, associations?, archived?, idProperty?)`.
    const response = await client.crm.deals.basicApi.getById(
      String(dealId),
      propertyNames
    );
    return normaliseProperties(response.properties) as DealProps;
  }

  async function readAssociatedCompany(
    dealId: number
  ): Promise<CompanyProps> {
    // Single round-trip: ask for the deal with its company associations
    // inlined. We don't need any deal properties here — the empty
    // `properties` array keeps the payload tiny.
    const deal = await client.crm.deals.basicApi.getById(
      String(dealId),
      [],
      undefined,
      ["companies"]
    );
    const results = deal.associations?.companies?.results ?? [];
    if (results.length === 0) return undefined;
    // HubSpot returns associations in insertion order; the first result is
    // the primary company for the deal. Multi-company deals are rare and
    // handled by the same convention the Python sync uses.
    const companyId = results[0].id;

    const company = await client.crm.companies.basicApi.getById(
      companyId,
      // Cast to a mutable `string[]` — the SDK types the parameter as
      // `Array<string>` rather than `readonly string[]`.
      [...COMPANY_READ_PROPERTIES]
    );
    return normaliseProperties(company.properties) as CompanyProps;
  }

  async function writeDealProperties(
    dealId: number,
    properties: Record<string, string>
  ): Promise<void> {
    // `update(dealId, { properties })`. The SDK's `SimplePublicObjectInput`
    // is a class, but its shape is literally `{ properties }`; passing a
    // plain object matches the runtime contract and keeps the callers
    // free of SDK imports.
    await client.crm.deals.basicApi.update(String(dealId), { properties });
  }

  async function findDealByAceOpportunityId(
    aceOpportunityId: string
  ): Promise<number | undefined> {
    // `searchApi.doSearch` runs a CRM search against the deal index.
    // We key off `ace_opportunity_id` (HubSpot's strict EQ operator);
    // the index propagates within seconds of an `update` so the
    // EventBridge-driven pull workflow doesn't double-create when an
    // `Opportunity Created` event lands a few seconds before its
    // following `Opportunity Updated`.
    const response = await client.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "ace_opportunity_id",
              operator: "EQ",
              value: aceOpportunityId,
            } as never,
          ],
        },
      ],
      properties: ["ace_opportunity_id"],
      limit: 1,
      after: 0 as unknown as string,
      sorts: [],
    } as never);
    const results = response.results ?? [];
    if (results.length === 0) return undefined;
    return Number(results[0].id);
  }

  async function createDeal(
    properties: Record<string, string>
  ): Promise<number> {
    // `create({ properties, associations? })`. We don't set associations
    // here — the rep links a company / contacts to the deal manually
    // after the auto-pull runs. Doing it now would require an extra
    // company-search step that's out of scope.
    const created = await client.crm.deals.basicApi.create({
      properties,
      associations: [],
    } as never);
    return Number(created.id);
  }

  return {
    readDealProperties,
    readAssociatedCompany,
    writeDealProperties,
    findDealByAceOpportunityId,
    createDeal,
  };
}
