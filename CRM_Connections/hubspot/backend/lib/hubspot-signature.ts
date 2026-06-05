/**
 * HubSpot v3 signature validation for inbound requests from `hubspot.fetch`.
 *
 * HubSpot's UI Extensions data-fetch service signs every outbound call with:
 *   - X-HubSpot-Signature-v3 header     (HMAC-SHA256 base64)
 *   - X-HubSpot-Request-Timestamp header (epoch milliseconds)
 *
 * The signed message is:
 *   clientSecret + httpMethod + url + requestBody + timestamp
 *
 * keyed with the same client secret. We recompute the HMAC server-side,
 * compare in constant time, and reject if the timestamp is older than
 * 5 minutes (replay protection).
 *
 * Why this lives in the handler (not an API Gateway authorizer): API
 * Gateway REQUEST-type authorizers only receive headers, path, and
 * query string — never the request body. Without the body, we can't
 * recompute the HMAC. So validation happens inside the Share / Refresh
 * Lambda handlers themselves, where the full event including body is
 * available. The CloudFormation stack therefore has no custom
 * authorizer; the routes are public-by-IAM and the signature check is
 * the actual auth gate.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

/** Maximum allowed clock skew between HubSpot and our Lambda. */
const TIMESTAMP_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Coarse failure reasons. Closed enum so log strings stay greppable.
 */
export type SignatureFailureReason =
  | "no_signature_header"
  | "no_timestamp_header"
  | "stale_timestamp"
  | "invalid_signature";

export type SignatureVerifyResult =
  | { ok: true; identity: HubspotIdentity }
  | { ok: false; reason: SignatureFailureReason };

/**
 * Identity context HubSpot embeds in the signed query string. The
 * signature covers the full URL, so once the signature verifies, these
 * values are trustworthy.
 */
export type HubspotIdentity = {
  hubId: string;
  userId: string;
  appId: string;
  userEmail: string;
};

/**
 * Subset of an `APIGatewayProxyEventV2` we need. Defined here so this
 * module doesn't pull in `aws-lambda` types and stays unit-testable.
 *
 * The `requestContext` is intentionally typed as `unknown` so that
 * callers passing the generic `APIGatewayProxyEventV2WithRequestContext<unknown>`
 * (the wider type Lambda hands us) compile cleanly. We narrow at use.
 */
export type SignatureCheckEvent = {
  headers?: Record<string, string | undefined>;
  rawPath?: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: unknown;
};

type RequestContextLike = {
  domainName?: string;
  http?: { method?: string };
};

function header(
  event: SignatureCheckEvent,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === lower) return v ?? undefined;
  }
  return undefined;
}

function reconstructUrl(event: SignatureCheckEvent): string {
  const ctx = (event.requestContext as RequestContextLike | undefined) ?? {};
  const host = ctx.domainName ?? "";
  const path = event.rawPath ?? "/";
  const query = event.rawQueryString ?? "";
  return query
    ? `https://${host}${path}?${query}`
    : `https://${host}${path}`;
}

function decodeBody(event: SignatureCheckEvent): string {
  if (event.body === undefined || event.body === null) return "";
  if (event.isBase64Encoded) {
    try {
      return Buffer.from(event.body, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return event.body;
}

/**
 * URL-decode the specific characters HubSpot says to decode before signing.
 * Per https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation:
 *   %3A → : | %2F → / | %3F → ? | %40 → @ | %21 → ! | %24 → $
 *   %27 → ' | %28 → ( | %29 → ) | %2A → * | %2C → , | %3B → ;
 * Other percent-encoded characters stay as-is.
 *
 * Note: API Gateway gives us the URL with the same encoding HubSpot used
 * when computing the signature. We must perform the listed decodes
 * (and only those) so our signing string matches HubSpot's exactly.
 */
function decodeUriForSigning(uri: string): string {
  return uri
    .replace(/%3A/gi, ":")
    .replace(/%2F/gi, "/")
    .replace(/%3F/gi, "?")
    .replace(/%40/gi, "@")
    .replace(/%21/gi, "!")
    .replace(/%24/gi, "$")
    .replace(/%27/gi, "'")
    .replace(/%28/gi, "(")
    .replace(/%29/gi, ")")
    .replace(/%2A/gi, "*")
    .replace(/%2C/gi, ",")
    .replace(/%3B/gi, ";");
}

function computeSignature(
  clientSecret: string,
  method: string,
  url: string,
  body: string,
  timestamp: string
): string {
  // Per HubSpot's v3 spec: rawString = method + uri + body + timestamp.
  // The client secret is the HMAC KEY only — it does NOT appear in the
  // hashed message itself.
  const decodedUri = decodeUriForSigning(url);
  const rawString = method + decodedUri + body + timestamp;
  return createHmac("sha256", clientSecret).update(rawString).digest("base64");
}

function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function extractIdentity(event: SignatureCheckEvent): HubspotIdentity {
  const params = new URLSearchParams(event.rawQueryString ?? "");
  return {
    hubId: params.get("portalId") ?? "",
    userId: params.get("userId") ?? "",
    appId: params.get("appId") ?? "",
    userEmail: params.get("userEmail") ?? "",
  };
}

/**
 * Verify the HubSpot v3 signature on an inbound request. Returns a
 * discriminated-union so callers can map directly into a 401 envelope.
 *
 * On success, the trusted query-string identity (portal id, user id,
 * etc.) is returned for the caller to log or pass into business logic.
 */
export function verifyHubspotSignature(
  event: SignatureCheckEvent,
  clientSecret: string
): SignatureVerifyResult {
  const signature = header(event, "x-hubspot-signature-v3");
  const timestamp = header(event, "x-hubspot-request-timestamp");

  if (!signature) return { ok: false, reason: "no_signature_header" };
  if (!timestamp) return { ok: false, reason: "no_timestamp_header" };

  const tsNum = Number.parseInt(timestamp, 10);
  if (
    !Number.isFinite(tsNum) ||
    Math.abs(Date.now() - tsNum) > TIMESTAMP_MAX_AGE_MS
  ) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const method =
    (event.requestContext as RequestContextLike | undefined)?.http?.method ??
    "POST";
  const url = reconstructUrl(event);
  const body = decodeBody(event);
  const expected = computeSignature(
    clientSecret,
    method,
    url,
    body,
    timestamp
  );

  if (!safeCompare(expected, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true, identity: extractIdentity(event) };
}
