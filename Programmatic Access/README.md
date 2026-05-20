# Programmatic Access to Partner Central Agents via MCP — Workshop

## What is this workshop?

This hands-on workshop teaches you how to programmatically connect to AWS Partner Central Agents using the Model Context Protocol (MCP). Instead of using the AWS console UI, you'll build your own client that can query your sales pipeline, get funding recommendations, generate sales plays, and manage opportunities — all from code.

---

## What you'll do

| Step | Activity | What you'll build/learn |
|------|----------|------------------------|
| **1** | Set up IAM permissions | Configure AWS credentials and policies for MCP access |
| **2** | Build a Python MCP client | Create a reusable client that handles SigV4 auth, JSON-RPC, and SSE streaming |
| **3** | Verify your setup | Test the connection to the Partner Central Agent MCP Server |
| **4** | Explore agent capabilities | Query your pipeline, generate sales plays, get funding eligibility, create customer profiles |
| **5** | Build an interactive chat | Create a CLI chat with real-time streaming and human-in-the-loop approval for write operations |
| **6** | Attach documents for analysis | Upload meeting notes, proposals, or call transcripts for AI-powered analysis |
| **7** | Understand Sandbox vs. Production | Learn when to use each catalog and how to switch |

---

## What you'll learn

- How to authenticate with the Partner Central MCP endpoint using AWS SigV4
- How to send messages and handle streaming (SSE) responses
- How to manage multi-turn conversation sessions
- How to handle the human-in-the-loop approval workflow for write operations
- How to upload and analyze documents programmatically
- How to build automation scripts for pipeline management

---

## Agent capabilities you'll use

| Capability | Example |
|------------|---------|
| Pipeline insights | "Which opportunities need my attention this week?" |
| Opportunity summary | "Give me a summary of opportunity O1234567890" |
| Sales play generation | "Generate a sales play for this opportunity" |
| Customer profiling | "Create a customer profile for the customer on this deal" |
| Funding eligibility | "Am I eligible for MAP or POC funding?" |
| Solution matching | "Which of our solutions best match this opportunity?" |
| Deal progression | "What do I need to do next to advance this deal?" |
| Document analysis | "Summarize the action items from these meeting notes" |

---

## Prerequisites

Before starting, make sure you have:

- [ ] AWS Partner Central account (migrated to AWS console)
- [ ] AWS account with IAM permissions
- [ ] AWS CLI v2 installed and configured
- [ ] Python 3.10+ installed
- [ ] Access to `us-east-1` region
- [ ] HTTPS connectivity to `partnercentral-agents-mcp.us-east-1.api.aws`

---

## Time & skill level

| | |
|---|---|
| **Duration** | ~60 minutes |
| **Skill level** | Intermediate |
| **Assumed knowledge** | AWS CLI, IAM basics, Python, HTTP/JSON concepts |

---

## Workshop files

| File | Purpose |
|------|---------|
| `pc_mcp_client.py` | Reusable MCP client library (SigV4 auth, JSON-RPC, streaming) |
| `test_connection.py` | Verify your setup is working |
| `explore_capabilities.py` | Demonstrate all agent capabilities |
| `pipeline_chat.py` | Interactive chat with streaming and write approval |
| `document_chat.py` | Upload and analyze documents |
| `sample_meeting_notes.txt` | Sample file for document analysis |

---

## Architecture

```
┌─────────────────┐       SigV4 Auth        ┌──────────────────────────────┐
│                  │  ───────────────────►    │  Partner Central Agent       │
│  Your MCP Client │  JSON-RPC 2.0 / HTTPS   │  MCP Server                  │
│  (Python, etc.)  │  ◄───────────────────    │  us-east-1.api.aws/mcp       │
│                  │  SSE Streaming           │                              │
└─────────────────┘                          └──────────────────────────────┘
```

---

## Quick start

```bash
# 1. Install dependencies
pip install boto3 requests requests-aws4auth sseclient-py

# 2. Configure AWS credentials
aws configure

# 3. Test the connection
python test_connection.py

# 4. Explore capabilities
python explore_capabilities.py

# 5. Start interactive chat
python pipeline_chat.py

# 6. Attach documents for analysis
python document_chat.py
```

---

## Getting help

- Full workshop guide: `https://catalog.workshops.aws/mpseller/en-US/pc-agents`
- [Partner Central MCP Server docs](https://docs.aws.amazon.com/partner-central/latest/APIReference/partner-central-mcp-server.html)
- [Getting Started Guide](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)

