/**
 * Refresh Lambda handler (AWS API Gateway HTTP API v2).
 *
 * Mirror of `share.ts` — same responsibilities, but delegates to
 * `runRefresh` instead of `runShare`. See `share.ts` for the rationale on
 * why HubSpot's v3 signature is validated inside the Lambda rather than
 * via an API Gateway authorizer.
 */

import type {
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { runRefresh } from "../core/run-refresh";
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
  logRequest("refresh", reqId, event);

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
        fn: "refresh",
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

  // 3. Load app config.
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
  const response = await runRefresh(dealId, { config: cfg.config, ace, hs });

  const status = response.ok ? 200 : statusCodeFor(response.code);
  return toProxyResult(response, status);
};
