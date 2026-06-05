/**
 * EventBridge handler — `aws.partnercentral-selling` events.
 *
 * Drives the AWS → HubSpot reverse-sync from real-time Partner Central
 * notifications (instead of polling). The event bus filtering happens
 * in CloudFormation (`AWS::Events::Rule`); this Lambda receives an
 * already-filtered subset:
 *
 *   - `Opportunity Created`
 *   - `Opportunity Updated`
 *
 * The handler is a thin shell:
 *   1. Validate the event shape.
 *   2. Load app config from Secrets Manager.
 *   3. Construct ACE + HubSpot clients (same wrappers Share / Refresh use).
 *   4. Delegate to `runPull(event, deps)`.
 *
 * No HubSpot signature verification — EventBridge events come from
 * AWS, not HubSpot. The Lambda is invoked exclusively by the
 * EventBridge rule (no public endpoint).
 *
 * ## Why we don't return a typed envelope
 *
 * EventBridge ignores Lambda return values; on failure it relies on
 * the Lambda's exit status (we throw to mark a failure). We still
 * log a structured outcome line so CloudWatch Insights queries can
 * filter pull.* events.
 */

import type {
  EventBridgeEvent,
  Context,
} from "aws-lambda";

import { runPull } from "../core/run-pull";
import type { AcePullEvent } from "../core/run-pull";
import { loadConfigFromSecretsManager } from "../lib/config";
import { createAceClient } from "../lib/ace";
import { createHubspotClient } from "../lib/hubspot";

type AceEventDetail = {
  schemaVersion?: string;
  catalog: string;
  opportunity: { identifier: string };
};

type RawEvent = EventBridgeEvent<
  "Opportunity Created" | "Opportunity Updated",
  AceEventDetail
>;

export const handler = async (
  event: RawEvent,
  _ctx: Context
): Promise<void> => {
  const detailType = event["detail-type"];
  const detail = event.detail ?? ({} as AceEventDetail);
  const oppId = detail.opportunity?.identifier ?? "";

  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "pull",
      event: "pull.begin",
      detailType,
      catalog: detail.catalog,
      oppId,
    })
  );

  if (detailType !== "Opportunity Created" && detailType !== "Opportunity Updated") {
    // The EventBridge rule should keep us from seeing these — log
    // and exit cleanly so a misconfigured rule doesn't trigger a
    // retry storm.
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "warn",
        fn: "pull",
        event: "pull.unrecognised_event",
        detailType,
      })
    );
    return;
  }

  const cfg = await loadConfigFromSecretsManager();
  if (!cfg.ok) {
    // Missing secrets is a config error worth surfacing as a Lambda
    // failure — EventBridge will retry per the destination policy.
    throw new Error(
      `Configuration error: missing secrets: ${cfg.missing.join(", ")}`
    );
  }

  const lockTable = process.env.PULL_LOCK_TABLE;
  if (!lockTable) {
    // CFN injects this; absence means the stack is misconfigured.
    // Throwing surfaces the failure in CloudWatch Metrics.
    throw new Error(
      "Configuration error: PULL_LOCK_TABLE env var not set; redeploy the stack."
    );
  }

  const ace = createAceClient(cfg.config);
  const hs = createHubspotClient(cfg.config.hubspotPrivateAppToken);
  const pullEvent: AcePullEvent = {
    detailType,
    detail: {
      catalog: detail.catalog,
      opportunity: { identifier: oppId },
    },
  };

  const outcome = await runPull(pullEvent, {
    config: cfg.config,
    ace,
    hs,
    lock: { tableName: lockTable },
  });
  if (!outcome.ok) {
    // Throw so EventBridge marks the invocation failed — that lets
    // the operator see the failure in CloudWatch Metrics
    // (Lambda Errors) and configure a DLQ via the function's
    // `DeadLetterConfig` if they want one.
    throw new Error(`${outcome.code}: ${outcome.message}`);
  }
  if (outcome.action === "lock_held") {
    // Another invocation is processing the same opp. Throw so
    // EventBridge retries this delivery with exponential backoff;
    // by the time the retry fires, the holder has either completed
    // (we'll find the deal and Refresh) or expired (the lease
    // expression lets the retry steal the lock).
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        fn: "pull",
        event: "pull.lock_held",
        oppId,
        reason: outcome.reason,
      })
    );
    throw new Error(`LOCK_HELD: ${outcome.reason}`);
  }
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      fn: "pull",
      event: `pull.ok.${outcome.action}`,
      oppId,
      ...(outcome.dealId !== undefined ? { dealId: outcome.dealId } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    })
  );
};
