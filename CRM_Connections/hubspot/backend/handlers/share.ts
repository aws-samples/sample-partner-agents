/**
 * Share Lambda handler (AWS API Gateway HTTP API v2).
 *
 * Thin wrapper around `runShare(dealId, deps)`. Responsibilities:
 *   1. Emit a `share.begin` structured-log line.
 *   2. Validate HubSpot's v3 HMAC signature on the request — the route
 *      itself is unauthenticated at the API Gateway level (REQUEST
 *      authorizers can't see the body, which the signature covers), so
 *      this Lambda is the actual auth gate.
 *   3. Parse `dealId` out of the event body. Malformed input ⇒ 400 INTERNAL.
 *   4. Load the app config from Secrets Manager. Missing secrets ⇒
 *      500 MISSING_SECRET, never touches the AWS or HubSpot clients.
 *   5. Construct real `AceClient` + `HubspotClient` from the config.
 *   6. Delegate to `runShare`.
 *   7. Serialise the typed `FunctionResponse` envelope as JSON with the
 *      HTTP status code derived from `statusCodeFor(response.code)`
 *      (or 200 on success).
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { runShare } from "../core/run-share";
import {
  loadConfigFromSecretsManager,
  loadAuthConfigFromSecretsManager,
} from "../lib/config";
import { createAceClient } from "../lib/ace";
import { createHubspotClient } from "../lib/hubspot";
import { ErrorCode, makeError } from "../lib/errors";
import { verifyHubspotSignature } from "../lib/hubspot-signature";
import {
  toProxyResult,
  statusCodeFor,
  parseDealId,
  logRequest,
  requestIdOf,
} from "./shared";

export const handler = async (
  event: APIGatewayProxyEventV2WithRequestContext<unknown>
): Promise<APIGatewayProxyResultV2> => {
  const reqId = requestIdOf(event);
  logRequest("share", reqId, event);

  // 1. Verify HubSpot's v3 HMAC signature.
  const auth = await loadAuthConfigFromSecretsManager();
  if (!auth.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.MISSING_SECRET,
        undefined,
        `Configuration error: missing secrets: ${auth.missing.join(", ")}. Contact your admin.`,
        { missingSecrets: auth.missing }
      ),
      500
    );
  }
  const sigResult = verifyHubspotSignature(event, auth.config.hubspotClientSecret);
  if (!sigResult.ok) {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        fn: "share",
        reqId,
        event: "auth.deny",
        details: { reason: sigResult.reason },
      })
    );
    return toProxyResult(
      makeError(
        ErrorCode.AUTH_INVALID,
        undefined,
        "Authorization failed. Reload the HubSpot page and try again."
      ),
      401
    );
  }

  // 2. Parse dealId.
  const dealId = parseDealId(event);
  if (dealId === undefined) {
    return toProxyResult(
      makeError(
        ErrorCode.INTERNAL,
        undefined,
        "Missing or invalid dealId in request body"
      ),
      400
    );
  }

  // 3. Load app config (secrets for ACE + HubSpot CRM API).
  const cfg = await loadConfigFromSecretsManager();
  if (!cfg.ok) {
    return toProxyResult(
      makeError(
        ErrorCode.MISSING_SECRET,
        undefined,
        `Configuration error: missing secrets: ${cfg.missing.join(", ")}. Contact your admin.`,
        { missingSecrets: cfg.missing }
      ),
      500
    );
  }

  // 4. Run the orchestration.
  const ace = createAceClient(cfg.config);
  const hs = createHubspotClient(cfg.config.hubspotPrivateAppToken);
  // PULL_LOCK_TABLE is injected by CFN. Optional from runShare's
  // perspective — when missing the cache seeding becomes a no-op.
  const lockTable = process.env.PULL_LOCK_TABLE;
  const response = await runShare(dealId, {
    config: cfg.config,
    ace,
    hs,
    ...(lockTable ? { lock: { tableName: lockTable } } : {}),
  });

  const status = response.ok ? 200 : statusCodeFor(response.code);
  return toProxyResult(response, status);
};
