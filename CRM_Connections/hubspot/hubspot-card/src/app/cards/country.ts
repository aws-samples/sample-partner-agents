// backend/lib/country.ts AND hubspot-card/src/app/cards/country.ts
// Both files are byte-identical (same convention as submission-mode.ts).
//
// Country-code normalisation + validation for the ACE
// `customer.account.address.countryCode` field.
//
// Why this exists: HubSpot's deal-level `ace_country_code` override is a
// free-text field, so reps routinely enter a display name ("United
// States") instead of the ISO 3166-1 alpha-2 code ("US"). AWS Partner
// Central's CreateOpportunity rejects anything that isn't a member of its
// country-code enum with `INVALID_ENUM_VALUE`. Worse, the US-only
// `stateOrRegion` requirement keys off an exact `=== "US"` comparison, so
// an un-normalised "United States" silently disables the state check AND
// then fails at AWS. Normalising up-front fixes both.

/**
 * ISO 3166-1 alpha-2 codes accepted by AWS Partner Central's
 * `customer.account.address.countryCode` enum. Captured verbatim from the
 * service's `INVALID_ENUM_VALUE` rejection (Sandbox, June 2026) so the
 * local validator matches the server exactly. Note the set intentionally
 * omits sanctioned territories (e.g. KP) — AWS does not accept them.
 */
export const ACE_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AN", "AO", "AQ", "AR", "AS",
  "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH",
  "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW",
  "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM",
  "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK",
  "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ",
  "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI",
  "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK",
  "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ",
  "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM",
  "KN", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS",
  "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW",
  "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP",
  "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM",
  "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM",
  "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF",
  "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW",
  "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
]);

/**
 * Hand-maintained aliases for the common free-text spellings reps type
 * that `Intl.DisplayNames` won't resolve on its own (abbreviations,
 * punctuation variants, colloquial names). Keys are lowercased.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  usa: "US",
  "u.s.a.": "US",
  "u.s.": "US",
  "u.s": "US",
  us: "US",
  america: "US",
  "united states of america": "US",
  uk: "GB",
  "u.k.": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  "south korea": "KR",
  "republic of korea": "KR",
  uae: "AE",
  "united arab emirates": "AE",
  russia: "RU",
  vietnam: "VN",
  "viet nam": "VN",
};

/**
 * Build a lowercased display-name -> ISO code map. Uses `Intl.DisplayNames`
 * (full-ICU in Node 20; supported in all modern browsers the HubSpot card
 * runs in) over the ACE-accepted code set, then layers the hand-maintained
 * aliases on top. Guarded so a runtime without `Intl.DisplayNames` still
 * gets alias coverage rather than throwing at module load.
 */
const NAME_TO_CODE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of ACE_COUNTRY_CODES) {
      const name = display.of(code);
      if (name && name.toUpperCase() !== code) {
        map.set(name.toLowerCase(), code);
      }
    }
  } catch {
    // Intl.DisplayNames unavailable — fall back to aliases only.
  }
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
    map.set(name, code);
  }
  return map;
})();

/**
 * Normalise a raw country value to an ISO 3166-1 alpha-2 code AWS accepts.
 *
 * Resolution order:
 *   1. Already a valid alpha-2 code (case-insensitive) -> uppercased code.
 *   2. A known display name / alias ("United States", "USA") -> its code.
 *   3. Otherwise `undefined` (caller treats as invalid/missing).
 *
 * Returns `undefined` for empty / whitespace-only / unresolvable input so
 * callers can distinguish "no usable country" from a valid code.
 */
export function normalizeCountryCode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const upper = trimmed.toUpperCase();
  if (ACE_COUNTRY_CODES.has(upper)) return upper;

  const byName = NAME_TO_CODE.get(trimmed.toLowerCase());
  if (byName) return byName;

  return undefined;
}

/** True iff `code` is a country code AWS Partner Central accepts as-is. */
export function isAceCountryCode(code: string | undefined): boolean {
  return !!code && ACE_COUNTRY_CODES.has(code.toUpperCase());
}
