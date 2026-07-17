# Setting Up AWS MCP Servers Across MCP Clients

A step-by-step guide to configuring the AWS MCP and Partner Central Agents MCP servers across six clients: Amazon Quick Desktop, Claude Cowork, Cursor, Kiro, OpenAI Codex, and GitHub Copilot.

---

## 1. Introduction & Shared Prerequisites

This guide walks through configuring two AWS MCP servers in each of six MCP clients. The core configuration values are identical everywhere — only the config file location, the format (JSON, plain string, or TOML), and a few client-specific quirks change.

### The two MCP servers

- **Partner Central Agents MCP** — conversational access to AWS Partner Central (`send_message` and related tools).
- **AWS MCP** — general AWS access and documentation search (`call_aws`, `search_documentation`).

### Prerequisites (must be installed first)

The MCP servers will not work without these. Always verify explicitly rather than assuming they are installed:

- **uv / uvx** — check with `which uvx`; `uvx --version`. On macOS, prefer the Homebrew install (`brew install uv`).
- **AWS CLI** — check with `which aws`; `aws --version`. Needed for credential management.

> **Tip:** shells differ (bash vs zsh) and tools installed via Homebrew or mise may live at non-standard paths. Source your `.zshrc`/`.bashrc` before concluding a tool is missing.

### AWS login (partner-central profile)

Set up the `partner-central` profile. The easiest option opens a browser for you to log in:

```
aws login --profile partner-central --region us-east-1
```

Confirm the login succeeded (should return an IAM ARN):

```
aws sts get-caller-identity --profile partner-central --region us-east-1
```

Partner Central services live in `us-east-1` — use that region.

### Install the proxy

Install the pinned version of the proxy (pinned for env-variable compatibility and to avoid reinstalls on startup):

```
uv tool install mcp-proxy-for-aws@1.6.3
```

---

## 2. Shared Config Values

These values are the same across every client. Only the wrapping format and file location differ (covered per client below).

### Command & arguments

- **Command:** `uvx`
- **Transport:** local / stdio

**Partner Central Agents — arguments:**

```
mcp-proxy-for-aws https://partnercentral-agents-mcp.us-east-1.api.aws/mcp --service partnercentral-agents-mcp --region us-east-1
```

**AWS MCP — arguments:**

```
mcp-proxy-for-aws https://aws-mcp.us-east-1.api.aws/mcp --profile partner-central --metadata AWS_REGION=us-east-1
```

### Required environment variables

Both variables are required for both servers — do not skip them:

```
AWS_MCP_PROXY_PROFILES=partner-central
AWS_PROFILE=partner-central
```

The rest of this guide shows how to wrap these exact values for each client.

---

## 3. Amazon Quick Desktop

Quick Desktop has the simplest config UX: its GUI accepts a pasted JSON (one per server), and the arguments can be entered as a plain string that the UI parses automatically.

### Config steps

- Open Settings → Capabilities → MCP and choose **+ Add MCP / Skill**.
- Select connection type **Local (stdio)**.
- Enter the server name, command `uvx`, and paste the arguments as a plain string (shown below).
- Add the two environment variables.
- Repeat for the second server. Enable each server; restart Quick if the tools don't appear.

**Partner Central Agents — arguments (plain string):**

```
mcp-proxy-for-aws https://partnercentral-agents-mcp.us-east-1.api.aws/mcp --service partnercentral-agents-mcp --region us-east-1
```

**AWS MCP — arguments (plain string):**

```
mcp-proxy-for-aws https://aws-mcp.us-east-1.api.aws/mcp --profile partner-central --metadata AWS_REGION=us-east-1
```

**Environment variables (both servers):** `AWS_MCP_PROXY_PROFILES=partner-central`, `AWS_PROFILE=partner-central`.

### Gotchas

- You may need to enable the server and restart the app before the tools become visible.
- If tools fail to load: verify AWS credentials, confirm VPN, toggle the integration off/on, and restart.

---

## 4. Claude Cowork

Cowork can run the shell steps itself (installs, login) and edits a JSON config file. It uses the JSON-array argument format. Note there are two different config file locations depending on the mode.

### Config steps

- **Normal GUI:** Settings → Developer → Local MCP servers.
- **Custom inference GUI:** Inference configuration → Connectors & extensions → Managed MCP servers.
- Or edit the config file directly (paths below), then restart Cowork.

**Config file locations:**

```
# Normal:
~/Library/Application Support/Claude/claude_desktop_config.json

# Custom inference:
~/Library/Application Support/Claude-3p/configLibrary/<udid>.json
```

**Config (JSON-array format):**

```json
{
  "mcpServers": {
    "partner-central-agents": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
        "--service", "partnercentral-agents-mcp", "--region", "us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    },
    "aws-mcp": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--profile", "partner-central", "--metadata", "AWS_REGION=us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    }
  }
}
```

### Gotchas

- The `curl` uv installer does not work in Cowork — use the Homebrew install for uv instead.
- Pick the correct config file: writing to the wrong one (normal vs custom inference) silently does nothing.

---

## 5. Cursor IDE

Cursor has an integrated terminal and can run the install/auth steps itself. It uses the standard `mcpServers` JSON schema. Not covered in the runbook explicitly — falls into the "other clients" path.

### Config steps

- Create/edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project).
- Use the JSON-array config (same as the Cowork block).
- Enable the servers under Settings → MCP (toggle on; watch for the green status dot).

```json
{
  "mcpServers": {
    "partner-central-agents": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
        "--service", "partnercentral-agents-mcp", "--region", "us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    },
    "aws-mcp": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--profile", "partner-central", "--metadata", "AWS_REGION=us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    }
  }
}
```

### Gotchas

- **PATH not inherited:** if `uvx` was installed via Homebrew/mise, Cursor's MCP process may not find it. Use an absolute path to `uvx` in the command field.
- The curl uv installer works fine here (Cowork-only caveat).
- Reload/restart Cursor if servers don't appear after saving.

---

## 6. Kiro

Kiro is AWS's agentic IDE, so the AWS-auth step is the most likely to "just work." It uses the `mcpServers` JSON schema. Also an "other clients" case in the runbook.

### Config steps

- Create/edit `~/.kiro/settings/mcp.json` (global) or `.kiro/settings/mcp.json` (workspace).
- Use the JSON-array config (identical to the Cursor block).
- Manage/enable the servers in Kiro's MCP Servers feature panel; it hot-reloads on save.

```json
{
  "mcpServers": {
    "partner-central-agents": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
        "--service", "partnercentral-agents-mcp", "--region", "us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    },
    "aws-mcp": {
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--profile", "partner-central", "--metadata", "AWS_REGION=us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    }
  }
}
```

### Gotchas

- **PATH not inherited:** same as Cursor — use an absolute path to `uvx` if the server can't start.
- Set autoApprove / tool trust for `send_message`, `call_aws`, and `search_documentation` so validation isn't blocked by prompts.

---

## 7. OpenAI Codex

Codex (CLI/IDE agent) runs locally with terminal access. Its biggest difference: config lives in TOML, not JSON. The values are unchanged — only the serialization differs.

### Config steps

- Edit `~/.codex/config.toml`.
- Add each server as a `[mcp_servers.<name>]` table (below).
- Start a new Codex session so the config is picked up.

```toml
[mcp_servers.partner-central-agents]
command = "uvx"
args = ["mcp-proxy-for-aws",
  "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
  "--service", "partnercentral-agents-mcp", "--region", "us-east-1"]
env = { AWS_MCP_PROXY_PROFILES = "partner-central", AWS_PROFILE = "partner-central" }

[mcp_servers.aws-mcp]
command = "uvx"
args = ["mcp-proxy-for-aws",
  "https://aws-mcp.us-east-1.api.aws/mcp",
  "--profile", "partner-central", "--metadata", "AWS_REGION=us-east-1"]
env = { AWS_MCP_PROXY_PROFILES = "partner-central", AWS_PROFILE = "partner-central" }
```

### Gotchas

- **Approval / sandbox mode:** Codex must be in a mode that permits command execution and network/browser access, or installs and `aws login` are blocked.
- **TOML is strict:** a stray quote or bracket breaks all servers — edit carefully.
- **PATH not inherited:** use an absolute path to `uvx` if needed.

---

## 8. GitHub Copilot

Copilot supports MCP through agent mode (VS Code, Visual Studio, JetBrains). It uses the JSON schema, but the file location is host-specific and MCP tools only work in agent mode.

### Config steps

- **VS Code:** create `.vscode/mcp.json` (workspace). Note VS Code uses a top-level `servers` key.
- **Visual Studio:** `.mcp.json` in the solution dir or user profile.
- Switch Copilot Chat to **Agent mode**, then confirm the tools appear in the tools picker.

```json
{
  "servers": {
    "partner-central-agents": {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp",
        "--service", "partnercentral-agents-mcp", "--region", "us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    },
    "aws-mcp": {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-proxy-for-aws",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--profile", "partner-central", "--metadata", "AWS_REGION=us-east-1"],
      "env": {"AWS_MCP_PROXY_PROFILES": "partner-central",
              "AWS_PROFILE": "partner-central"}
    }
  }
}
```

### Gotchas

- MCP tools only work in **Agent mode** — not Ask/Edit modes.
- **Org policy gate:** GitHub org admins can disable Copilot MCP entirely — if so, no local config registers.
- Approve/trust the tool + terminal prompts; watch the active-tools limit and the PATH gotcha.

---

## 9. Validation & Troubleshooting

### Validation steps

- Enable the servers (and restart the client if needed) so the tools become visible.
- Test a tool from each server: `send_message` (Partner Central Agents), and `call_aws` / `search_documentation` (AWS MCP).
- Re-check identity: `aws sts get-caller-identity --profile partner-central` should return an IAM ARN. Confirm the account ID and role look correct.
- If a server won't start, run the `uvx` command directly (with a timeout) and read the logs to spot dependency/PATH issues.

### Common gotchas (all clients)

- **PATH not inherited** — the #1 startup failure. Use an absolute path to `uvx` in the command field.
- **Wrong config format/location** — JSON vs TOML, and per-client file paths. Match the client.
- **Tools not enabled / client not restarted** — many clients need an explicit toggle or reload.

### External blockers (no client can self-resolve)

1. **AWS IAM permissions.** If Partner Central returns `Access Denied`, your IAM identity is missing invoke permissions. You may not be an admin — this usually requires working with your AWS admin to grant the right permissions.
2. **Corporate SSO / identity.** The `aws login` browser flow depends on your Amazon SSO setup cooperating. Ensure you're on VPN if required.

### Quick reference: config format & location

| Client | Format | Location | Signature gotcha |
| --- | --- | --- | --- |
| Quick Desktop | Paste JSON (GUI) | Settings → Capabilities → MCP | Enable + restart |
| Claude Cowork | JSON | `claude_desktop_config.json` (or Claude-3p) | Two paths; curl uv fails |
| Cursor | JSON (mcpServers) | `~/.cursor/mcp.json` | PATH not inherited |
| Kiro | JSON (mcpServers) | `~/.kiro/settings/mcp.json` | PATH; tool trust |
| OpenAI Codex | TOML | `~/.codex/config.toml` | Approval mode; strict TOML |
| GitHub Copilot | JSON (servers) | `.vscode/mcp.json` (VS Code) | Agent mode; org policy |

> **Remember:** the command, arguments, and the two environment variables are identical everywhere. Only the wrapper format and file location change.
