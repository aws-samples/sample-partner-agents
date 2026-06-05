/**
 * Read a small set of HubSpot deal properties to compose a deal-context
 * preamble for outbound MCP user messages. Best-effort: any failure
 * here is swallowed and the agent receives no preamble — the user
 * still gets a working chat, just without the auto-injected context.
 *
 * Why a separate, narrow module rather than reusing the heavyweight
 * `@hubspot/api-client` from the share/refresh path: this lookup runs
 * on every user message. We want a tiny, fast read with no SDK
 * initialisation cost. The native `fetch` call hits the public HubSpot
 * v3 API directly — same endpoint the SDK uses, with no transitive
 * dependencies pulled into the Lambda bundle.
 */

const HS_BASE = "https://api.hubapi.com" as const;

const PROPERTIES_TO_FETCH = [
  "dealname",
  "ace_opportunity_id",
  "ace_aws_account_id",
  "ace_sync_status",
  "amount",
  "closedate",
] as const;

export type DealContext = {
  dealId: number;
  dealname?: string;
  aceOpportunityId?: string;
  aceAwsAccountId?: string;
  aceSyncStatus?: string;
  amount?: string;
  closedate?: string;
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export type DealContextDeps = {
  privateAppToken: string;
  fetchImpl?: FetchLike;
};

/**
 * Best-effort fetch of a deal's context-relevant properties. Returns
 * `undefined` on any error — the orchestration treats that as "no
 * preamble" rather than surfacing the error to the user. The error is
 * logged for operators.
 */
export async function fetchDealContext(
  dealId: number,
  deps: DealContextDeps
): Promise<DealContext | undefined> {
  const fetchImpl: FetchLike =
    deps.fetchImpl ??
    (async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, text: () => r.text() };
    });

  const url =
    `${HS_BASE}/crm/v3/objects/deals/${encodeURIComponent(String(dealId))}` +
    `?properties=${PROPERTIES_TO_FETCH.join(",")}`;

  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${deps.privateAppToken}`,
        accept: "application/json",
      },
    });
    if (resp.status !== 200) return undefined;

    const body = JSON.parse(await resp.text()) as {
      properties?: Record<string, string | undefined>;
    };
    const p = body.properties ?? {};
    return {
      dealId,
      ...(p.dealname ? { dealname: p.dealname } : {}),
      ...(p.ace_opportunity_id
        ? { aceOpportunityId: p.ace_opportunity_id }
        : {}),
      ...(p.ace_aws_account_id
        ? { aceAwsAccountId: p.ace_aws_account_id }
        : {}),
      ...(p.ace_sync_status ? { aceSyncStatus: p.ace_sync_status } : {}),
      ...(p.amount ? { amount: p.amount } : {}),
      ...(p.closedate ? { closedate: p.closedate } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Render the deal context as a single-paragraph preamble the agent
 * should treat as background context. Excludes empty fields so the
 * preamble doesn't carry "amount: undefined" noise.
 *
 * Returns an empty string when context is undefined (no preamble).
 */
export function renderDealContextPreamble(
  ctx: DealContext | undefined
): string {
  if (ctx === undefined) return "";

  const parts: string[] = [];
  parts.push(`HubSpot deal id ${ctx.dealId}`);
  if (ctx.dealname) parts.push(`name "${ctx.dealname}"`);
  if (ctx.aceOpportunityId) {
    parts.push(`ACE opportunity ${ctx.aceOpportunityId}`);
  } else {
    parts.push("not yet shared with Partner Central");
  }
  if (ctx.aceSyncStatus) parts.push(`sync status: ${ctx.aceSyncStatus}`);
  if (ctx.aceAwsAccountId) parts.push(`AWS account ${ctx.aceAwsAccountId}`);
  if (ctx.amount) parts.push(`amount ${ctx.amount}`);
  if (ctx.closedate) parts.push(`close date ${ctx.closedate}`);

  return (
    `[CONTEXT — auto-injected from HubSpot, do not echo back] ` +
    `You are acting on ${parts.join(", ")}. ` +
    `Use this as the default opportunity for any reference to "this deal" / ` +
    `"this opportunity" / "this customer" unless the user explicitly names ` +
    `a different one.`
  );
}
