import { describe, test, expect, vi } from "vitest";
import type { Client } from "@hubspot/api-client";

import { createHubspotClient } from "../lib/hubspot";

/**
 * Unit tests for the HubSpot CRM wrapper (task 10.2).
 *
 * The wrapper at `app.functions/lib/hubspot.ts` is a thin adapter around
 * `@hubspot/api-client`'s `Client`. Rather than subclass the SDK's
 * discovery machinery, we build a structural mock with only the methods
 * the wrapper actually calls — `crm.deals.basicApi.getById`,
 * `crm.deals.basicApi.update`, and `crm.companies.basicApi.getById` — and
 * inject it via `createHubspotClient`'s `injected` test seam. This mirrors
 * the approach `ace.test.ts` uses for the ACE SDK wrapper and keeps tests
 * fast, deterministic, and free of network dependencies.
 *
 * Cases covered (per tasks.md §10.2):
 *   1. `readDealProperties` returns normalised DealProps (null → undefined).
 *   2. `readDealProperties` forwards the `propertyNames` array to the SDK.
 *   3. `readAssociatedCompany` returns the primary company's properties.
 *   4. `readAssociatedCompany` returns `undefined` when no companies are
 *      associated.
 *   5. `readAssociatedCompany` returns `undefined` when the deal response
 *      has no `associations` object at all (defensive fallback).
 *   6. `writeDealProperties` sends the properties object in the expected
 *      `{ properties }` envelope.
 *   7. `writeDealProperties` rejects on a 4xx error from the SDK
 *      (propagated unchanged).
 *   8. `readDealProperties` rejects on a 5xx error from the SDK
 *      (propagated unchanged).
 *
 * Requirements covered: 1.3, 4.8, 6.6.
 */

/**
 * Build a minimal mock `@hubspot/api-client` `Client` exposing just the
 * three methods the wrapper touches. Each method defaults to a resolved
 * no-op so tests only need to override the behaviour they care about. The
 * final `as unknown as Client` cast sidesteps the SDK's huge class
 * surface — we don't need any of it.
 *
 * Callbacks are typed as `(...args: unknown[]) => Promise<unknown>` so we
 * can mix `getById` call shapes (2-arg for plain read, 4-arg for the
 * associations read) without fighting TypeScript strict mode.
 */
function buildMockClient(opts: {
  getByIdImpl?: (...args: unknown[]) => Promise<unknown>;
  companyGetByIdImpl?: (...args: unknown[]) => Promise<unknown>;
  updateImpl?: (...args: unknown[]) => Promise<unknown>;
}): Client {
  return {
    crm: {
      deals: {
        basicApi: {
          getById: vi.fn(
            opts.getByIdImpl ?? (async () => ({ properties: {} }))
          ),
          update: vi.fn(opts.updateImpl ?? (async () => ({}))),
        },
      },
      companies: {
        basicApi: {
          getById: vi.fn(
            opts.companyGetByIdImpl ?? (async () => ({ properties: {} }))
          ),
        },
      },
    },
  } as unknown as Client;
}

describe("readDealProperties", () => {
  test("returns DealProps with null values normalised to undefined", async () => {
    // HubSpot returns unset properties as `null` over the wire; the
    // wrapper must collapse those to `undefined` so downstream code
    // (preconditions, payload builders) only has to consider one empty
    // sentinel.
    const mock = buildMockClient({
      getByIdImpl: async () => ({
        properties: {
          closedate: "2025-01-01",
          amount: "1000",
          description: null,
        },
      }),
    });
    const hs = createHubspotClient("tok", mock);
    const result = await hs.readDealProperties(123, [
      "closedate",
      "amount",
      "description",
    ]);
    expect(result.closedate).toBe("2025-01-01");
    expect(result.amount).toBe("1000");
    expect(result.description).toBeUndefined();
  });

  test("forwards propertyNames array to the SDK", async () => {
    // The wrapper must pass the caller's property list through verbatim
    // (not, for example, replace it with the full set) so callers can
    // minimise payload size.
    const getByIdMock = vi.fn(async () => ({ properties: {} }));
    const mock = buildMockClient({ getByIdImpl: getByIdMock });
    const hs = createHubspotClient("tok", mock);
    await hs.readDealProperties(42, ["dealstage", "amount"]);
    // Deal ids are stringified at the SDK boundary.
    expect(getByIdMock).toHaveBeenCalledWith("42", ["dealstage", "amount"]);
  });

  test("rejects on a 5xx SDK error (propagated unchanged)", async () => {
    // 5xx surfaces through the SDK as a rejected promise. The wrapper
    // intentionally does not catch or rewrap — callers decide how to map
    // to the HUBSPOT_READ error code in their response envelope.
    const err = Object.assign(new Error("HubSpot 500"), { code: 500 });
    const mock = buildMockClient({
      getByIdImpl: async () => {
        throw err;
      },
    });
    const hs = createHubspotClient("tok", mock);
    await expect(hs.readDealProperties(1, ["amount"])).rejects.toBe(err);
  });
});

describe("readAssociatedCompany", () => {
  test("returns primary company properties when an association exists", async () => {
    // The wrapper does a single deal-with-associations call, then a
    // follow-up company read for the *first* (primary) associated
    // company. Extra associated companies are ignored by design.
    const mock = buildMockClient({
      getByIdImpl: async () => ({
        associations: {
          companies: { results: [{ id: "1001" }, { id: "1002" }] },
        },
      }),
      companyGetByIdImpl: async () => ({
        properties: {
          name: "Acme",
          hs_country_code: "US",
          city: "Seattle",
          zip: null,
          state: "WA",
          website: null,
          domain: "acme.io",
        },
      }),
    });
    const hs = createHubspotClient("tok", mock);
    const co = await hs.readAssociatedCompany(77);
    expect(co).toBeDefined();
    expect(co?.name).toBe("Acme");
    expect(co?.hs_country_code).toBe("US");
    expect(co?.city).toBe("Seattle");
    // Null normalisation also applies to company properties.
    expect(co?.zip).toBeUndefined();
    expect(co?.website).toBeUndefined();
    expect(co?.domain).toBe("acme.io");
  });

  test("returns undefined when the deal has no associated companies", async () => {
    // Empty `results` array is the most common "no company" shape —
    // HubSpot still returns an `associations.companies` object, just with
    // nothing in it.
    const mock = buildMockClient({
      getByIdImpl: async () => ({
        associations: { companies: { results: [] } },
      }),
    });
    const hs = createHubspotClient("tok", mock);
    const co = await hs.readAssociatedCompany(77);
    expect(co).toBeUndefined();
  });

  test("returns undefined when the deal response has no associations object", async () => {
    // Defensive fallback: some HubSpot responses omit the `associations`
    // key entirely for deals with no companies of any kind. The wrapper's
    // optional-chaining should collapse that to the same empty-result
    // case without throwing.
    const mock = buildMockClient({
      getByIdImpl: async () => ({}),
    });
    const hs = createHubspotClient("tok", mock);
    const co = await hs.readAssociatedCompany(77);
    expect(co).toBeUndefined();
  });
});

describe("writeDealProperties", () => {
  test("calls basicApi.update with the correct shape", async () => {
    // The SDK expects `{ properties: { ... } }`; the wrapper must not
    // flatten or rename. Deal id is stringified at the boundary.
    const updateMock = vi.fn(async () => ({}));
    const mock = buildMockClient({ updateImpl: updateMock });
    const hs = createHubspotClient("tok", mock);
    await hs.writeDealProperties(7, {
      ace_sync_status: "Synced",
      ace_last_sync: "2025-04-29T12:00:00Z",
    });
    expect(updateMock).toHaveBeenCalledWith("7", {
      properties: {
        ace_sync_status: "Synced",
        ace_last_sync: "2025-04-29T12:00:00Z",
      },
    });
  });

  test("rejects on a 4xx SDK error (propagated unchanged)", async () => {
    // 4xx (e.g. validation failure) surfaces as a rejected promise.
    // Callers map this to HUBSPOT_WRITE in their response envelope; the
    // wrapper must not catch or rewrap.
    const err = Object.assign(new Error("HubSpot 400"), { code: 400 });
    const mock = buildMockClient({
      updateImpl: async () => {
        throw err;
      },
    });
    const hs = createHubspotClient("tok", mock);
    await expect(
      hs.writeDealProperties(7, { ace_sync_status: "x" })
    ).rejects.toBe(err);
  });
});
