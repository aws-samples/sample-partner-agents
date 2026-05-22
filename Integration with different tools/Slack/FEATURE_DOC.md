# Feature Doc — Partner Central Agent Slack Integration

**Status:** Deployed and validated in Sandbox (account 189444294458, us-east-1)

---

## Problem

AWS Partners run their day in Slack. Partner Central lives in a browser tab. The gap between them means:

- Pipeline reviews require a tool switch
- Opportunity updates get deferred because they're not frictionless
- Funding eligibility questions go unanswered in the moment they're asked
- Field teams on mobile have a poor Partner Central experience

## Solution

Embed the Partner Central Agent into Slack. Partners interact via slash commands, @mentions, or DMs. The AI agent handles intent. Human approvals happen with a button click. Context persists across a thread for up to 48 hours.

## Who benefits

| Role | Value |
|---|---|
| Partner Sales Rep | Quick pipeline lookups and field updates without leaving the conversation |
| Partner Account Manager | Thread-based deal reviews with the team, writes approved in place |
| Partner Development Manager | Team-wide pipeline visibility, coordinated next-step updates |
| Sales Ops | Faster data hygiene — partners update opportunities where they're already working |
| Mobile field teams | Full Partner Central agent capability on phone via Slack mobile |

## Architecture

```
Slack ──▶ API Gateway ──▶ Lambda (HTTP ack)
                                  │
                                  │ async self-invoke
                                  ▼
                          Lambda (Job Processor) ──SigV4──▶ Partner Central Agent MCP
                                  │                                    │
                                  │                                    │ SSE stream
                                  ▼                                    ▼
                          DynamoDB                          (text deltas + tool activity)
                          sessions + dedupe
                                  ▲
                                  │
                          Secrets Manager (Slack tokens)
```

**Why two Lambdas:** Slack's Events API requires a 200 response in under 3 seconds. MCP calls can take 5–30 seconds. The first Lambda acks quickly; the second does the slow work asynchronously.

**Why streaming:** partners see the agent thinking in real time, with labels like "🔍 fetching opportunity" or "📋 loading opportunities". Feels like a native AI assistant rather than a batch API call.

**Why DynamoDB for sessions and dedupe:** serverless, scales with usage, TTL auto-cleans expired entries, conditional-PUT gives atomic dedupe across Lambda containers.

## Key design decisions

1. **Thread = session, scoped by workspace.** Each Slack thread maps to one MCP session, keyed by `team_id:thread_ts`. Two Slack workspaces using the same bot deployment never collide.

2. **Human-in-the-loop for all writes.** Approval cards with Approve/Reject/Override buttons. Reject and Override open modals for user-provided reasons.

3. **Chained approval handling.** When the agent chains multiple writes (e.g., associate solution, then update opportunity), each write surfaces its own approval card.

4. **Slack markup sanitization.** Slack auto-wraps emails in `<mailto:...>` and URLs in `<http://...>`. The bot strips these before sending to MCP — otherwise the agent's guardrails treat them as garbage and refuse requests.

5. **Production safety gate.** Lambda refuses to start with `CATALOG=AWS` unless `ACKNOWLEDGE_PRODUCTION=true`. CloudFormation blocks stack creation at the same check.

6. **Secrets Manager for tokens.** No Slack tokens in Lambda env vars where they'd appear in console history.

## Validated scenarios

- Natural language queries via @mention and DM
- Slash commands: `/pc`, `/pc-opps`, `/pc-session`
- Threaded conversations with session continuity
- Single-step writes with approval
- Multi-step writes with chained approvals
- API validation failures surfaced with agent-proposed corrections
- Reject with reason, Override with instructions
- SSE streaming with tool activity indicators
- Rate limiting (2 req/min sustained, 10 burst)
- Slack retry deduplication
- All 7 MCP error codes mapped to user-friendly messages
- Session expiry after 48 hours

## Known limitations

1. **Sessions can get tainted.** If the MCP agent refuses a request in a session (guardrails), follow-ups in that session often inherit the refusal. Workaround: start a new thread.

2. **Cold starts add 1–2s.** Acceptable for a prototype. Provisioned concurrency solves it for production.

3. **Global rate limit.** All users share one 2 req/min bucket since they share AWS credentials. Per-user quotas would require per-user identity (OAuth + STS AssumeRole).

4. **One catalog per deployment.** Running both Sandbox and AWS requires two stacks.

## Future enhancements

| Enhancement | Value | Effort |
|---|---|---|
| File upload for document analysis | Partners analyze RFPs/proposals in Slack | M |
| Home tab dashboard | Pipeline summary at a glance | L |
| `/pc-funding <opp>` command | Dedicated funding shortcut | S |
| Auto-detect guardrail refusal → reset session | Smoother UX after refusals | M |
| Per-user AWS identity via OAuth | Enterprise audit trails | XL |
| Workflow Builder integration | No-code automation triggers | S |
| WAF on API Gateway | Defense-in-depth | S |

## Deployment

| Item | Value |
|---|---|
| Stack name | `slack-partner-central-bot` |
| Region | `us-east-1` |
| Catalog | `Sandbox` |
| Runtime | Node.js 20.x |
| Lambda timeout | 120s |
| Lambda memory | 512 MB |
| Session TTL | 48 hours |

See `README.md` for partner-facing setup instructions.

## References

- [Partner Central Agent MCP — Getting Started](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)
- [Partner Central Agent MCP — Tools Reference](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-tools-reference.html)
- [Slack Bolt for JavaScript](https://slack.dev/bolt-js/concepts)
- Spec files: `.kiro/specs/slack-partner-central/`
