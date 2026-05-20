# AWS Partner Central Agents

## What are Partner Central Agents?

Partner Central Agents are AI-powered assistants that help AWS partners manage their sales pipeline, get funding recommendations, generate sales plays, create customer profiles, and automate opportunity management. They use natural language — just ask a question and get actionable insights.

---

## What can Partner Central Agents do?

| Capability | Example |
|------------|---------|
| Pipeline insights | "Which opportunities need my attention this week?" |
| Opportunity management | "Give me a summary of opportunity O1234567890" |
| Sales play generation | "Generate a sales play for this opportunity" |
| Customer profiling | "Create a customer profile for the customer on this deal" |
| Funding eligibility | "Am I eligible for MAP or POC funding?" |
| Funding estimation | "Estimate the POC funding amount for this opportunity" |
| Solution matching | "Which of our solutions best match this opportunity?" |
| Deal progression | "What do I need to do next to advance this deal?" |
| Document analysis | "Summarize the action items from these meeting notes" |
| Write operations | "Update the expected revenue to $300,000" (with approval) |

---

## How to access Partner Central Agents

There are multiple ways to access Partner Central Agents, ranging from non-technical (no code) to fully technical (build your own agent). Choose the path that fits your team's needs.

### 1. AWS Console

Use the built-in AI assistant directly in the AWS Partner Central console. No setup required.

**What you need:** AWS Partner Central account, browser

---

### 2. Kiro with MCP

Connect Partner Central Agents to your IDE via the Model Context Protocol (MCP). Get AI-powered assistance right in your development environment.

**What you need:** Kiro or Amazon Q IDE, Python package runner (uv), AWS credentials, MCP config

---

### 3. Python MCP Client

Build Python scripts that interact with Partner Central Agents programmatically. Automate pipeline queries, document analysis, and batch operations.

**What you need:** Python 3.10+, boto3, MCP SDK, MCP client, AWS credentials

---

### 4. External Tools

Connect Partner Central Agents to collaboration platforms and AI tools that support MCP.

**Supported tools:**
- Amazon Quick Desktop
- Slack
- Microsoft Teams
- Google Chat

**What you need:** MCP-compatible tool, AWS credentials, MCP config

---

### 5. Partner's Own CRM

Embed Partner Central Agents into your CRM system (Salesforce, HubSpot, etc.). Surface opportunity insights, funding eligibility, and sales plays directly within the tools your sales team uses daily.

**What you need:** CRM platform, API integration, SigV4 auth, CloudFormation templates, middleware/connector

---

### 6. API Integration & Build Your Own Agent

Integrate Partner Central Agents directly into your own applications via the API, or build your own AI agent that orchestrates Partner Central alongside other tools and data sources. Create multi-agent workflows, custom UIs, and fully autonomous pipelines.

**What you need:** API knowledge, SigV4 auth, LLM framework (Bedrock/LangChain), MCP servers, custom orchestration, infrastructure

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                    │
│  Console │ Kiro/Q │ Python │ Slack/Teams │ Partner CRM │ Custom Agent   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTPS / SSE
┌────────────────────────────────▼────────────────────────────────────────┐
│                       AUTH & TRANSPORT                                    │
│           AWS SigV4  │  IAM Credentials  │  Session Management           │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ MCP Protocol (JSON-RPC 2.0)
┌────────────────────────────────▼────────────────────────────────────────┐
│                         MCP SERVER                                        │
│     mcp-proxy-for-aws  │  sendMessage  │  getSession  │  Approvals       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ API Calls
┌────────────────────────────────▼────────────────────────────────────────┐
│                    PARTNER CENTRAL SERVICE                                │
│  Opportunities │ Funding │ Sales Plays │ Customer Insights │ Documents   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Resources

- [Partner Central Agents MCP Server — Overview](https://docs.aws.amazon.com/partner-central/latest/APIReference/partner-central-mcp-server.html)
- [Getting Started Guide](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)
- [Configuration Reference](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-configuration-reference.html)
- [Tools Reference](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-tools-reference.html)
- [AWS Partner Central Blog — How to Use Partner Central Agents](https://aws.amazon.com/blogs/awsmarketplace/how-to-use-aws-partner-central-agents/)


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

