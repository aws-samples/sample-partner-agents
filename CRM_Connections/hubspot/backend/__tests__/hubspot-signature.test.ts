/**
 * Direct unit tests for `lib/hubspot-signature.ts`.
 *
 * The lib verifies HubSpot's v3 HMAC signature on inbound requests.
 * Strategy: build the same string HubSpot would sign (method + url +
 * body + timestamp), HMAC-SHA256 it server-side using `node:crypto`,
 * and synthesise an APIGatewayProxyEventV2 the verifier can consume.
 * Then probe the failure modes by mutating one input at a time.
 *
 * No mocks needed — the lib is pure. The handler-level tests
 * (`share.handler.test.ts`, `refresh.handler.test.ts`) stub the verifier
 * to focus on wrapper logic; this file is the lib's direct contract.
 */

import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";

import {
  verifyHubspotSignature,
  type SignatureCheckEvent,
} from "../lib/hubspot-signature";

// ---- Fixtures --------------------------------------------------------------

const CLIENT_SECRET = "test-client-secret-abc123";
const HOST = "example.execute-api.us-east-1.amazonaws.com";

/**
 * URL-decoder used while signing. Mirrors `decodeUriForSigning` in the
 * production code — HubSpot decodes a closed set of percent-encoded
 * characters before computing the HMAC.
 */
function decodeUri(uri: string): string {
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

/**
 * Compute the v3 signature exactly the way HubSpot does:
 *   message = method + uri + body + timestamp
 *   sig     = HMAC-SHA256(clientSecret, message), base64
 */
function sign(
  clientSecret: string,
  method: string,
  url: string,
  body: string,
  timestamp: string
): string {
  const message = method + decodeUri(url) + body + timestamp;
  return createHmac("sha256", clientSecret).update(message).digest("base64");
}

type EventOpts = {
  method?: string;
  rawPath?: string;
  rawQueryString?: string;
  body?: string;
  signature?: string;
  timestamp?: string;
  clientSecretForSigning?: string;
  isBase64Encoded?: boolean;
  /** Set false to omit the signature header. */
  includeSignature?: boolean;
  /** Set false to omit the timestamp header. */
  includeTimestamp?: boolean;
};

/**
 * Build a fully-formed event with a valid signature unless overridden.
 * Signs using `clientSecretForSigning ?? CLIENT_SECRET` so tests can
 * intentionally desync the signing key from the verifying key.
 */
function makeEvent(opts: EventOpts = {}): SignatureCheckEvent {
  const method = opts.method ?? "POST";
  const rawPath = opts.rawPath ?? "/share";
  const rawQueryString =
    opts.rawQueryString ??
    "userId=42&portalId=12345678&userEmail=test%40example.com&appId=39594762";
  const body = opts.body ?? '{"dealId":1}';
  const timestamp = opts.timestamp ?? String(Date.now());
  const url = rawQueryString
    ? `https://${HOST}${rawPath}?${rawQueryString}`
    : `https://${HOST}${rawPath}`;
  const signature =
    opts.signature ??
    sign(
      opts.clientSecretForSigning ?? CLIENT_SECRET,
      method,
      url,
      body,
      timestamp
    );

  const headers: Record<string, string> = {};
  if (opts.includeSignature !== false) {
    headers["x-hubspot-signature-v3"] = signature;
  }
  if (opts.includeTimestamp !== false) {
    headers["x-hubspot-request-timestamp"] = timestamp;
  }

  return {
    headers,
    rawPath,
    rawQueryString,
    body,
    isBase64Encoded: opts.isBase64Encoded ?? false,
    requestContext: {
      domainName: HOST,
      http: { method },
    },
  };
}

// ---- Tests -----------------------------------------------------------------

describe("verifyHubspotSignature", () => {
  test("happy path: valid signature → ok with extracted identity", () => {
    const result = verifyHubspotSignature(makeEvent(), CLIENT_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({
        hubId: "12345678",
        userId: "42",
        appId: "39594762",
        userEmail: "test@example.com",
      });
    }
  });

  test("missing signature header → no_signature_header", () => {
    const result = verifyHubspotSignature(
      makeEvent({ includeSignature: false }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_signature_header");
  });

  test("missing timestamp header → no_timestamp_header", () => {
    const result = verifyHubspotSignature(
      makeEvent({ includeTimestamp: false }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_timestamp_header");
  });

  test("timestamp older than 5 minutes → stale_timestamp", () => {
    const stale = String(Date.now() - 6 * 60 * 1000);
    const result = verifyHubspotSignature(
      makeEvent({ timestamp: stale }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_timestamp");
  });

  test("timestamp far in the future → stale_timestamp", () => {
    const future = String(Date.now() + 6 * 60 * 1000);
    const result = verifyHubspotSignature(
      makeEvent({ timestamp: future }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_timestamp");
  });

  test("non-numeric timestamp → stale_timestamp", () => {
    const result = verifyHubspotSignature(
      makeEvent({ timestamp: "not-a-number" }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_timestamp");
  });

  test("signature signed with wrong secret → invalid_signature", () => {
    const result = verifyHubspotSignature(
      makeEvent({ clientSecretForSigning: "different-secret" }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("body tampered after signing → invalid_signature", () => {
    const evt = makeEvent({ body: '{"dealId":1}' });
    evt.body = '{"dealId":99}';
    const result = verifyHubspotSignature(evt, CLIENT_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("path tampered after signing → invalid_signature", () => {
    const evt = makeEvent({ rawPath: "/share" });
    evt.rawPath = "/refresh";
    const result = verifyHubspotSignature(evt, CLIENT_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("method tampered after signing → invalid_signature", () => {
    const evt = makeEvent({ method: "POST" });
    const ctx = evt.requestContext as
      | { http?: { method?: string } }
      | undefined;
    if (ctx?.http) {
      ctx.http.method = "GET";
    }
    const result = verifyHubspotSignature(evt, CLIENT_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("signature with random base64 → invalid_signature", () => {
    const result = verifyHubspotSignature(
      makeEvent({ signature: "dGhpc2lzbm90YXJlYWxzaWc=" }),
      CLIENT_SECRET
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  test("base64-encoded body is decoded before signature check", () => {
    const body = '{"dealId":7}';
    const timestamp = String(Date.now());
    const rawQueryString =
      "userId=1&portalId=12345678&userEmail=a%40b.com&appId=39594762";
    const url = `https://${HOST}/share?${rawQueryString}`;
    const signature = sign(CLIENT_SECRET, "POST", url, body, timestamp);
    const evt = makeEvent({
      body: Buffer.from(body).toString("base64"),
      isBase64Encoded: true,
      rawQueryString,
      signature,
      timestamp,
    });
    const result = verifyHubspotSignature(evt, CLIENT_SECRET);
    expect(result.ok).toBe(true);
  });

  test("empty body is signed as empty string", () => {
    const timestamp = String(Date.now());
    const rawQueryString =
      "userId=1&portalId=12345678&userEmail=a%40b.com&appId=39594762";
    const url = `https://${HOST}/share?${rawQueryString}`;
    const signature = sign(CLIENT_SECRET, "POST", url, "", timestamp);
    const evt = makeEvent({ body: "", rawQueryString, signature, timestamp });
    const result = verifyHubspotSignature(evt, CLIENT_SECRET);
    expect(result.ok).toBe(true);
  });

  test("URL with no query string still verifies; identity fields empty", () => {
    const body = "{}";
    const timestamp = String(Date.now());
    const url = `https://${HOST}/share`;
    const signature = sign(CLIENT_SECRET, "POST", url, body, timestamp);
    const evt = makeEvent({
      body,
      rawQueryString: "",
      signature,
      timestamp,
    });
    const result = verifyHubspotSignature(evt, CLIENT_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({
        hubId: "",
        userId: "",
        appId: "",
        userEmail: "",
      });
    }
  });
});
