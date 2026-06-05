/**
 * HubSpot v3 signature validation for inbound `hubspot.fetch` requests.
 *
 * This is a verbatim copy of `../../backend/lib/hubspot-signature.ts`.
 * The agent stack is intentionally independent of the share/refresh
 * stack — partners deploying only the agent don't need `backend/`
 * checked out.
 *
 * See `backend/lib/hubspot-signature.ts` for full design context. The
 * one-paragraph summary: HubSpot's UI Extensions data-fetch service
 * signs every outbound call with HMAC-SHA256(clientSecret) over
 * (method + url + body + timestamp). API Gateway REQUEST authorizers
 * can't see the body, so verification has to live inside the Lambda
 * itself.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

const TIMESTAMP_MAX_AGE_MS = 5 * 60 * 1000;

export type SignatureFailureReason =
  | "no_signature_header"
  | "no_timestamp_header"
  | "stale_timestamp"
  | "invalid_signature";

export type SignatureVerifyResult =
  | { ok: true; identity: HubspotIdentity }
  | { ok: false; reason: SignatureFailureReason };

export type HubspotIdentity = {
  hubId: string;
  userId: string;
  appId: string;
  userEmail: string;
};

export type SignatureCheckEvent = {
  headers?: Record<string, string | undefined>;
  rawPath?: string;
  rawQueryString?: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    domainName?: string;
    http?: { method?: string };
  };
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
  const host = event.requestContext?.domainName ?? "";
  const path = event.rawPath ?? "/";
  const query = event.rawQueryString ?? "";
  return query ? `https://${host}${path}?${query}` : `https://${host}${path}`;
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

  const method = event.requestContext?.http?.method ?? "POST";
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
