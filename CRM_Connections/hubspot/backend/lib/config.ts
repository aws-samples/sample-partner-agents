/**
 * Configuration loader for the Share / Refresh Lambda handlers.
 *
 * All secrets live in a single JSON blob stored in AWS Secrets Manager at
 * the ID in `process.env.ACE_SHARE_SECRET_ID` (default
 * `crm-connector/ace-share`). The blob is fetched once per Lambda container
 * and cached in a module-scoped variable so warm invocations pay no
 * Secrets Manager round-trip.
 *
 * Each loader returns a discriminated union so callers can surface a
 * structured error response without throwing:
 *
 *   - `loadConfigFromSecretsManager()` builds the full `AppConfig` used
 *     by Share / Refresh (ACE credentials, mapping grammar, HubSpot token).
 *   - `loadAuthConfigFromSecretsManager()` builds the narrow `AuthConfig`
 *     used by the inbound HubSpot v3 HMAC verification (client secret only).
 *
 * A secret counts as "missing" when the JSON value is absent, an empty
 * string, or whitespace-only. `ACE_REGION` is optional and defaults to
 * `us-east-1`. `STAGE_DISPLAY_NAMES` is optional (consumed only by
 * Refresh) and defaults to an empty string.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

export type AppConfig = {
  /**
   * Optional. When both `awsAccessKeyId` and `awsSecretAccessKey` are
   * present and non-blank, the ACE SDK is constructed with explicit
   * static credentials. When either is absent, the SDK falls back to
   * the AWS default credential provider chain — in production that
   * resolves to the Lambda execution role, which carries the
   * `partnercentral-selling:*` permissions granted by CloudFormation.
   *
   * Using the execution role is the preferred path because it removes
   * long-lived IAM-user keys from Secrets Manager entirely. Static
   * keys are kept as an optional override for local debugging or for
   * the (rare) case where the Lambda must call ACE under a different
   * AWS account than the one that hosts it.
   */
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  aceRegion: string;
  /**
   * Optional override for `Project.CustomerUseCase` on every CreateOpportunity
   * call. Sourced from the `ACE_DEFAULT_USE_CASE` secret. When unset, the
   * builder falls back to `DEFAULT_ACE_USE_CASE`. A per-deal value (the
   * `ace_customer_use_case` HubSpot property) takes precedence over both.
   */
  aceDefaultUseCase?: string;
  /**
   * Optional override for `Marketing.Source` on every CreateOpportunity /
   * UpdateOpportunity call. Sourced from the `ACE_DEFAULT_MARKETING_SOURCE`
   * secret. When unset, the builder falls back to `DEFAULT_MARKETING_SOURCE`.
   * A per-deal value (the `ace_marketing_source` HubSpot property) takes
   * precedence over both. Must be `"Marketing Activity"` or `"None"`.
   */
  aceDefaultMarketingSource?: string;
  /**
   * Optional env-level overrides for the remaining ACE-payload fields.
   * Per-deal HubSpot property always wins; if absent, this env value
   * applies; if absent, a hardcoded fallback in `lib/payload.ts` is used.
   * All sourced from same-named secrets (e.g. `ACE_DEFAULT_INDUSTRY`).
   * Empty / whitespace values resolve to `undefined`.
   */
  aceDefaultIndustry?: string;
  aceDefaultOpportunityType?: string;
  aceDefaultPrimaryNeedFromAws?: string;
  aceDefaultDeliveryModel?: string;
  aceDefaultCurrencyCode?: string;
  aceDefaultAwsFundingUsed?: string;
  aceDefaultInvolvementType?: string;
  aceDefaultVisibility?: string;
  aceDefaultNationalSecurity?: string;
  /**
   * Optional env-level defaults for the new editable Project / Customer
   * fields. Empty / whitespace values resolve to `undefined` so the
   * payload builder's per-deal-property → env-default → omit chain
   * correctly skips the field rather than sending an empty string.
   *
   * `aceDefaultCompetitorName` and `aceDefaultAwsPartition` must be
   * one of the SDK-defined enum values (e.g. "Microsoft Azure",
   * "aws-eusc"); ACE rejects off-list values with `INVALID_ENUM_VALUE`.
   *
   * `aceDefaultApnPrograms` is `;`-separated when populated (matching
   * the multi-select wire format).
   */
  aceDefaultCompetitorName?: string;
  aceDefaultAwsPartition?: string;
  aceDefaultApnPrograms?: string;
  /**
   * `;`-separated default for `Project.SalesActivities` when neither
   * the per-deal `ace_sales_activities` override nor the env-level
   * default is set. ACE accepts a closed enum (8 values); see
   * `STAGE_TO_SALES_ACTIVITIES` in `lib/payload.ts` for the
   * stage-aware fallback used when this is also unset.
   */
  aceDefaultSalesActivities?: string;
  stageMappingRaw: string;
  stageDisplayNamesRaw: string;
  hubspotPrivateAppToken: string;
};

export type AuthConfig = {
  hubspotClientSecret: string;
};

/**
 * The AWS Partner Central catalog under which Co-Sell opportunities are
 * created and read. Sandbox is the only catalog used by this integration.
 */
export const ACE_CATALOG = "Sandbox" as const;

/**
 * Hard fallback for `Project.CustomerUseCase` when neither the deal's
 * `ace_customer_use_case` property nor the secret `ACE_DEFAULT_USE_CASE`
 * is set. ACE rejects any value not in its enum (so the historical
 * `"Other"` default is no longer valid). We pick a deliberately broad
 * value that won't be wrong for typical SaaS partner deals; operators
 * can override per-deal or per-environment.
 */
export const DEFAULT_ACE_USE_CASE =
  "Business Applications & Contact Center" as const;

/**
 * `Marketing.Source` values accepted by ACE. `"Marketing Activity"`
 * means the opp came from an AWS marketing programme (campaign code
 * required); `"None"` means it didn't. The safe default for a typical
 * partner-sourced deal is `"None"` — flipping to `"Marketing Activity"`
 * requires a CampaignName which we don't currently surface.
 */
export const MARKETING_SOURCE_NONE = "None" as const;
export const MARKETING_SOURCE_ACTIVITY = "Marketing Activity" as const;
export type MarketingSourceValue =
  | typeof MARKETING_SOURCE_NONE
  | typeof MARKETING_SOURCE_ACTIVITY;

/**
 * Hard fallback for `Marketing.Source` when neither the deal's
 * `ace_marketing_source` property nor the secret `ACE_DEFAULT_MARKETING_SOURCE`
 * is set. Default `"None"` is the conservative choice: it doesn't
 * require a CampaignName and is what most partner-sourced deals are.
 */
export const DEFAULT_MARKETING_SOURCE: MarketingSourceValue =
  MARKETING_SOURCE_NONE;

/**
 * Hard fallbacks for the remaining customisable ACE-payload fields.
 * Same precedence rule as `DEFAULT_ACE_USE_CASE`: per-deal HubSpot
 * property → env-level secret (`ACE_DEFAULT_*`) → these constants.
 *
 * All values are documented enum members of their respective ACE field
 * domains. If you change a default here, also update the picklist
 * `displayOrder=0` entry in `scripts/setup_ace_picklists.py` so the
 * HubSpot UI surfaces the same value as "first / default" choice.
 */
export const DEFAULT_ACE_INDUSTRY = "Software and Internet" as const;
export const DEFAULT_ACE_OPPORTUNITY_TYPE = "Net New Business" as const;
export const DEFAULT_ACE_PRIMARY_NEED_FROM_AWS =
  "Co-Sell - Architectural Validation" as const;
export const DEFAULT_ACE_DELIVERY_MODEL = "SaaS or PaaS" as const;
export const DEFAULT_ACE_CURRENCY_CODE = "USD" as const;
export const DEFAULT_ACE_AWS_FUNDING_USED = "No" as const;
export const DEFAULT_ACE_INVOLVEMENT_TYPE = "Co-Sell" as const;
export const DEFAULT_ACE_VISIBILITY = "Full" as const;
export const DEFAULT_ACE_NATIONAL_SECURITY = "No" as const;

/**
 * Default AWS region used when `ACE_REGION` is not provided. Partner Central
 * APIs are currently hosted out of `us-east-1`.
 */
export const DEFAULT_ACE_REGION = "us-east-1" as const;

/**
 * Secret keys that MUST be present and non-blank in the Secrets Manager
 * blob for Share / Refresh to run. The iteration order here determines the
 * order of the `missing` array returned by `loadConfigFromSecretsManager`,
 * which keeps the property-based tests predictable.
 *
 * Note: `AWS_ACE_ACCESS_KEY_ID` and `AWS_ACE_SECRET_ACCESS_KEY` are
 * intentionally NOT required here. ACE is called with the Lambda's
 * execution role by default (see `AppConfig.awsAccessKeyId` doc).
 * Operators can still set both keys to override the role-based path.
 *
 * `ACE_SOLUTION_ID` was previously required as a global default. The
 * Share flow now reads the per-deal `ace_solutions` HubSpot property
 * (one ACE Partner Central Solution Offering ID per `;`-separated
 * value) and associates each one. Configuring a single global solution
 * is no longer meaningful — different deals can target different
 * Solution Offerings in the partner's catalogue.
 */
export const REQUIRED_SECRET_NAMES = [
  "STAGE_MAPPING",
  "HUBSPOT_PRIVATE_APP_TOKEN",
] as const;

export type LoadConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; missing: string[] };

export type LoadAuthConfigResult =
  | { ok: true; config: AuthConfig }
  | { ok: false; missing: string[] };

// ---------------------------------------------------------------------------
// Module-scoped cache. One SecretsManagerClient + one parsed blob per
// Lambda container. Cleared by tests via `__clearConfigCache()`.
// ---------------------------------------------------------------------------

const SECRET_ID =
  process.env.ACE_SHARE_SECRET_ID ?? "crm-connector/ace-share";

const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION ?? "us-east-1",
});

let cachedRaw: Record<string, string> | undefined;

/**
 * Fetch the raw secret blob from AWS Secrets Manager, parse it as JSON,
 * and cache the result. Subsequent calls within the same container reuse
 * the cached value.
 */
async function loadSecretBlob(): Promise<Record<string, string>> {
  if (cachedRaw) return cachedRaw;
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const str = resp.SecretString ?? "{}";
  cachedRaw = JSON.parse(str) as Record<string, string>;
  return cachedRaw;
}

/**
 * Load the full application config used by the Share and Refresh handlers.
 * Returns a structured result so callers can surface `MISSING_SECRET`
 * without throwing.
 */
export async function loadConfigFromSecretsManager(): Promise<LoadConfigResult> {
  const raw = await loadSecretBlob();
  const missing: string[] = [];
  for (const key of REQUIRED_SECRET_NAMES) {
    const value = raw[key];
    if (value === undefined || value.trim() === "") {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }

  const aceRegionRaw = raw["ACE_REGION"];
  const aceRegion =
    aceRegionRaw !== undefined && aceRegionRaw.trim() !== ""
      ? aceRegionRaw.trim()
      : DEFAULT_ACE_REGION;

  // The missing-check loop above guarantees these keys are present and
  // non-blank, so the casts are sound. TypeScript's narrower can't
  // correlate the loop's conclusion with these index accesses under
  // `noUncheckedIndexedAccess`, so we assert manually.
  //
  // AWS_ACE_* are optional (see `AppConfig.awsAccessKeyId` doc): empty
  // / whitespace-only / absent values become `undefined` so `ace.ts`
  // can fall back to the SDK default credential provider chain.
  const awsAccessKeyIdRaw = raw["AWS_ACE_ACCESS_KEY_ID"];
  const awsSecretAccessKeyRaw = raw["AWS_ACE_SECRET_ACCESS_KEY"];
  const awsAccessKeyId =
    awsAccessKeyIdRaw && awsAccessKeyIdRaw.trim() !== ""
      ? awsAccessKeyIdRaw.trim()
      : undefined;
  const awsSecretAccessKey =
    awsSecretAccessKeyRaw && awsSecretAccessKeyRaw.trim() !== ""
      ? awsSecretAccessKeyRaw.trim()
      : undefined;

  // Helper: resolve an optional env-default key from the blob. Empty,
  // whitespace, or absent values become `undefined` so the payload
  // builder's per-deal-property → env-default → hardcoded-fallback
  // chain works uniformly.
  const opt = (key: string): string | undefined => {
    const v = raw[key];
    return v && v.trim() !== "" ? v.trim() : undefined;
  };

  const config: AppConfig = {
    awsAccessKeyId,
    awsSecretAccessKey,
    aceRegion,
    aceDefaultUseCase: opt("ACE_DEFAULT_USE_CASE"),
    aceDefaultMarketingSource: opt("ACE_DEFAULT_MARKETING_SOURCE"),
    aceDefaultIndustry: opt("ACE_DEFAULT_INDUSTRY"),
    aceDefaultOpportunityType: opt("ACE_DEFAULT_OPPORTUNITY_TYPE"),
    aceDefaultPrimaryNeedFromAws: opt("ACE_DEFAULT_PRIMARY_NEED_FROM_AWS"),
    aceDefaultDeliveryModel: opt("ACE_DEFAULT_DELIVERY_MODEL"),
    aceDefaultCurrencyCode: opt("ACE_DEFAULT_CURRENCY_CODE"),
    aceDefaultAwsFundingUsed: opt("ACE_DEFAULT_AWS_FUNDING_USED"),
    aceDefaultInvolvementType: opt("ACE_DEFAULT_INVOLVEMENT_TYPE"),
    aceDefaultVisibility: opt("ACE_DEFAULT_VISIBILITY"),
    aceDefaultNationalSecurity: opt("ACE_DEFAULT_NATIONAL_SECURITY"),
    aceDefaultCompetitorName: opt("ACE_DEFAULT_COMPETITOR_NAME"),
    aceDefaultAwsPartition: opt("ACE_DEFAULT_AWS_PARTITION"),
    aceDefaultApnPrograms: opt("ACE_DEFAULT_APN_PROGRAMS"),
    aceDefaultSalesActivities: opt("ACE_DEFAULT_SALES_ACTIVITIES"),
    stageMappingRaw: raw["STAGE_MAPPING"] as string,
    stageDisplayNamesRaw: raw["STAGE_DISPLAY_NAMES"] ?? "",
    hubspotPrivateAppToken: raw["HUBSPOT_PRIVATE_APP_TOKEN"] as string,
  };
  return { ok: true, config };
}

/**
 * Load the narrow auth config used by the inbound HubSpot v3 HMAC
 * verification. The handlers verify HubSpot's signature on every
 * request using this client secret as the HMAC key.
 *
 * The client secret is the value labelled "Client secret" on the app's
 * Auth tab in HubSpot UI. It's NOT the static access token used for
 * outbound HubSpot CRM API calls (that's `HUBSPOT_PRIVATE_APP_TOKEN`).
 */
export async function loadAuthConfigFromSecretsManager(): Promise<LoadAuthConfigResult> {
  const raw = await loadSecretBlob();
  const value = raw["HUBSPOT_CLIENT_SECRET"];
  if (value === undefined || value.trim() === "") {
    return { ok: false, missing: ["HUBSPOT_CLIENT_SECRET"] };
  }
  return { ok: true, config: { hubspotClientSecret: value } };
}

/**
 * Testing hook: clear the container-level cache so unit tests can swap
 * fixtures without bouncing the process.
 */
export function __clearConfigCache(): void {
  cachedRaw = undefined;
}
