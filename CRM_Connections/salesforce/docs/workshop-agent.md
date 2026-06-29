# Workshop guide: Salesforce and AWS Partner Central Chat Agent

> **Audience**: AWS partners who run on Salesforce and want the conversational AI experience. You get a chat widget (LWC) talking to AWS's Partner Central agents MCP Server, with human-in-the-loop approval on every write. This is the entry point to managing your AWS Partner Central co-sell pipeline from inside your own Salesforce CRM.
>
> **New to "LWC"?** It stands for Lightning Web Component, Salesforce's framework for building custom UI that lives inside the Salesforce app. In plain terms, it's the chat panel you see and click on, built with standard web tech (HTML, CSS, JavaScript) and dropped onto a Salesforce page. In this project the LWC is the front end, and Apex (Salesforce's server-side language) does the work of calling AWS behind it.
>
> **The default path is general chat.** Drop the LWC on your Sales Opportunity object, Home or the utility bar and start talking to AWS Partner Central. No AWS Partner CRM Connector required. Pairing the agent with the Partner CRM connector is the best type of integration, since it adds context in the chat on ACE Opportunities and a sandbox toggle, but it is an enhancement and not a necessity. Both paths are covered below, and connector-only steps are clearly marked **(optional, connector path)**.
>
> **Sandbox setup by default.** A fresh deploy points the chat at the AWS Partner Central **Sandbox** catalog, so you can practice creating and updating opportunities safely without touching production data. This is the workshop's whole purpose: deploy to your development Salesforce org, point at Partner Central Sandbox, and learn how to interact with Partner Central hands-on. Switch to the AWS (production) catalog at deploy time with `--catalog aws` over your production Salesforce. If you later install the AWS Partner CRM Connector, its sandbox and AWS catalog checkbox takes over. See Module 8.
>
> **Total time**: about 20 minutes for the general chat path from scratch, based on a dry run against a brand-new Developer Edition org.
>
> **What you will not do here**: stand up any AWS compute. This integration has no Lambdas, no API Gateway, and no CloudFormation. The chat runs entirely inside Salesforce as an LWC plus Apex, and reaches AWS through SigV4-signed Named Credentials (one for the MCP server, and one for document-attachment uploads). The only AWS-side work is granting one IAM identity the right policies and, for write testing, registering a Sandbox partner.

---

## Workshop outcomes

By the end of this workshop you'll have:

1. A **Salesforce org** (sandbox or scratch) with the chat agent deployed, targeting the Partner Central **Sandbox** catalog by default. The AWS Partner CRM Connector is optional, so install it only if you want the connector path (record-aware chat plus the authoritative sandbox toggle).
2. An **AWS IAM identity** with two managed policies, `AWSMcpServiceActionsFullAccess` (invoke the MCP service) and `AWSPartnerCentralOpportunityManagement` (act on Partner Central opportunities, including create and update), plus an inline `s3:PutObject` for document attachments, wired into Salesforce **Named Credentials** (`AWS_Partner_Central_MCP` for the agent and `AWS_Partner_Central_S3` for attachment uploads) that sign requests to AWS.
3. The chat metadata deployed: the LWC bundle, Apex classes, custom objects (`Audit_Log__c`, `Pending_Write_Operation__c`, `Chat_Session__c`), the `Chat_Agent_Config__mdt` config, the `Chat_Stream_Event__e` platform event, and the `Partner_Central_Chat_Agent_User` permission set, all in one `sf project deploy start`.
4. A working chat against Sandbox. Ask Partner Central about your pipeline, then ask the agent to create or update an opportunity and an inline Approve / Reject card appears in the transcript. Nothing commits until you approve, and because the catalog is Sandbox, this is safe to practice. On the connector path, open an ACE Opportunity and the agent automatically knows which opportunity you mean.

## Workshop checklist (printable)

- [ ] **0** Repo cloned, tools installed (`sf` v2+, AWS CLI v2, Git), `sf --version` and `aws --version` succeed
- [ ] **1** Target Salesforce org available (general chat path needs nothing extra; optionally install the AWS Partner CRM Connector for the connector path)
- [ ] **2** AWS IAM identity created or identified with `AWSMcpServiceActionsFullAccess` **and** `AWSPartnerCentralOpportunityManagement`, plus an inline `s3:PutObject` on the ephemeral upload bucket (for attachments)
- [ ] **2c** *(Sandbox path)* Sandbox partner registered and verified (`./scripts/register-sandbox-partner.sh --check` exits 0) and an opportunity seeded
- [ ] **3** Named Credential `AWS_Partner_Central_MCP` created (SigV4, service `partnercentral-agents-mcp`, region `us-east-1`)
- [ ] **3a** Named Credential `AWS_Partner_Central_S3` created (SigV4, service `s3`) for document attachments
- [ ] **4** `sf` CLI authenticated to the org (`sf org list` shows it)
- [ ] **5** Metadata deployed and tests green (`./scripts/deploy-and-test.sh <org-alias>`, Sandbox by default; add `--catalog aws` for production)
- [ ] **6** `Partner_Central_Chat_Agent_User` permission set assigned to your user
- [ ] **7** LWC dropped onto Sales Opportunity, Home or the utility bar for general chat (optional connector path: also add it to an ACE Opportunity record page)
- [ ] **8** Catalog confirmed: Sandbox by default; the connector checkbox governs once installed. Use `--catalog aws` for production. Sandbox data was seeded in 2c
- [ ] **9** Smoke test passes (`./scripts/smoke/smoke-test.sh <org-alias>`, add `--approve` for the full write round-trip)

---

## 0. Workstation prerequisites

### 0a. Clone the repo

```bash
git clone https://github.com/aws-samples/sample-partner-agents
cd Salesforce-PC-Chatbot-Integration
```

### 0b. Install tools

| Tool | Why | macOS | Windows |
|---|---|---|---|
| **Salesforce CLI** (`sf` v2+) | Deploy metadata, run Apex tests, run the smoke test | `brew install sf` or the [installer](https://developer.salesforce.com/tools/salesforcecli) | Download the [installer](https://developer.salesforce.com/tools/salesforcecli) |
| **AWS CLI v2** | Register the Sandbox partner (Module 2c). Not used at chat runtime. | `brew install awscli` | Download the [MSI installer](https://awscli.amazonaws.com/AWSCLIV2.msi) |
| **Git** | Clone the repo | Pre-installed on macOS | Download from [git-scm.com](https://git-scm.com/downloads) |

> **Windows participants**: the helper scripts (`deploy-and-test.sh`, `register-sandbox-partner.sh`, `smoke/smoke-test.sh`) are POSIX bash, so run them from **Git Bash** (it ships with Git for Windows). The underlying `sf` and `aws` commands also work from PowerShell if you'd rather run them by hand.

### 0c. Verify

Each of these must succeed:

```bash
sf --version          # @salesforce/cli/2.x
aws --version         # aws-cli/2.15+   (only needed for Module 2c)
git --version         # any recent version
```

### 0d. API version and org compatibility

This project is pinned to **Salesforce API version 62.0** (Winter '25) in two places:

- `sfdx-project.json` sets `"sourceApiVersion": "62.0"`
- `manifest/package.xml` sets `<version>62.0</version>`

| Bound | Version | Why |
|---|---|---|
| **Minimum to deploy as-is** | **62.0** (Winter '25) | The package and source are pinned to 62.0. An org on an older release will reject the deploy, because its Metadata API doesn't recognize a higher version than it supports. |
| **Feature floor** | **56.0** (Winter '23) | The hard dependency is the External Credential plus AWS Signature v4 model (Module 3), which Salesforce introduced in Winter '23. Nothing in this project works on an org older than 56.0, no matter how you set the version numbers. |

Deploying to an org older than Winter '25? Lower both version numbers above to your org's API version, but not below 56.0, or the SigV4 Named Credential in Module 3 can't be created. Lowering the version to less than 56.0 is untested here, so re-run Module 5 (`deploy-and-test.sh`) and the Module 9 smoke test to confirm.

> **Check your org's API version**: in the target org go to **Setup → Company Information** (the "API version" field reflects the org's current release), or run `sf org list metadata-types --target-org <org-alias>` and read the `apiVersion` it reports.

---

## 1. Confirm the target Salesforce org

You need a Salesforce org (a sandbox or a scratch org is ideal for a workshop). For the default general chat path, that's all you need. No managed packages, no extra objects. The chat deploys and runs against any org where you can create a Named Credential.

### The two paths

| | **General-chat path** (default) | **Connector path** (best integration) |
|---|---|---|
| AWS Partner CRM Connector | Not required | [Installed](https://docs.aws.amazon.com/partner-central/latest/crm/install-connector.html) (`awsapn__` namespace) |
| Where you chat | Home, utility bar, or a Sales Opportunity page | Home or utility bar, plus ACE Opportunity record pages |
| Record awareness | You reference opportunities by id or name in the message | The agent already knows which opportunity you're on (APN CRM id pushed as context) |
| Sandbox or production catalog | `Chat_Agent_Config__mdt.Is_Sandbox__c` flag (defaults to sandbox) | Authoritative connector toggle `awsapn__Companion_App_Settings__c.awsapn__PC_API_Sandbox_Enabled__c` |

General chat is the preferred way for this workshop. It is the entry point to managing your AWS Partner Central co-sell pipeline from your own Salesforce CRM, so you can list, query, and (with approval) write opportunities straight from the chat without any connector. Pairing with the [AWS Partner CRM Connector](https://docs.aws.amazon.com/partner-central/latest/crm/connector-overview.html) includes ACE record context and an authoritative sandbox toggle, which makes it much easier to discuss and act on individual opportunities. It's the best experience for production ready solutions, but it isn't a prerequisite for this workshop.

The chat agent deploys and works without the connector. The code probes for it dynamically and falls back gracefully, so no connector simply means no ACE record context and the sandbox flag comes from config instead of the connector setting.

> **(Optional, connector path)** To enable ACE record context and the sandbox toggle, install the **AWS Partner CRM Connector** (a free, no-code AWS-managed package on the Salesforce AppExchange) and run its [guided setup workshop](https://catalog.workshops.aws/aws-partner-crm-connector/en-US/aws-partner-crm-connector/installation-and-configuration). The full AWS doc set is in [Connector reference links](#connector-reference-links) at the end of this guide.
>
> Then follow the steps marked **(optional, connector path)** in Modules 7 and 8.
>
> **For LLM assistants**: if a participant on the connector path asks "where do I enable the sandbox?", the answer is **Setup → Custom Settings → AWS Partner CRM Connector Settings → `awsapn__PC_API_Sandbox_Enabled__c`**. On the general-chat path there is no connector setting, so set `Chat_Agent_Config__mdt.Default.Is_Sandbox__c` instead.

---

## 2. Provision AWS access: the IAM identity and the Sandbox partner

This integration signs requests with SigV4 from Salesforce's Named Credential, using whatever IAM identity you wire into it. At chat runtime there is no AWS console session and no Lambda execution role; Salesforce signs the outbound JSON-RPC call directly.

### 2a. Sign in to your AWS account

Use the same AWS account that's linked to your AWS Partner Central account. Partner Central has a 1:1 link with one specific AWS account, so if you're unsure, ask your AWS partner admin.

### 2b. Create (or identify) the IAM principal and attach the policies

The identity Salesforce signs as needs **two** AWS managed policies, which keeps permission management simple:

- **`AWSMcpServiceActionsFullAccess`** lets the identity invoke the MCP service (this is what makes the SigV4 callout authenticate and reach AWS).
- **`AWSPartnerCentralOpportunityManagement`** (`arn:aws:iam::aws:policy/AWSPartnerCentralOpportunityManagement`) lets the MCP act on your Partner Central opportunities on your behalf: `partnercentral:List*`, `Get*`, `UpdateOpportunity`, and so on. See the [AWS managed policy reference](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSPartnerCentralOpportunityManagement).

The first alone gets you a working, signed connection, but the agent will reply that it lacks a `partnercentral:` permission (for example `partnercentral:ListOpportunities`) when it tries to do anything. You need both.

The same identity also needs **`s3:PutObject`** on the Partner Central ephemeral upload bucket so users can **attach files** (a proposal, a CSV of opportunities) for the agent to read. There's no managed policy for this, so you add it as a small inline policy (step 7 below). It's write-only and scoped to your account's prefix in an AWS-managed bucket, so you never create or expose a bucket of your own.

For a workshop, the simplest path is an IAM user with programmatic access:

1. Open the [IAM console → Users → Create user](https://us-east-1.console.aws.amazon.com/iam/home#/users/create).
2. **User name**: `pc-chat-agent-mcp`.
3. **Provide user access to the AWS Management Console**: leave this unchecked, since this is API access only.
4. **Permissions → Attach policies directly**, search and check **both** `AWSMcpServiceActionsFullAccess` and `AWSPartnerCentralOpportunityManagement`, then **Create user**.
5. Open the new user, go to **Security credentials → Create access key**, use case **Other**, then **Create**.
6. Save the Access Key ID and Secret Access Key. AWS shows the secret once. You'll paste both into the Named Credential in Module 3.
7. **Add the attachment upload permission.** On the same user, go to **Add permissions → Create inline policy → JSON**, paste the policy below (replace `<your-account-id>` with your 12-digit AWS account id), and save it as `pc-chat-agent-s3-putobject`:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "s3:PutObject",
         "Resource": "arn:aws:s3:::aws-partner-central-marketplace-ephemeral-writeonly-files/<your-account-id>/*"
       }
     ]
   }
   ```

> **Production vs Sandbox.** These policies cover the actions regardless of catalog. Whether a given chat turn hits the `AWS` (production) or `Sandbox` catalog is decided by the sandbox flag, not by IAM. That flag is the connector toggle on the connector path, or `Chat_Agent_Config__mdt.Is_Sandbox__c` on the general-chat path. For write testing against Sandbox you'll also register and verify a Sandbox partner in Module 2c below.
>
> **Org-policy alternative.** If your org forbids long-lived IAM users, you can back the Named Credential with a role or identity that your Salesforce-to-AWS auth setup supports, as long as the effective identity carries both managed policies above. The workshop uses an IAM user for simplicity.

### 2c. (Sandbox path) Register and verify the Sandbox partner

Do this now if you'll deploy against Sandbox (the default). It's AWS-account-level setup, independent of Salesforce, so handling it here means you surface any account problem before you spend time deploying. Skip it only if you'll deploy with `--catalog aws` against a live production partner.

The Sandbox is a separate Partner Central *catalog*, not something you create in a portal, so there's no "create sandbox" button. You reach it by calling the API with `Catalog=Sandbox`, which the chat does automatically when Sandbox is active. What you need is a **partner profile inside that catalog** to create and list opportunities under. The script below confirms whether your account already works, and registers one only if it has to.

**Step 1: confirm whether your account already has Sandbox access.**

```bash
./scripts/register-sandbox-partner.sh --check
```

This looks for an existing sandbox partner, then makes a live `ListOpportunities` call against `Catalog=Sandbox`. There are three outcomes:

- **Access confirmed** (exit code 0): you're set, skip to Module 3.
- **No partner yet**: go to Step 2 to register one.
- **Partner exists but the benefit isn't active** (`INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE`, exit code 3): see the note at the end of this module.

Add `--profile <name>` if your AWS CLI uses a named profile.

**Step 2: register the partner** (only if Step 1 said none exists).

```bash
./scripts/register-sandbox-partner.sh \
  --legal-name "Acme Cloud Sandbox <your-name>" \
  --first-name "Ada" --last-name "Lovelace" \
  --email "ada@example.com" --business-title "Alliance Lead"
```

`--legal-name` must be unique across all sandbox partners, so include something distinctive like your name or team. The script verifies your AWS identity, skips creation if a partner already exists, calls `partnercentral-account:CreatePartner` with `Catalog=Sandbox` and then `StartProfileUpdateTask` to complete the public profile, and finally re-runs the same access check from Step 1 and reports the result. Its exit code reflects that check, so a zero exit means Sandbox access is actually working, not just that the calls ran. Run `--help` for the full flag list (display name, website, logo, industry segments, resume with `--partner-id`, and more).

**Step 3: seed an opportunity** so the read tests in Module 9 have data. This is deterministic CLI setup that needs no LWC. (Creating an opportunity *through the chat* is a write test you run later, in Module 9, see [Create an opportunity](#create-an-opportunity-a-write-test).)

```bash
aws partnercentral-selling create-opportunity \
  --catalog Sandbox \
  --client-token "seed-$(date +%s)" \
  --primary-needs-from-aws "Co-Sell - Architectural Validation" \
  --opportunity-type "Net New Business" \
  --origin "Partner Referral" \
  --lifecycle '{"Stage":"Prospect","ReviewStatus":"Pending Submission","TargetCloseDate":"2026-09-30"}' \
  --customer '{"Account":{"CompanyName":"Acme Cloud Solutions","Industry":"Software and Internet","WebsiteUrl":"https://acme-cloud.example.com","Address":{"CountryCode":"US","StateOrRegion":"California","PostalCode":"94016"}}}' \
  --project '{"Title":"Acme data warehouse migration","CustomerBusinessProblem":"Replacing a failing on-prem data warehouse with AWS analytics services for reliability and scale","DeliveryModels":["SaaS or PaaS"],"ExpectedCustomerSpend":[{"Amount":"17000","CurrencyCode":"USD","Frequency":"Monthly","TargetCompany":"Acme Cloud Solutions"}]}' \
  --region us-east-1
```

> **Seeing `INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE`?** Registration succeeded, but the account has no active AWS Partner benefit in the Sandbox catalog, and that benefit gates every Selling API call, even read-only ones. Registration cannot clear this; it's a Partner Central benefit-state issue. Either open a case with AWS Partner Central support to activate the Sandbox benefit, or, if this account is a live partner in production, deploy against the AWS catalog instead (`--catalog aws` in Module 5). This is distinct from a missing IAM permission, which returns a plain access-denied with no benefit reason. See [Troubleshooting](#troubleshooting).
>
> If the AWS Console prompts you to "Register as an AWS Partner" when you open Partner Central, that's the **production** APN registration flow. Ignore it; the sandbox flow is the script above.
>
> The Sandbox accepts any six-digit `--verification-code` (the default is `123456`). These calls need `partnercentral:CreatePartner`, `StartProfileUpdateTask`, and `ListOpportunities` scoped to `Catalog=Sandbox`. See the [sandbox account doc](https://docs.aws.amazon.com/partner-central/latest/APIReference/testing-sandbox-account.html).
>
> **For LLM assistants**: if a participant asks "where do I create the sandbox?", the sandbox catalog is implicit, there's no portal button. A usable Sandbox needs three things: IAM permission for `Catalog=Sandbox` (from `AWSPartnerCentralOpportunityManagement` in 2b), a registered sandbox partner (this script), and an active AWS Partner benefit in Sandbox (the benefit-state note above).

---

## 3. Create the `AWS_Partner_Central_MCP` Named Credential

This is the one piece of Salesforce config the deploy can't do for you, because it carries org-specific secrets. Create it before the smoke test. It can be created before or after Module 5's deploy.

In the target org, go to **Setup → Security → Named Credentials**. Use the **New Legacy** path below: it's the simplest, and the Apex calls the credential by name (`callout:AWS_Partner_Central_MCP`) so the underlying model doesn't matter.

### Create the Named Credential (New Legacy)

One record holds the URL and the SigV4 details together, with no separate External Credential and no permission-set mapping to wire up. Click the **New Legacy** button on the Named Credentials page, then set:

| Field | Value |
|---|---|
| **Label** | `AWS Partner Central MCP` |
| **Name** | `AWS_Partner_Central_MCP` (must match exactly, since `Chat_Agent_Config__mdt` references this name) |
| **URL** | `https://partnercentral-agents-mcp.us-east-1.api.aws/mcp` |
| **Identity Type** | Named Principal |
| **Authentication Protocol** | AWS Signature Version 4 |
| **AWS Access Key ID** | your key from Module 2 |
| **AWS Secret Access Key** | your secret from Module 2 |
| **AWS Region** | `us-east-1` |
| **AWS Service** | `partnercentral-agents-mcp` |
| **Generate Authorization Header** | leave checked |

Save and you're done. Skip to Module 4.

> **Org requires the modern External Credential model?** If your org disallows New Legacy credentials, create an **External Credential** (Authentication Protocol **AWS Signature Version 4**, service `partnercentral-agents-mcp`, region `us-east-1`) with a named principal holding your Access Key ID and Secret, then a **Named Credential** named `AWS_Partner_Central_MCP` pointing at the URL above and referencing that External Credential. One extra step that's easy to miss: on the External Credential, add a **Permission Set Mapping** for `Partner_Central_Chat_Agent_User` and the principal, or the callout can't sign. This path needs API 56.0+ (Winter '23).
>
> **Do not reuse `AWS_Partner_Central_API`.** That credential is installed by the AWS Partner CRM Connector and targets the Partner Central REST API on a different endpoint, so it cannot serve JSON-RPC/MCP traffic. This project needs its own dedicated credential.
>
> The config metadata also supports a separate `Sandbox_Named_Credential_Name__c`. For the workshop a single credential is fine, because the same IAM identity reaches both catalogs and the sandbox flag selects which one each turn uses.

### 3a. Create the `AWS_Partner_Central_S3` Named Credential

This is the attachment credential: it lets users attach files (a proposal, meeting notes, a CSV of opportunities) for the agent to read and act on, for example "create these opportunities from the attached CSV". Create it right after the MCP credential, the same **New Legacy** way, pointed at S3:

| Field | Value |
|---|---|
| **Label** | `AWS Partner Central S3` |
| **Name** | `AWS_Partner_Central_S3` (must match `Chat_Agent_Config__mdt.S3_Named_Credential_Name__c`) |
| **URL** | `https://s3.us-east-1.amazonaws.com` |
| **Identity Type** | Named Principal |
| **Authentication Protocol** | AWS Signature Version 4 |
| **AWS Access Key ID** | your key from Module 2 (the same IAM identity works) |
| **AWS Secret Access Key** | your secret |
| **AWS Region** | `us-east-1` |
| **AWS Service** | `s3` |

The identity already carries the `s3:PutObject` permission you added in [Module 2b](#2b-create-or-identify-the-iam-principal-and-attach-the-policies) (step 7), so there's no extra IAM to attach here. On the modern External Credential model, add a Permission Set Mapping for `Partner_Central_Chat_Agent_User` to the principal, same as the MCP credential, or the callout can't sign.

The matching `Chat_Agent_Config__mdt.Default.Aws_Account_Id__c` is set for you by the Module 5 deploy (resolved from `aws sts get-caller-identity`; override with `--aws-account-id <id>` or `AWS_ACCOUNT_ID`), so the upload path becomes `s3://{bucket}/{account-id}/`. Limits: up to 3 files per message, 4.5 MB per document, 3.75 MB per image. Try it end to end in [Module 9](#create-opportunities-from-a-file-attachment-test).

> **Text-only deployment?** If you don't want attachments, skip this credential and the step-7 inline policy in Module 2b. Uploads then fail closed with a clear config error and plain text chat is unaffected.

---

## 4. Authenticate the Salesforce CLI to your org

Point `sf` at the target org and give it an alias you'll reuse in every command below.

For a sandbox or production-style login:

```bash
sf org login web --alias workshop --instance-url <org-domain-name-url>
```

Verify:

```bash
sf org list
```

The `workshop` alias should appear and be connected. Use that alias wherever the commands below say `<org-alias>`.

---

## 5. Deploy the chat metadata and run tests

A single script deploys everything in `manifest/package.xml` and runs only this project's Apex tests (`RunSpecifiedTests`, so any unrelated failing tests already in the org won't block you). It targets the **Sandbox** catalog by default; pass `--catalog aws` for production.

```bash
# Sandbox (default) — safe for the workshop
./scripts/deploy-and-test.sh my-dev-org

# Production catalog instead
./scripts/deploy-and-test.sh my-dev-org --catalog aws
```

The `--catalog` flag sets `Chat_Agent_Config.Default.Is_Sandbox__c` for this deploy. It templates the value with a backup-and-restore so your git working tree stays clean, and you re-deploy with the other value to flip catalogs. If the AWS Partner CRM Connector is installed, its checkbox supersedes this flag (see Module 8). Deploying Sandbox (the default) also means you must register a Sandbox partner (Module 2c) before there's any data to chat about.

The same deploy also templates `Chat_Agent_Config.Default.Aws_Account_Id__c` (used to build the document-upload S3 path), resolving it from `aws sts get-caller-identity` so you don't set it by hand. Pass `--aws-account-id <12-digits>` (or set `AWS_ACCOUNT_ID`) to override, and `--profile <name>` to pick a non-default AWS CLI profile. If no valid id is found the field stays blank and text chat is unaffected; attachments need both this id and the optional `AWS_Partner_Central_S3` credential from Module 3.

Under the hood this runs:

```bash
sf project deploy start \
  --manifest manifest/package.xml \
  --target-org my-dev-org \
  --test-level RunSpecifiedTests \
  --tests ChatAgentControllerTest \
  --tests ChatAgentCoverageTests
```

A clean run is 100+ tests passing with no coverage warnings, ending in `✓ Deploy complete.`

What lands in the org: the `chatAgent` LWC, about 38 Apex classes (controller, MCP client, JSON-RPC serializer and parser, SSE frame parser, session manager, audit logger, approval store, and their tests), the five custom objects, event, and metadata types, the `Chat_Agent_Config.Default` config record, and the `Partner_Central_Chat_Agent_User` permission set.

> **Want a dry run first?** Swap the script for `sf project deploy validate --manifest manifest/package.xml --target-org my-dev-org` to check deployability without committing changes.

---

## 6. Assign the permission set

The chat's `@AuraEnabled` entry points are gated behind a permission set. Assign it to the user who'll run the chat (and the smoke test):

```bash
sf org assign permset --name Partner_Central_Chat_Agent_User --target-org my-dev-org
```

To assign to a different user, add `--on-behalf-of <username>`.

---

## 7. Install the chat for general use

The LWC is named **"Partner Central Chat Agent"** in the component palette. For the default general-chat path, put it where it's always reachable, on Home, the utility bar, or a Sales Opportunity record page.

### 7a. Add it to Home

1. From Home, choose **gear icon → Edit Page** (this opens Lightning App Builder).
2. Drag **"Partner Central Chat Agent"** from the custom components palette into a region.
3. Click **Save**, then **Activate**. In the activation dialog, choose **Assign as Org Default**, click **Save**, then use the back arrow at the top left to exit Lightning App Builder.
4. Reload the page. A hard-refresh (**Cmd+Shift+R** or **Ctrl+Shift+R**) usually does it, but if the component still doesn't appear, **log out of Salesforce and log back in**. That reliably clears the cached page layout.

### 7b. Add it to the Utility Bar (always-visible chat)

Go to **Setup → App Manager → (your app) → Edit → Utility Items → Add** the component. It then rides along in the footer of every page in that app.

Off a record page the chat is general-purpose. You drive it by naming or pasting the opportunity you care about, and it can list and act on your Partner Central co-sell pipeline directly.

### 7c. (Optional, connector path) Add it to an ACE Opportunity record page

If you installed the AWS Partner CRM Connector (Module 1), also drop the component on the ACE Opportunity record page:

1. Open any ACE Opportunity record, then **gear icon → Edit Page**.
2. Drag **"Partner Central Chat Agent"** into a region, then **Save → Activate**.
3. Hard-refresh.

On a record page the opportunity's APN CRM id (for example `O123456789`) is automatically inlined into every chat turn, so you can say *"summarise this opportunity"* without typing an id.

### 7d. Add it to a standard Sales Opportunity page

The component also works on the standard Salesforce **Opportunity** record page (it supports any Lightning record page). Same steps:

1. Open any Opportunity record, then **gear icon → Edit Page**.
2. Drag **"Partner Central Chat Agent"** into a region, then **Save → Activate** (assign as Org Default or per-app as you prefer).
3. Reload the page, refreshing as in 7a (hard-refresh, or log out and back in) if the component doesn't appear right away.

What to expect here: a standard Opportunity is a Salesforce sales record, not a Partner Central opportunity, so the chat runs as **general-purpose** on this page. It does not auto-resolve a Partner Central opportunity from a standard Opportunity, because there's no APN CRM id on it by default, so reference the opportunity by id or name in your message, just like the Home and utility-bar chat. Automatic record context (inlining the APN CRM id) happens only on the connector's ACE Opportunity page (7c), or on any record where an APN CRM id field (for example `APN_CRM_Id__c`) has been mapped.

### Next, after installing

The component is now in place. Where you go next depends on how you deployed:

- **Sandbox (the default)**: the catalog is empty until you set up data. You did this in **Module 2c** (register the Sandbox partner and seed an opportunity); if you skipped it, do it now, then test in **Module 9**.
- **Production (`--catalog aws`)**: your existing pipeline is already there, so skip ahead to **Module 9** to test.
- **Connector path**: confirm the catalog with the connector checkbox in **Module 8a**, then test in **Module 9**.

Module 8 is only about choosing the catalog; the Sandbox data was set up in Module 2c. It is not a separate connector deployment. If a chat turn errors or comes back empty, see [Troubleshooting](#troubleshooting) at the end of this guide.

---

## 8. Choosing the Sandbox vs AWS (production) catalog

Each chat turn targets one Partner Central catalog: `Sandbox` (the default) or `AWS` (production). How that's decided depends on whether the AWS Partner CRM Connector is installed:

- **Standalone (no connector)**: the chat's `Chat_Agent_Config__mdt.Default.Is_Sandbox__c` flag controls the catalog. It ships `true` (Sandbox). You set it at deploy time with `./scripts/deploy-and-test.sh <org-alias> --catalog sandbox|aws` (see Module 5), and re-deploy to flip.
- **Connector path**: the AWS Partner CRM Connector's Custom Settings checkbox (`awsapn__PC_API_Sandbox_Enabled__c`) is the authoritative control. You configure the environment once, in the connector.

Precedence, from `ConfigProvider.isSandbox()`: when the connector is installed, its checkbox wins and the `Is_Sandbox__c` config flag is ignored entirely. The config flag applies only when no connector is present. So the deploy-time `--catalog` choice governs standalone deployments, and installing the connector later silently takes over with no redeploy needed. This is the "configure once in the connector" contract: you never have two competing toggles.

The catalog is a server-side routing decision, not a conversational one. Asking the agent in plain language to "use Sandbox" will not switch catalogs, and the agent may even claim no Sandbox exists. Only the controls above change the catalog.

This module covers the connector checkbox for the connector path (8a), the Sandbox data prerequisite you handled back in Module 2c (8b), and how to switch the standalone catalog, including to production (8c).

> **Sandbox prerequisite.** A fresh deploy targets Sandbox, but the Sandbox catalog starts empty. You registered a Sandbox partner and seeded an opportunity in Module 2c. If you skipped that, do it **before** the Module 9 smoke test or browser test, or "list my opportunities" comes back with nothing. If you deployed with `--catalog aws`, skip 8b and use your existing production pipeline.

### 8a. (Connector path) Flip the connector's sandbox flag

In the org, go to **Setup → Custom Settings → AWS Partner CRM Connector Settings → Edit** and set:

```
awsapn__PC_API_Sandbox_Enabled__c = true
```

Every subsequent chat turn now honors Sandbox, and a "Sandbox" badge appears in the chat header when active. This is the same setting the connector's own [guided setup](https://docs.aws.amazon.com/partner-central/latest/crm/use-guided-setup.html) and [Partner Central API integration](https://docs.aws.amazon.com/partner-central/latest/crm/p-c-api-integration.html) configure.

### 8b. Sandbox data prerequisite (set up in Module 2c)

The Sandbox catalog starts empty, so it needs a registered partner and at least one seeded opportunity before "list my opportunities" returns anything. You did both in [Module 2c](#2c-sandbox-path-register-and-verify-the-sandbox-partner) as part of the AWS-side setup. If you skipped it, go back and run it now, then confirm access from the CLI:

```bash
./scripts/register-sandbox-partner.sh --check
```

Exit code 0 means the Sandbox catalog is reachable and you can move on to Module 9. If it reports `INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE`, the account is registered but has no active Sandbox partner benefit; see the note in Module 2c and [Troubleshooting](#troubleshooting).

### 8c. Switching the standalone catalog (Sandbox is the default)

On the standalone path the catalog comes from `Chat_Agent_Config.Default.Is_Sandbox__c`, which ships `true` (Sandbox), so you normally change nothing for the workshop. To switch catalogs:

- **Preferred**: re-deploy with the flag. Use `./scripts/deploy-and-test.sh <org-alias> --catalog aws` for production, or `--catalog sandbox` to return. The flag sets `Is_Sandbox__c` for the deploy.
- **Manual**: edit the `Chat_Agent_Config.Default` record in **Setup → Custom Metadata Types → Chat Agent Config → Manage Records → Default** and set `Is_Sandbox__c`. Keep `Sandbox_Named_Credential_Name__c` populated (it ships as `AWS_Partner_Central_MCP`; the MCP endpoint is identical for both catalogs, so one credential serves both). The config validator fails closed if `Is_Sandbox__c = true` while that field is blank, so don't clear it.

A "Sandbox" badge shows in the chat header when Sandbox is active. To see data in Sandbox, register a Sandbox partner and create opportunities (8b). If you later install the connector, its checkbox supersedes all of this.

---

## 9. Smoke test

Verify the server-side paths end to end against the live org. The test is split into three opt-in tiers so destructive paths stay behind explicit flags.

```bash
# Tier 1: plumbing only (config, connector detect, session lookup). No callouts. Always safe.
./scripts/smoke/smoke-test.sh my-dev-org

# Tier 2: Tier 1 plus one live read-only sendMessage turn against the MCP server.
./scripts/smoke/smoke-test.sh my-dev-org --live

# Tier 3: Tier 2 plus a full approval round-trip that AUTO-REJECTS (no write ever commits).
./scripts/smoke/smoke-test.sh my-dev-org --approve
```

Target a specific opportunity with `--record-id <id>`. On a standalone org with no AWS Partner CRM Connector, the script auto-falls back to a record-less general-chat mode (or pass `--general-chat` to force it), so Tier 1 and Tier 2 run without an ACE Opportunity. See [`scripts/smoke/README.md`](../scripts/smoke/README.md).

Tier 1's connector detect reports `connectorDetect=null` on a connector-less org, which is expected, and the test still passes. A green Tier 3 run ends with `✓ All smoke-test tiers passed.` and proves the full path: config loads, the sandbox flag resolves, a live `sendMessage` returns a structured events envelope with an `Audit_Log__c` row, a write request registers a `Pending_Write_Operation__c`, and rejecting it advances the state machine to `cancelled / rejected` without committing anything upstream.

> Don't run Tier 3 in a loop, since it hits the live MCP server and consumes upstream quota. See [`scripts/smoke/README.md`](../scripts/smoke/README.md) for exactly what each tier proves.

### Try it in the browser

On the general-chat path (Home or utility bar):

1. Open the chat from Home or the utility bar.
2. Ask *"List my most recent Partner Central opportunities and their stages."* You should get a streamed markdown reply within a few seconds.
3. Ask for a write, for example *"Update the next step on opportunity O123456789 to 'Schedule architecture review'."* An Approve / Reject card appears inline with a field-level diff. Reject is free, and Approve commits the write.

On the connector path (ACE Opportunity record page):

1. Open the ACE Opportunity where you installed the card.
2. Ask *"Summarise this opportunity and list its most recent activity."* The agent already knows which opportunity you mean, so no id is needed.
3. Ask for a write, for example *"Update the next step to 'Schedule architecture review'."* You get the same inline Approve / Reject flow, and Approve commits the write to the catalog selected by the connector toggle.

### Create an opportunity (a write test)

This exercises the full write path and, as a bonus, adds Sandbox data. A `CreateOpportunity` needs about a dozen fields, and the agent will otherwise ask for them one at a time, so paste them all at once and let it propose the write directly. From the chat (Home, utility bar, or a record page):

```text
Create a new opportunity in the Sandbox catalog with these details. Use the values exactly as given and don't ask follow-up questions — propose the CreateOpportunity call directly.

- Customer Company Name: Acme Cloud Solutions
- Customer Country: US, State: California, Postal Code: 94016
- Customer Website: https://acme-cloud.example.com
- Customer Industry: Software & Internet
- Project Title: Acme data warehouse migration
- Project Description: Acme is replacing a 12-year-old on-prem data warehouse that fails monthly and blocks quarterly reporting. Migrate to AWS analytics services for reliability and scale.
- Use Case: Migration
- Delivery Model: SaaS or PaaS
- Expected Monthly Spend: 17000 USD
- Target Close Date: three months from today
- Opportunity Type: Net New Business
- Primary Need from AWS: Co-Sell - Architectural Validation
- Sales Activity: Initialized discussions with customer
- Involvement Type: Co-Sell
- Visibility: Full
- National Security: No
```

Review the Approve card and click **Approve**. The agent calls `CreateOpportunity`; if a field format is rejected it retries with a corrected payload (approve that card too), then returns the new `O##########` id. Re-run "list my opportunities" and it should appear.

### Create opportunities from a file (attachment test)

With the `AWS_Partner_Central_S3` credential from [Module 3a](#3a-create-the-aws_partner_central_s3-named-credential) in place, you can skip the typing and let the agent read the details from a document. The repo ships a sample at [`samples/sample-opportunities.csv`](../samples/sample-opportunities.csv) with two fictional opportunities whose columns map to the `CreateOpportunity` fields (customer account, project, expected spend, target close date, needs-from-AWS).

1. In the chat, click the attachment control (or drag the file in) and add `samples/sample-opportunities.csv`.
2. Send: *"Create these new opportunities from the attached CSV."*
3. The file uploads to Partner Central's ephemeral, write-only S3 bucket, the agent parses it, and it proposes one `CreateOpportunity` per row. Review and **Approve** each card; the writes commit to the selected catalog.

This path needs the attachment config in place: the `AWS_Partner_Central_S3` credential, plus `Aws_Account_Id__c` (set for you by the Module 5 deploy). Without it the upload fails closed with a clear config error and plain text chat is unaffected. Limits: up to 3 files per message, 4.5 MB per document, 3.75 MB per image.

---

## Done? Confirm your deployment is finalized

Your deployment is finalized when all of the **core** items below are true. Until then you're still mid-setup.

Core (every deployment):

- [ ] `deploy-and-test.sh` ended with `✓ Deploy complete.` and 100+ tests passing (Module 5)
- [ ] `Partner_Central_Chat_Agent_User` permission set assigned to your user (Module 6)
- [ ] `AWS_Partner_Central_MCP` Named Credential exists, and its IAM identity has both managed policies (Modules 2 and 3)
- [ ] The chat LWC appears where you placed it (Module 7)
- [ ] Smoke test Tier 1 passes and Tier 2 returns a reply (Module 9)
- [ ] A chat message in the browser returns a streamed answer with no config or auth error

Sandbox path adds (skip if you deployed `--catalog aws`):

- [ ] The chat header shows the **Sandbox** badge
- [ ] A Sandbox partner is registered and at least one opportunity exists, so "list my opportunities" returns data (Module 2c)

You can confirm the server-side state from the CLI at any time. Replace `<org-alias>` and `<your-username>`:

```bash
# Which org, and is it connected?
sf org display --target-org <org-alias>

# Is the permission set assigned to me?
sf data query --target-org <org-alias> -q "SELECT PermissionSet.Name FROM PermissionSetAssignment WHERE PermissionSet.Name='Partner_Central_Chat_Agent_User' AND Assignee.Username='<your-username>'"

# Which catalog does the config point at? (Is_Sandbox__c = true means Sandbox)
sf data query --target-org <org-alias> -q "SELECT Is_Sandbox__c, Named_Credential_Name__c, Sandbox_Named_Credential_Name__c FROM Chat_Agent_Config__mdt WHERE DeveloperName='Default'"
```

The one thing the CLI can't confirm is that the Named Credential's secret is correct: only a live call proves that, which is what the browser test and smoke Tier 2 do. An auth or SigV4 error there means the credential isn't finalized yet, even though everything else looks deployed.

---

## Troubleshooting

### Deploy fails on tests or coverage

`deploy-and-test.sh` runs `ChatAgentControllerTest` and `ChatAgentCoverageTests` at `RunSpecifiedTests`. If coverage dips below 75% on a class, the deploy warns or fails. Re-run after pulling the latest source, and if it persists, run `sf project deploy validate` to see the per-class coverage breakdown.

### Chat header shows no "Sandbox" badge but you expect Sandbox

On the connector path the badge follows the connector, so check **Setup → Custom Settings → AWS Partner CRM Connector Settings → `awsapn__PC_API_Sandbox_Enabled__c`**. On the general-chat path (no connector) the badge follows `Chat_Agent_Config__mdt.Default.Is_Sandbox__c` instead. Tier 1 of the smoke test prints `isSandbox=... connectorDetect=...` so you can confirm what the server resolves (`connectorDetect=null` is normal when no connector is installed).

### Callout fails with an auth or SigV4 error

The `AWS_Partner_Central_MCP` Named Credential is misconfigured, or its IAM identity lacks `AWSMcpServiceActionsFullAccess`. Re-check Module 3 (service `partnercentral-agents-mcp`, region `us-east-1`, URL ending in `/mcp`) and make sure you didn't accidentally point config at `AWS_Partner_Central_API`. This failure happens before any reply renders, because the signed connection itself never establishes.

### Chat connects but the agent replies that it lacks a `partnercentral:` permission

The connection signed and reached AWS (so the Named Credential is correct), but the IAM identity can invoke the MCP service without being allowed to act on Partner Central data. The agent will name the missing action, for example `partnercentral:ListOpportunities`. Attach the `AWSPartnerCentralOpportunityManagement` managed policy to the identity (see Module 2b). No Salesforce or Named Credential change is needed, just re-send the prompt after attaching it.

### `OperationNotFoundException` or record context empty on a record page

This only applies to the connector path. The component isn't resolving an ACE Opportunity, so confirm you dropped it on the ACE Opportunity record page (not a standard Opportunity) and that the AWS Partner CRM Connector is installed so the object exists. On the general-chat path there's no record context by design, so reference the opportunity by id or name in your message instead.

### Write request never commits after Approve

Approvals are correlated by `Operation_Id` and default to `unresolved`. If a write seems stuck, check the `Pending_Write_Operation__c` row's `Status__c` and `Decision__c`. The Tier 3 smoke test exercises this exact state machine and is the fastest way to confirm the path is healthy.

### CreatePartner fails in `register-sandbox-partner.sh`

Your AWS identity lacks `partnercentral:CreatePartner` or `partnercentral:StartProfileUpdateTask` scoped to `Catalog=Sandbox`, or you're in the wrong region. The script targets `us-east-1`, so pass `--profile <name>` if your credentials live in a named profile. The script is "ensure" shaped: it skips creation when a partner already exists, and you can re-run the profile update against a known partner with `--partner-id <id>`. To only confirm access without registering, use `--check`.

### Sandbox calls fail with `INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE`

This is **not** an IAM problem, even though it arrives as an `AccessDeniedException`. The tell is the `Reason` field. A real IAM denial reads "you don't have access to this action or resource, review IAM policies" and carries no `Reason` (the call never passes authorization). A benefit-state denial reads "this action requires an active AWS Partner benefit" with `Reason: INCOMPATIBLE_BENEFIT_AWS_PARTNER_STATE`, which fires only **after** IAM authorization passes, at the partner-benefit check.

So the signing identity has the right permissions; the account just has no active AWS Partner benefit in the **Sandbox** catalog, which gates every Selling API call (even read-only ones like `ListOpportunities`). Registering and completing the partner profile does not grant this benefit. Confirm the diagnosis with `./scripts/register-sandbox-partner.sh --check` (it prints the reason and exits 3), and verify IAM is fine with `aws iam simulate-principal-policy --policy-source-arn <user-arn> --action-names partnercentral:ListOpportunities` (expect `allowed`). To resolve it, either open a case with AWS Partner Central support to activate the Sandbox benefit, or, if this account is a live partner in production, deploy against the AWS catalog instead (`./scripts/deploy-and-test.sh <org-alias> --catalog aws`), which uses the production benefit that's already active.

---

## Workshop teardown

This project creates no standing AWS infrastructure, so there's nothing to delete in CloudFormation, Lambda, API Gateway, DynamoDB, or Secrets Manager. To clean up:

On the Salesforce side (sandbox or scratch org):

- Easiest is to discard the scratch org (`sf org delete scratch --target-org my-dev-org`) or let the sandbox expire.
- To remove from a persisted org, delete the LWC from the record page layout, then destructively delete the metadata if your org policy requires it (build a destructive-changes manifest from `manifest/package.xml`).
- Optionally delete the `AWS_Partner_Central_MCP` Named Credential (and its External Credential, if you created one).

On the AWS side:

- Delete the access key on the `pc-chat-agent-mcp` IAM user (or the whole user) created in Module 2.
- The Sandbox partner from Module 2c lives only in the Partner Central Sandbox catalog. It carries no cost and can be left in place.

---

## Connector reference links

For the connector path, here are AWS's official docs:

- [CRM connector overview](https://docs.aws.amazon.com/partner-central/latest/crm/connector-overview.html), capabilities and [integration options](https://docs.aws.amazon.com/partner-central/latest/crm/routes-for-crm-integration.html)
- [Installing the connector](https://docs.aws.amazon.com/partner-central/latest/crm/install-connector.html), a free AWS-managed package on the [Salesforce AppExchange](https://appexchange.salesforce.com/appxListingDetail?listingId=a0N4V00000IYf0nUAD)
- [Configuring the connector](https://docs.aws.amazon.com/partner-central/latest/crm/configure-crm-connector.html) and [Partner Central API integration setup](https://docs.aws.amazon.com/partner-central/latest/crm/p-c-api-integration.html)
- [Guided setup walkthrough](https://docs.aws.amazon.com/partner-central/latest/crm/use-guided-setup.html) and [ACE object mapping](https://docs.aws.amazon.com/partner-central/latest/crm/crm-connector-mapping.html)
- [ACE mapping guide (Connector v2.0) blog](https://aws.amazon.com/blogs/infrastructure-and-automation/ace-mapping-guide-for-aws-partner-crm-connector-version-2-0/) and the [connector FAQ](https://docs.aws.amazon.com/partner-central/latest/crm/crm-connector-faq.html)
