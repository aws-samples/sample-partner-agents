/**
 * STAGE_MAPPING / STAGE_DISPLAY_NAMES parsing and forward/reverse mapping.
 *
 * Grammar (same as the Python sync's env-var parsing in src/config.py:_load_stage_mapping):
 *   STAGE_MAPPING := Entry ( ';' Entry )* [';']
 *   Entry         := HubSpotStageId '=' Value
 * Whitespace around `;` and `=` is trimmed. Empty entries are skipped, and
 * entries without an `=` separator are silently dropped.
 *
 * Duplicate-key policy:
 *   - `parseStageMapping` uses **first-occurrence wins** for duplicate HubSpot
 *     stage IDs. This is a deliberate deviation from the Python sync's
 *     last-write-wins dict semantics. tasks.md §3.3 requires the property
 *     test to assert first-occurrence ownership, so the parser matches that
 *     spec; design.md §STAGE_MAPPING secret grammar still mentions the Python
 *     behaviour but tasks.md is the source of truth for this TypeScript port.
 *   - `parseStageDisplayNames` also uses first-occurrence wins for consistency.
 *
 * Off-list ACE stages:
 *   `parseStageMapping` does NOT include off-list entries in the returned
 *   mapping; instead it records the raw `id=stage` pair in `invalidEntries`
 *   so callers can surface a STAGE_UNMAPPABLE / configuration error (R9.4).
 */

/**
 * The six ACE stages accepted by AWS Partner Central's Co-Sell Opportunity
 * `LifeCycle.Stage`. Any value outside this set is rejected by ACE and so is
 * rejected here at config parse time.
 */
export const VALID_ACE_STAGES = [
  "Qualified",
  "Technical Validation",
  "Business Validation",
  "Committed",
  "Launched",
  "Closed Lost",
] as const;

export type AceStage = (typeof VALID_ACE_STAGES)[number];

export type StageMapping = Record<string, AceStage>;
export type StageDisplayNames = Record<string, string>;

const VALID_ACE_STAGE_SET: ReadonlySet<string> = new Set(VALID_ACE_STAGES);

/**
 * Parse a raw STAGE_MAPPING string into a HubSpot stage ID -> ACE stage map,
 * plus a list of raw `id=stage` entries whose value was not a recognised ACE
 * stage. First-occurrence wins for duplicate HubSpot IDs.
 */
export function parseStageMapping(raw: string): {
  mapping: StageMapping;
  invalidEntries: string[];
} {
  const mapping: StageMapping = {};
  const invalidEntries: string[] = [];
  if (!raw) {
    return { mapping, invalidEntries };
  }
  for (const rawEntry of raw.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const eqIdx = entry.indexOf("=");
    if (eqIdx === -1) continue; // malformed entries silently skipped (matches Python behaviour)
    const id = entry.slice(0, eqIdx).trim();
    const value = entry.slice(eqIdx + 1).trim();
    if (!id || !value) continue;
    if (!VALID_ACE_STAGE_SET.has(value)) {
      invalidEntries.push(`${id}=${value}`);
      continue;
    }
    // First-occurrence wins — skip if this HS id is already mapped.
    if (Object.prototype.hasOwnProperty.call(mapping, id)) continue;
    mapping[id] = value as AceStage;
  }
  return { mapping, invalidEntries };
}

/**
 * Parse a raw STAGE_DISPLAY_NAMES string into a HubSpot stage ID -> display
 * name map. No off-list validation applies here; any non-empty display name
 * is accepted. First-occurrence wins for duplicate HubSpot IDs.
 *
 * `raw` is optional because `STAGE_DISPLAY_NAMES` is an optional secret —
 * when absent, callers get back an empty map and fall back to the raw ACE
 * stage string per R4.3.
 */
export function parseStageDisplayNames(raw?: string): StageDisplayNames {
  const map: StageDisplayNames = {};
  if (!raw) return map;
  for (const rawEntry of raw.split(";")) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const eqIdx = entry.indexOf("=");
    if (eqIdx === -1) continue;
    const id = entry.slice(0, eqIdx).trim();
    const value = entry.slice(eqIdx + 1).trim();
    if (!id || !value) continue;
    if (Object.prototype.hasOwnProperty.call(map, id)) continue;
    map[id] = value;
  }
  return map;
}

/**
 * Forward map a HubSpot stage ID to an ACE stage. Returns `undefined` when
 * the ID has no mapping (callers in the Share flow convert this into a
 * STAGE_UNMAPPABLE precondition failure).
 */
export function forwardMap(
  hubspotStageId: string,
  mapping: StageMapping
): AceStage | undefined {
  if (!Object.prototype.hasOwnProperty.call(mapping, hubspotStageId)) {
    return undefined;
  }
  return mapping[hubspotStageId];
}

/**
 * Reverse map an ACE stage to some HubSpot stage ID that maps to it. When
 * multiple HubSpot IDs collapse to the same ACE stage (e.g. `closedlost` and
 * `closed_lost_competitor` both -> "Closed Lost") the first-inserted key in
 * the mapping wins. Callers should treat the reverse map as a best-effort
 * display hint only, per design.md §Stage mapping module.
 */
export function reverseMap(
  aceStage: string,
  mapping: StageMapping
): string | undefined {
  for (const [hsId, stage] of Object.entries(mapping)) {
    if (stage === aceStage) return hsId;
  }
  return undefined;
}
