# Deployment reference

Detailed setup notes for the Partner Central Agent Slack bot. The [Quick start](../README.md#quick-start) covers the happy path; this doc covers install prerequisites, Slack app creation in depth, and platform-specific gotchas.

---

## Prerequisites

You need AWS CLI v2.32.11+, Node.js 20+, `npm`, and `zip`.

### macOS

```bash
brew install awscli node
```

If you already had an older `awscli`, `brew upgrade awscli` is enough. If `aws` still reports the old version after install, Homebrew's `bin` isn't first on your PATH — add this to `~/.zshrc` and open a new terminal:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"  # Apple Silicon
eval "$(/usr/local/bin/brew shellenv)"     # Intel
```

### Windows

The scripts in `deployment/` are bash. On Windows, run them from **Git Bash** (bundled with [Git for Windows](https://gitforwindows.org)) or from a WSL shell. Native PowerShell isn't supported.

```powershell
winget install Amazon.AWSCLI
winget install OpenJS.NodeJS
winget install Git.Git
```

Open a new Git Bash terminal after install so PATH picks up the new binaries.

### Linux

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update
```

Plus Node.js 20+ and `zip` via your distro's package manager.

### Verify

```bash
aws --version   # needs 2.32.11+
node --version  # needs 20+
zip --version   # any recent version
```

---

## AWS credentials

The deploy script needs credentials that can create IAM roles, Lambda, API Gateway, DynamoDB, Secrets Manager, and CloudWatch resources. Admin-level access to a dev account is the simplest path.

### Long-lived access keys

1. AWS Console → IAM → Users → your user → Security credentials → **Create access key** → "Command Line Interface"
2. Copy the Access Key ID and Secret Access Key
3. Configure:

   ```bash
   aws configure --profile pc-bot
   # Paste keys, region us-east-1, output json
   ```

### AWS IAM Identity Center (SSO)

```bash
aws configure sso --profile pc-bot
# Follow browser prompts
```

### Verify

```bash
aws sts get-caller-identity --profile pc-bot
```

Should print your account ID and a user/role ARN. Then either `export AWS_PROFILE=pc-bot` or prefix deploy commands with `AWS_PROFILE=pc-bot`.

---

## Creating the Slack app (detailed)

The [Quick start](../README.md#quick-start) gives the short version. This section expands each sub-step.

> You need to be a **workspace admin** of the Slack workspace. Non-admins can create apps but can't install them.

### 1. Create from the manifest

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create an App** → **From a manifest**
2. Select the target workspace (create a new one first if testing in isolation)
3. Open `deployment/slack-manifest.yaml` in your editor and copy its contents
4. **Before pasting**, replace every occurrence of `YOUR_API_GATEWAY_URL` with the Events URL from `setup.sh`. The manifest has it in **five places**: event subscriptions, interactivity, and the three slash commands (`/pc`, `/pc-opps`, `/pc-session`). Miss one and that command fails with `dispatch_unknown_error` in Slack.
5. Paste → Next → Create

### 2. Install to the workspace

Sidebar → **Settings → Install App** → click **Install to &lt;workspace&gt;** → Allow.

### 3. Copy the credentials

- **Bot User OAuth Token** (`xoxb-...`): sidebar → **Features → OAuth & Permissions** → top of page, under "OAuth Tokens"
- **Signing Secret**: sidebar → **Settings → Basic Information** → scroll to "App Credentials" → click **Show** next to Signing Secret

### Updating the app later

If you redeploy to a new API Gateway (e.g. a parallel `STACK_NAME_PREFIX`), update the Request URLs in five places:
- **Event Subscriptions** → Request URL
- **Interactivity & Shortcuts** → Request URL
- **Slash Commands** → edit each of `/pc`, `/pc-opps`, `/pc-session`

Saving each requires a 200 response from the new URL, so the Lambda has to be reachable with a valid signing secret before Slack will accept the update.

---

## Parallel deployments

Run multiple copies in the same account by overriding the prefix:

```bash
STACK_NAME_PREFIX=slack-pc-dev ./setup.sh
```

Each copy gets its own Lambda, DynamoDB table, API Gateway, and secret. You'll need separate Slack apps pointing at each Events URL.

---

## Rotating the Slack credentials

1. Regenerate the bot token (Slack dashboard → OAuth & Permissions → revoke, then reinstall)
2. Regenerate the signing secret (Basic Information → App Credentials → Regenerate)
3. Update Secrets Manager:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id slack-pc-bot-slack-credentials \
     --secret-string '{"SLACK_BOT_TOKEN":"xoxb-new","SLACK_SIGNING_SECRET":"new"}' \
     --profile pc-bot --region us-east-1
   ```

4. Force a Lambda cold start so the new values load:

   ```bash
   aws lambda update-function-configuration \
     --function-name slack-pc-bot-bot \
     --description "rotated $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     --profile pc-bot --region us-east-1
   ```
