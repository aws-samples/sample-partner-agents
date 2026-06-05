# Workshop guide — HubSpot ↔ AWS Partner Central Agent (chat-only path)

> **Audience**: AWS partners who want only the conversational AI experience — a chat panel on the HubSpot deal record talking to AWS's Partner Central Agent MCP Server, with human-in-the-loop approval for every write.
>
> **Total time**: ~30-45 minutes from a fresh laptop to a working chat card.
>
> **Want the bidirectional CRMi sync (Share / Submit / Refresh buttons) as well?** Use [`docs/workshop.md`](workshop.md) — it covers the full CRMi setup plus an optional Module 14 that layers the Agent card on top.

---

## Workshop outcomes

By the end of this workshop you'll have:

1. An **AWS account** with the IAM permissions needed to call the AWS Partner Central Agent MCP Server (Sandbox catalog).
2. A **HubSpot developer test account** with the Agent card installed on a deal record.
3. The Agent stack deployed: 2 Lambdas (sync + async), API Gateway, DynamoDB job table, Secrets Manager.
4. A working chat: send a question about a deal → agent replies with a markdown summary; ask the agent to write something → it returns an inline Approve / Reject / Override panel.

The CRMi mode (Share / Submit / Refresh / Pull lambdas + bidirectional custom properties) is **not** deployed in this workshop. If you need it later, follow [`docs/workshop.md`](workshop.md) on top of this setup — the two are independent.

## Workshop checklist (printable)

- [ ] **0** — Repo cloned, tools installed, prerequisites verified (`scripts/check-prereqs.sh --agent`: Node 22+, AWS CLI v2, HubSpot CLI 8.6+, Git)
- [ ] **1** — AWS deploy credentials confirmed (identity can create CloudFormation stacks)
- [ ] **2** — AWS CLI configured (`aws sts get-caller-identity` succeeds)
- [ ] **3** — HubSpot developer test account created
- [ ] **4** — Agent dependencies installed
- [ ] **5** — Agent stack deployed (`infra/unified-deploy.sh --mode agent`)
- [ ] **6** — UI Extension card project uploaded (`hs project upload` from `agent-card/`)
- [ ] **7** — Agent app installed in HubSpot + client secret captured
- [ ] **8** — Secrets populated (`agent-infra/set-secrets.sh --auto-bounce`)
- [ ] **9** — Card installed on the deal layout
- [ ] **10** — Smoke test: chat works, write tools surface an approval panel

---

## 0. Workstation prerequisites

### 0a. Clone the repo

```bash
git clone <REPO-URL> hubspot-crm-pcagent-integration
cd hubspot-crm-pcagent-integration
```

The workshop facilitator will give you the actual repo URL.

### 0b. Install tools

| Tool | Why | macOS | Windows |
|---|---|---|---|
| **Node.js 22** (or newer) | Lambda + card builds. The HubSpot CLI requires Node 22+. Lambda bundles target `nodejs20.x` runtime, but the local toolchain needs Node 22. | `brew install node@22` | Download the [Node 22 LTS installer](https://nodejs.org/) |
| **AWS CLI v2** | Deploy + credentials | `brew install awscli` | Download the [MSI installer](https://awscli.amazonaws.com/AWSCLIV2.msi) and run it |
| **Git** | Clone the repo | Pre-installed on macOS | Download from [git-scm.com](https://git-scm.com/downloads) |
| **HubSpot CLI** | Upload the card | `npm i -g @hubspot/cli@latest` | `npm i -g @hubspot/cli@latest` |
| **zip / shasum** | Build script utilities | Pre-installed | Use **Git Bash** (ships with Git for Windows) |

> **Windows participants**: open **Git Bash** for every shell command in this guide. The deploy scripts are POSIX bash and rely on `zip`, `shasum`, and `bash`-isms. Git Bash includes all three.

### 0c. Verify (and optionally install) prerequisites

Run the checker from the repo root:

**macOS / Linux:**

```bash
./scripts/check-prereqs.sh --agent             # report status only
./scripts/check-prereqs.sh --agent --install   # also install what's missing
```

**Windows (PowerShell):**

```powershell
.\scripts\check-prereqs.ps1 -Agent             # report status only
.\scripts\check-prereqs.ps1 -Agent -Install    # also install what's missing
```

The `--agent` / `-Agent` flag skips the Python check (Python is only needed for the CRMi workshop, not this one). With `--install` / `-Install`, the script installs missing tools via Homebrew (macOS), apt/dnf (Linux), or winget/Chocolatey (Windows), and installs the HubSpot CLI via `npm`.

Sample output:

```
=== Workshop prerequisite check (Darwin) ===
Package manager: brew

  Node.js          ✓ 22.22.3 (>= 22)
  npm              ✓ 10.9.8
  AWS CLI          ✓ 2.34.55 (>= 2.15)
  Git              ✓ 2.44.0
  HubSpot CLI      ✓ 8.8.0 (>= 8.6)
  zip              ✓ 3.0
  shasum           ✓ 6.02

All required tools satisfied.
```

If you'd rather check by hand, each of these must succeed:

```bash
node --version          # v22.x.x or newer
aws --version           # aws-cli/2.15+
hs --version            # 8.6.0+
git --version           # any recent version
```

---

## 1. Provide AWS deploy credentials

Unlike the CRMi connector, the Agent backend uses **no long-lived AWS credentials at runtime**. The two Lambdas authenticate to the Partner Central Agent MCP Server using SigV4 signing with their own **Lambda execution role**, which the CloudFormation template creates and attaches the right managed policies to automatically (`AWSMcpServiceActionsFullAccess` + `AWSPartnerCentralSandboxFullAccess`). Nothing about the agent's request path involves an IAM user.

What you DO need is a principal that can **run the deploy** — i.e. create the CloudFormation stack and the resources inside it (Lambdas, the execution role, an HTTP API, a DynamoDB table, a Secrets Manager secret). The agent's Secrets Manager component holds only HubSpot credentials (client secret + optional access token); no AWS keys go into it.

### 1a. Sign in to your AWS account

Use **the same AWS account that's linked to your AWS Partner Central account**. If you're not sure, ask your AWS partner admin — Partner Central has a 1:1 link with one specific AWS account.

### 1b. Confirm your deploy principal has the right permissions

The identity you'll run `unified-deploy.sh` as (an SSO role, an IAM user, or an assumed role) needs permission to create and manage:

- CloudFormation stacks
- Lambda functions + an IAM execution role (`iam:CreateRole`, `iam:AttachRolePolicy` — the template attaches the two AWS-managed Partner Central / MCP policies to that role)
- An API Gateway HTTP API
- A DynamoDB table
- A Secrets Manager secret
- An S3 bucket (for the Lambda artifact zips)

For a workshop in a sandbox account, an admin or **PowerUserAccess + IAM role management** identity covers all of this. If your org requires a scoped deploy policy, ask your AWS admin to grant the actions above.

> **You do NOT attach `AWSMcpServiceActionsFullAccess` or `AWSPartnerCentralSandboxFullAccess` to your deploy identity.** Those are runtime policies the CloudFormation template attaches to the Lambda execution role. Your deploy identity only needs to be able to *create* that role.

> **Production catalog?** The template's Lambda execution role uses `AWSPartnerCentralSandboxFullAccess` by default. To enable production traffic, edit `agent-infra/cloudformation.yaml` and swap it for `AWSPartnerCentralFullAccess` before the deploy in Lab 5.

---

## 2. Configure the AWS CLI

Point the CLI at the deploy identity from Lab 1. How you do this depends on how your account hands out credentials:

**If you use AWS IAM Identity Center (SSO)** — recommended:

```bash
aws configure sso --profile workshop
# follow the browser prompts, then:
aws sso login --profile workshop
```

**If you use a long-lived IAM access key**:

```bash
aws configure --profile workshop
```

Paste in order when prompted:
- AWS Access Key ID / Secret Access Key for your deploy identity
- Default region name: `us-east-1`
- Default output format: `json`

Either way, export the profile for the rest of the session:

```bash
export AWS_PROFILE=workshop
export AWS_REGION=us-east-1
```

Verify:

```bash
aws sts get-caller-identity
```

The output should show your AWS account ID and the ARN of your deploy identity (an SSO role, an IAM user, etc.). As long as it's the right account and the identity can create CloudFormation stacks, you're set.

---

## 3. Create a HubSpot developer test account

A **configurable test account** is a free, isolated HubSpot environment. Reference: [Test your HubSpot apps with configurable test accounts](https://developers.hubspot.com/docs/developer-tooling/local-development/configurable-test-accounts).

### 3a. Sign up for HubSpot (skip if you already have an account)

If you don't have any HubSpot account yet, create a free one at [hubspot.com](https://developers.hubspot.com/).

### 3b. Authenticate the HubSpot CLI to your developer account

```bash
hs account auth
```

1. Pick the **authentication type** — **Personal access key**.
2. Browser opens — sign in to your **developer account** (the one you created in 3a), generate a Personal Access Key, paste it back.
3. **Account alias**: `developer` (or any name — just not `workshop`, which you'll use for the test account in Lab 6).

This authenticates the CLI to the parent account under which the test account will be created.

### 3c. Create the test account

```bash
hs test-account create
```

Select **Default (All hubs, ENTERPRISE)**, then fill in the prompts:
- **Account name** (or use any preferred name): `aws-pc-agent-workshop`
- **Description**: any one-liner.

Verify:

```bash
hs accounts list
```

The `aws-pc-agent-workshop` (or your previously defined Account Name) row should be marked **default**. If not:

```bash
hs accounts use [your-account-name]]
```

The Agent card works on any HubSpot plan — Enterprise is selected here to give you a full test environment, not because it's required.

The CLI prints the new test account's HubSpot Account ID. **Save this number** — you'll see it referenced in the agent app project once uploaded.

> **What if HubSpot shows a "Customize experiences with HubSpot Development" onboarding screen?** Click **Skip** / **Dismiss** or close the tab. The CLI commands the workshop uses (`hs test-account create`, `hs account auth`, `hs project upload`) work regardless of that flow.

---

## 4. Install dependencies

### 4a. Install Agent dependencies

```bash
cd agent-backend && npm ci && cd ..
cd agent-card    && npm ci && cd ..
```

`npm ci` runs a postinstall hook that creates two gitignored card-config files (`config.local.ts` and `app-hsmeta.json`) from committed templates. The deploy script in Lab 5 will overwrite them with your real API URL.

> The workshop **does not** install the CRMi backend (`backend/`) or CRMi card (`hubspot-card/`). Skip those `npm ci` invocations if you're following [`docs/workshop.md`](workshop.md) for both modes.

---

## 5. Deploy the Agent stack to AWS

### 5a. Run the unified deploy

```bash
./infra/unified-deploy.sh --mode agent --env-suffix dev --profile workshop -y 
```


### 5b. Confirm the API URL

```bash
aws cloudformation describe-stacks \
  --stack-name ace-agent-dev \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text \
  --profile workshop
```

The output is something like `https://abc123xyz.execute-api.us-east-1.amazonaws.com`.

> **Sharing an account with another deployment?** Pass `--env-suffix dev` (lowercase, digits, hyphens; max 16 chars) to keep the new deploy from clobbering an existing canonical `ace-agent` stack. See [`docs/architecture.md` § Parallel environments](architecture.md#parallel-environments---env-suffix).

---

## 6. Upload the HubSpot UI Extension card

> **CLI 8.6+ migrates per-project configs to a global one.** On first run, you may see a warning that `agent-card/hubspot.config.yml` is deprecated and got renamed to `archived.hubspot.config.yml`. That's expected — both filenames are gitignored.

### 6b. Upload the agent card project

```bash
cd agent-card
hs project upload
```

On first run the CLI prompts:

```
[--forceCreate] The project hubspot-ace-agent-card does not exist in workshop. Would you like to create it?
```

Answer **Y**. The CLI builds the React extension, uploads it, and auto-deploys:

```
✔ Built hubspot-ace-agent-card #1
Build #1 succeeded. Automatically deploying to workshop ...
✔ Deployed build #1 in hubspot-ace-agent-card
```

```bash
cd ..
```

---

## 7. Install the Agent app and capture its credentials

The card won't render on the deal layout until you install the app in your test account. The install also surfaces the access token for the optional context-preamble feature.

Open your HubSpot test account: **[app.hubspot.com](https://app.hubspot.com)** — sign in and make sure you're in the `aws-pc-agent-workshop` account (or whichever account name you defined) (check the account switcher in the top-left corner).

### 7a. Drill into the Agent app

1. In the **left navigation bar**, click the **Development** icon (typically at the bottom of the rail).
2. Click **Projects** → **`hubspot-ace-agent-card`**.
3. Under **Project Components**, click **AWS Partner Central Agent** (the app, not the card).

The app's detail page opens with a tab strip: **Overview / Auth / Distribution**.

### 7b. Install the app (Distribution tab)

1. Click the **Distribution** tab.
2. Click **Install now**.
3. Review scopes → **Connect app**.
4. **HubSpot redirects you out of the developer view** to **Settings → Integrations → Connected Apps**. The credentials aren't on that page. Navigate back yourself:
    - Left nav → **Development** → **Projects** → **`hubspot-ace-agent-card`** → click on Project Components on the **AWS Partner Central Agent** → **Distribution** tab.
5. Your account now shows as **Installed**.

### 7c. Copy the Client secret (Auth tab)

1. Click the **Auth** tab.
2. Under **Client credentials**, click on Show under **Client secret** (HUBSPOT_CLIENT_SECRET), then Copy. Save it for Step 8 (it should look like '44264362-7331-40d5-9999-1450c780999').

### 7d. Copy the Access token (required if not using the CRM integration)

**If you are running the Agent card without the CRM integration (Share / Submit / Refresh), this token is effectively required.** Without it, the agent has no connection to HubSpot — it can only query AWS Partner Central. The token lets the agent fetch basic deal properties (name, stage, `ace_opportunity_id`) and automatically prepend them as context to every message, so you can say *"summarise this opportunity"* instead of typing IDs manually.

If you are running both the CRM integration and the Agent card, the token is still recommended — it enriches the agent's context with live HubSpot deal data even when the opportunity already exists in Partner Central.

1. Click the **Auth** tab.
2. Under **App credentials**, click **Show token**, then copy.

Save it for Lab 8's `HUBSPOT_PRIVATE_APP_TOKEN` prompt.

---

## 8. Populate Secrets Manager

Go back to your CLI terminal.

```bash
./agent-infra/set-secrets.sh --auto-bounce --profile workshop --env-suffix dev
```

The script prompts for three keys with **hidden stdin** (no echo - so you won't see the secrets when pasted on the CLI):

| Prompt | Paste this |
|---|---|
| `HUBSPOT_CLIENT_SECRET` | the Client secret from Lab 7c |
| `HUBSPOT_PRIVATE_APP_TOKEN` (optional) | the Access token from Lab 7d, or press Enter to skip |
| `ACE_AGENT_CATALOG [Sandbox]` | press Enter for the default |

`--auto-bounce` then restarts both Agent Lambdas (sync + async) so they refetch the new secret immediately. Expected ending:

```
Secret updated.

Auto-bouncing Lambda functions so they refetch the secret immediately:
  bounced ace-agent-AgentLambda-dev
  bounced ace-agent-AgentAsyncLambda-dev

All ace-agent-AgentLambda-dev, ace-agent-AgentAsyncLambda-dev updated.
```

---

## 9. Install the card on a deal record

Go back to your HubSpot test account: **[app.hubspot.com](https://app.hubspot.com)**.   

The Agent card declares its location as `crm.record.tab` — HubSpot's **middle-column tab** surface. Default deal layouts ship with no customizable middle-column tab, so you'll create one.

### 9a. Open or create a deal

If you already have a deal, just open any. Otherwise, follow these steps to create a new Deal:

1. Left nav → **CRM** → **Deals**.
2. **Add deal** → name it anything (e.g. `Agent smoke test`), pick the default pipeline + stage. The agent doesn't need any specific deal properties — even a near-empty deal works for the chat.
3. **Create**. HubSpot opens the new deal.



### 9b. Add a middle-column tab + drop the card

1. In the deal's **middle column**, click **Customize** at the top right of the column. (If you don't see it, click the **gear icon** near the top of the page → **Customize the middle column**.)
2. Find the **Default view** or the view that you have defined for your deals. Click on it to edit the layout.
2. **+ Create a new tab** in the middle column (+ sign). Name it **AWS Partner Central Agent**.
3. With the new tab selected, click **Add card** → in the **Card library** search `**AWS Partner Central Agent**` → click on **Add card**.
4. Close this dialog first on the top right.
5. **Save and exit** (top right).

Reload the deal page (Cmd+Shift+R / Ctrl+Shift+R) and click into the new tab — the chat composer should appear.

> **Heads-up — first paint can be slow.** On the very first deal view after install, the card may take 5-10 seconds to render while HubSpot warms its UI Extension runtime.

5. Click on the new tab you just created and see the new **AWS Partner Central Agent** card.

---

## 10. Smoke test the Agent

### 10a. Send a read query

In the deal's chat composer:

> *"List the most recent opportunities in my Sandbox catalog."*

Click outside the dialog message or hit **Tab** in your keyboard and Click **Send**.

Within ~3-15 seconds (start-poll pattern, see [`docs/architecture.md` § Request flow — Agent](architecture.md#request-flow--agent)) the agent should reply with a markdown table of opportunities.

### 10b. Send a write query — see the approval gate

Most ACE write actions require ~12-15 fields (customer details, project description, delivery model, expected spend, close date). The Partner Central Agent will normally ask for any missing fields one at a time, which makes for a long demo. Give it everything in a single prompt so it can propose the write immediately. Copy this into the chat composer:

```text
Create a new opportunity in the Sandbox catalog with these details.
Use the values exactly as given and don't ask me follow-up questions — propose the CreateOpportunity call directly.

- Customer Company Name: Acme Robotics
- Customer Country: US, State: California, Postal Code: 94016
- Customer Industry: Manufacturing
- Customer Use Case: AI Machine Learning and Analytics
- Project Title: Acme Robotics - Predictive Maintenance Pilot
- Project Description: Predictive-maintenance pipeline on AWS for
  Acme's manufacturing line. Ingest sensor data into S3, run anomaly
  detection in SageMaker, surface alerts in QuickSight.
- Delivery Model: SaaS or PaaS
- Expected Monthly Spend: 5000 USD
- Target Close Date: three months from today
- Opportunity Type: Net New Business
- Primary Need from AWS: Co-Sell - Architectural Validation
- Sales Activity: Initialized discussions with customer
- Involvement Type: Co-Sell
- Visibility: Full
- National Security: No
```

Click **Send**.

Within ~3-15 seconds the agent's response summarising the proposed `CreateOpportunity` call.

> **Tip — bulk import for repeat demos.** Below the chat composer, the **Bulk import panel** accepts a CSV of up to 30 rows and runs the same approval flow per row. Useful when you want to demo an import-style workflow without typing each opportunity's fields by hand. See [`agent-card/README.md` § Bulk import](../agent-card/README.md#bulk-import).

### What's next

- For the bidirectional CRM integration sync (Share / Submit / Refresh / Pull), follow [`docs/workshop.md`](workshop.md). The two stacks are independent — you can deploy CRM integration in the same AWS account / HubSpot test account without touching the Agent setup.

---

## Troubleshooting

### `Configuration error: missing secrets: HUBSPOT_CLIENT_SECRET`

The agent's Secrets Manager is empty or missing the key. Run `./agent-infra/set-secrets.sh HUBSPOT_CLIENT_SECRET --auto-bounce --profile workshop`, paste the value at the hidden prompt.

### `Unexpected response from backend (status 404)`

The card uploaded to HubSpot is calling an API URL that no longer exists. Most common cause: you redeployed the agent stack to a different name (e.g. switched from `--mode agent` to a `--env-suffix` variant) and the card source files were rewritten, but the **uploaded** build still has the old URL baked in. Re-run:

```bash
cd agent-card && hs project upload && cd ..
```

Then hard-reload the deal page.

### `Authorization failed. Reload the HubSpot page and try again.`

The `HUBSPOT_CLIENT_SECRET` in Secrets Manager doesn't match the value on the agent app's Auth tab. Either you pasted the wrong app's secret (CRMi vs Agent) or HubSpot rotated it. Copy from **Development → Projects → hubspot-ace-agent-card → AWS Partner Central Agent → Auth tab → Client secret**, push via `set-secrets.sh HUBSPOT_CLIENT_SECRET --auto-bounce`, hard-reload.

### `Session expired or resource not found`

MCP evicted the agent session. Click **New conversation** in the card to reset, then send the message again. The card auto-clears the dead `sessionId` on this error so the next message starts fresh.

### Card shows "AWS rate-limited the request"

Expected after ~2 messages/min. Wait 60s. The card enforces a 30s client-side cooldown which extends to 60s if MCP returns `MCP_RATE_LIMITED` (`-32004`).

### HubSpot CLI fails with `Invalid regular expression flags` / `SyntaxError`

The CLI requires Node 22+. If you have a Node version manager (mise, nvm, asdf) shimming an older Node onto your `PATH`, prefix the upload with the right Node binary — e.g. `PATH="/opt/homebrew/bin:$PATH" hs project upload` to use Homebrew's Node 24. `node --version` should report `v22.*` or newer.

### Anything else

The full troubleshooting catalogue is in [`docs/architecture.md` § Common errors](architecture.md#common-errors). Search by the verbatim error message you see in the card.

---

## Workshop teardown

When you're done with the workshop and want to remove every AWS resource:

```bash
# 1. Delete the CFN stack.
aws cloudformation delete-stack --stack-name ace-agent --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name ace-agent --region us-east-1

# 2. Empty and delete the artifact bucket.
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws s3 rm "s3://ace-agent-deploy-${ACCOUNT}-us-east-1" --recursive
aws s3api delete-bucket --bucket "ace-agent-deploy-${ACCOUNT}-us-east-1" --region us-east-1

# 3. Delete the Secrets Manager secret (force, no 7-day window).
aws secretsmanager delete-secret \
  --secret-id crm-connector/ace-agent \
  --force-delete-without-recovery \
  --region us-east-1

# 4. Delete CloudWatch log groups.
for group in /aws/lambda/ace-agent-{AgentLambda,AgentAsyncLambda}; do
  aws logs delete-log-group --log-group-name "$group" --region us-east-1 || true
done
```

> If you deployed with `--env-suffix <name>`, swap `ace-agent` for `ace-agent-<name>` and `crm-connector/ace-agent` for `crm-connector/ace-agent-<name>` in the commands above.

For the HubSpot side: go to **Development → Projects** and delete the **hubspot-ace-agent-card** project. There's no IAM user to clean up — the agent path never created one.
