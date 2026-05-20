# Programmatic Access to Partner Central Agents via MCP

## What are these code samples?

These code samples provide you examples on how to programmatically connect to AWS Partner Central Agents using the Model Context Protocol (MCP). Instead of using the AWS console UI, you'll build your own client that can query your sales pipeline, get funding recommendations, generate sales plays, and manage opportunities — all from code.

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

## Quick guide

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

- [Workshop Link](https://catalog.workshops.aws/mpseller/en-US/pc-agents)
- [Partner Central MCP Server docs](https://docs.aws.amazon.com/partner-central/latest/APIReference/partner-central-mcp-server.html)
- [Getting Started Guide](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)

