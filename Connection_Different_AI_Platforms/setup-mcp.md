# Configuring the AWS MCP Servers

You are helping to configure AWS MCP and Partner Central Agents servers for a **business** user, they might not be familiar with CLIs or MCPs, so use appropriate language and instructions until you know their proficiency level. If you ever need to ask the user to run commands for you (you generally shouldn't – always first try it yourself) – never dump a list of more than 2 commands / ask to install more than one tool in one go, instead take it progressively. One command/tool per turn.

## Prerequisites

The MCP server will simply not work without these being installed and working.

- uv/uvx needs to be installed. MUST explicitly check by running `which uvx; uvx --version`, do not assume installed. If you can't run shell commands (unlikely but happens) – ask the user to do it manually in their terminal.
  1. If not installed – read [https://docs.astral.sh/uv/getting-started/installation/](https://docs.astral.sh/uv/getting-started/installation/) and run or provide the user with commands to run, according to what OS they use. For macOS – prefer the Homebrew installation. Something like `command -v uv &>/dev/null || (command -v brew &>/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install uv) || curl -LsSf https://astral.sh/uv/install.sh | sh`. The curl version doesn't work in Claude Cowork for some reason.
  2. After installation, confirm with `uvx --version` again.
- AWS CLI needs to be installed (for AWS credentials management). MUST explicitly check by running `which aws; aws --version`, do not assume installed. If you can't run shell commands (unlikely but happens) – ask the user to do it manually in their terminal.
  1. If not installed – read [https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)  and run or provide the user with commands to run, according to what OS they use.
  2. After installation, confirm with `aws --version` again.
- Log in with AWS CLI to set up the "partner-central" profile
  1. The easiest option is to use `aws login --profile partner-central`, this automatically opens the browser for the user to log in (even if you run it). Just run it for them and let them confirm in the browser. We usually need the `us-east-1` region as that's where all the Partner Central services are, have the user select that (or directly do `aws login --profile partner-central --region us-east-1`).
    1. Confirm login with `aws sts get-caller-identity --profile partner-central --region us-east-1`
  2. If the above fails multiple times, or if the user rejects/wants to use something else – read [https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html) to see the alternative ways to authenticate. Usually these are harder to do and only apply to more proficient users. Avoid usign a setup like hardcoded IAM role credentials, as it would require constant maintenance by the user and would end up annoying them a lot.
- Run `uv tool install mcp-proxy-for-aws@1.6.3`. We are pinning the version to ensure env variables compatibility and to avoid constant reinstalls by uvx when starting the MCP server, feel free to update the version to a newer one if needed – but test to make sure the env variables and arguments still work as expected.

Note: there might be nuances like your shell might run bash while they use zsh (most macOS users), etc. So make sure you are properly sourcing their .zshrc or .bashrc, etc. before claiming tools aren't installed. Just some caution to make sure you're not annoying the user for no reason. They also might be using things like mise, Homebrew, etc. This means that the installs might be located at different paths. You could ask the user to run `which aws; which uvx; aws --version; uvx --version` if you are unable to find the installs – they would provide the output back to you.

## MCP configuration

- If you can directly set this up for the user in your config – awesome, look up the documentation for your app/harness and do it yourself. If you can't then look up the documentation and guide the user where to navigate first, then provide the configuration from below.
- If your configuration is a file – DO NOT start with asking the user to run any commands to open/edit the file. Try it yourself first.
- Never ask to run multiline `cat >` commands or similar. Hight risk to mess things up. Prefer `open <file>` or equivalent commands to launch GUI editors. Do not ask to fully replace the file content - first make sure to read the file (or ask them to paste the current content – only if you can't read).
- Note for Claude Desktop/Cowork: the normal mode and the custom inference mode use different config file locations (as of Jul 2026).
  - Normal GUI: Settings > Developer > Local MCP servers
  - Custom inference GUI: Inference configuration > Connectors & extensions > Managed MCP servers
  - Normal file: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
  - Custom inference file: `~/Library/Application\ Support/Claude-3p/configLibrary/<udid>.json`
- Note for Quick Desktop: Quick's GUI MCP configuration allows the user to paste a JSON (one per server). Prefer that route vs entering values one by one.

### Partner Central Agents

More here: [https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html](https://docs.aws.amazon.com/partner-central/latest/APIReference/mcp-getting-started.html)

1. **Type/transport**: local/stdio
2. **Command**: `uvx`
3. **Arguments** (client-dependent):
  - Claude (takes a JSON array): `["mcp-proxy-for-aws",  "https://partnercentral-agents-mcp.us-east-1.api.aws/mcp", "--service", "partnercentral-agents-mcp", "--region", "us-east-1"]`
  - Amazon Quick Desktop (takes a plain string on the UI, automatically parses): `mcp-proxy-for-aws https://partnercentral-agents-mcp.us-east-1.api.aws/mcp --service partnercentral-agents-mcp --region us-east-1`
  - Other clients: look up MCP configuration documentation for the specific client and adjust accordingly. The arguments won't change, only the format can.
4. **Environment variables** (absolute must, do not skip!):
  - `AWS_MCP_PROXY_PROFILES=partner-central` or `"AWS_MCP_PROXY_PROFILES": "partner-central"`
  - `AWS_PROFILE=partner-central` or `"AWS_PROFILE": "partner-central"`

### AWS MCP

More here: [https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/getting-started-aws-mcp-server.html)

1. **Type/transport**: local/stdio
2. **Command**: `uvx`
3. **Arguments** (client-dependent):
  - Claude (takes a JSON array): `["mcp-proxy-for-aws", "https://aws-mcp.us-east-1.api.aws/mcp", "--profile", "partner-central", "--metadata", "AWS_REGION=us-east-1"]`
  - Amazon Quick Desktop (takes a plain string on the UI, automatically parses): `mcp-proxy-for-aws https://aws-mcp.us-east-1.api.aws/mcp --profile partner-central --metadata AWS_REGION=us-east-1`
  - Other clients: look up MCP configuration documentation for the specific client and adjust accordingly. The arguments won't change, only the format can.
4. **Environment variables** (absolute must, do not skip!):
  - `AWS_MCP_PROXY_PROFILES=partner-central` or `"AWS_MCP_PROXY_PROFILES": "partner-central"`
  - `AWS_PROFILE=partner-central` or `"AWS_PROFILE": "partner-central"`

## Validate

- Depending on the client, the user might have to enable the servers for them to become visible to you. They might need to restart the application as well. Instruct them based on your harness' documentation.
- If the tools aren't visible: it's likely that the mcp server isn't starting. You can directly try it by running the uvx command and checking the logs (just make sure you have a timeout for the command, because if stdio actually starts – then it will stay running and never exit).
  - Fix any dependency or installation issues
- Try calling the MCPs as a test. Make sure that you get a proper response.
  - Try `send_message` (Partner Central Agents MCP), `call_aws` and `search_documentation` (AWS MCP)
- If the tools are visible but are not working because of authorization/authentication issues
  - Re-validate if the config is correct by running `aws sts get-caller-identity --profile partner-central`. This command should succeed and return an IAM ARN. 
    - Try running this command both locally (with --profile) AND `aws sts get-caller-identity` (without --profile) via the AWS MCPs "Call Aws" tool – you might see different results based on the MCP configuration (the --profile or the environment variables).
    - If it doesn't work – the authentication was not setup correctly, re-do it.
    - If it does work – check with the user if the AWS account ID and the Role/User name look correct to them, and if they see the same ones in the [AWS Console]([https://us-east-1.console.aws.amazon.com/partnercentral/dashboard?region=us-east-1](https://us-east-1.console.aws.amazon.com/partnercentral/dashboard?region=us-east-1)) on the top right. If not – re-do the login.
  - If the Partner Central MCP is failing due to authorization issues (Access Denied) – then read its Getting Started guide to set up the proper permissions. Note: the user might not be an Admin and not have access to IAM to add permissions for themselves. Do this: 
    - Check what permissions they have by using commands like `aws iam get-account-authorization-details`, `aws iam list-role-policies --role-name <role-name>`, `aws iam get-policy-version --policy-arn <arn> --version-id v1`, `aws iam get-user-policy --user-name <username> --policy-name <name>`. There are more such commands, look it up online if needed.
    - Provide them with the exact list of missing permissions (prefer AWS managed policies over inline, but combine both if unavoidable. Partner Central managed policies: [https://docs.aws.amazon.com/partner-central/latest/getting-started/managed-policies.html](https://docs.aws.amazon.com/partner-central/latest/getting-started/managed-policies.html). Marketplace managed policies: [https://docs.aws.amazon.com/marketplace/latest/userguide/security-iam-awsmanpol.html](https://docs.aws.amazon.com/marketplace/latest/userguide/security-iam-awsmanpol.html)).
    - Have them attach these if they can (you'd know from their permissions)
      - Offer to do this yourself via the AWS CLI
    - If they don't have permissions to manage their own IAM – instruct them to get help from someone who manages that in their company
