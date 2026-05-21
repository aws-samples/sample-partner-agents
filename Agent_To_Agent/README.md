# Agent-to-Agent

Sample applications demonstrating **agent-to-agent communication** with the AWS Partner Central MCP Agent. A custom orchestrator agent in this repo delegates Partner Central operations to the AWS-hosted Partner Central Agent rather than calling the Partner Central APIs directly. The agent understands Partner Central business rules and validation, and applies a human-in-the-loop approval workflow before any write.

## What's Inside

| Folder | Description |
|--------|-------------|
| [`CLI_Approach/`](./CLI_Approach/) | Minimal command-line orchestrator. Reads context from meeting notes, files, or Slack, and updates a Partner Central opportunity through the MCP Agent. Best for scripts, scheduled jobs, and headless integrations. |
| [`UI_Approach/`](./UI_Approach/) | Full Flask + FastAPI demo application with a web UI. Adds CRM integrations (HubSpot, Salesforce, Pipedrive), bidirectional sync, conversational chat with the Partner Central Agent, and side-by-side workflows for creating and updating opportunities. Best for end-to-end demos and exploring the full agent-to-agent pattern. |

## Why Agent-to-Agent?

Direct API integration:
```
Your Code → Partner Central API
```

Agent-to-agent:
```
Your Agent → Partner Central MCP Agent → Partner Central API
```

Benefits:
- **Domain expertise** — the Partner Central Agent knows the business rules, valid enum values, and validation requirements
- **Natural language** — communicate intent ("update next steps") rather than constructing API payloads
- **Built-in guardrails** — every write goes through an explicit approval gate
- **Less integration code** — the agent handles the Partner Central specifics so your code can focus on context gathering and orchestration

## Getting Started

Pick the approach that fits your use case and follow the README inside that folder:
- For a quick CLI tour → [`CLI_Approach/README.md`](./CLI_Approach/README.md)
- For the full UI workshop → [`UI_Approach/README.md`](./UI_Approach/README.md)
