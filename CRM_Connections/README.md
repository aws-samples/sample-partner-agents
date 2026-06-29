# CRM Connections

Sample integrations that bring the AWS Partner Central Agent into the CRM platforms partner sales teams already use every day.

Each sample is a complete, deployable reference: connector code, infrastructure-as-code, the in-CRM experience (cards, panels), and a guided workshop. They are meant as **guidance and a testing ground**. Clone one, deploy it against a sandbox, see how the pieces fit together, then adapt it to design your own production integration.

---

## Why this exists

Partner sellers live in their CRM. Switching to a separate tool to check pipeline, update an opportunity, or look up funding eligibility adds friction, and updates often don't happen at all. These samples show how to surface the Partner Central Agent, and bidirectional opportunity sync, directly on the CRM records your team already works in.

Rather than prescribe a single "right" architecture, each connection demonstrates patterns (SigV4 auth, human-in-the-loop write approval, async request handling, field mapping, reverse-sync) you can reuse regardless of which CRM you target.

---

## Available connections

| CRM | What's included | Status |
|---|---|---|
| [**HubSpot**](hubspot/) | Partner Central Agent chat card, CRM integration (Share / Submit / Refresh opportunity sync) and a combined deployment of both. Includes guided workshops. | Available |
| Salesforce | Same pattern, targeting Salesforce. | Planned |
| More | Additional CRMs over time. | Planned |

Each connection is self-contained in its own subfolder with its own README, deploy scripts, and docs. Start with the README inside the folder you care about.

---

## What a connection demonstrates

Using [`hubspot/`](hubspot/) as the reference, every connection aims to cover three sample solutions partners can study and test:

| Sample solution | What it shows |
|---|---|
| **Partner Central Agent** | A conversational AI experience embedded on a CRM record, talking to the Partner Central Agent MCP server, with human-in-the-loop approval on every write. |
| **CRM integration** | Reading and writing AWS Partner Central opportunities from CRM records, covering field mapping, opportunity creation/submission, and reverse-sync of AWS-side changes back into the CRM. |
| **CRM integration + Partner Central Agent** | Both of the above deployed together against one account, showing how the sync and the agent coexist. |

Each comes with **workshop documentation** that walks from a fresh laptop to a working deployment against a Partner Central sandbox.

---

## Getting started

1. Pick a CRM from [Available connections](#available-connections).
2. Open that subfolder's README for prerequisites, deploy steps, and workshop links.
3. Deploy against a **sandbox** Partner Central catalog first. Every sample defaults to Sandbox.
4. Use the sample as a starting point and adapt the field mapping, UI, and auth to your own environment.

> These are reference samples, not turnkey production software. Review the IAM policies, secrets handling, and field mappings against your own security and compliance requirements before any production use.

---

## Contributing

We welcome new CRM connections and improvements to existing ones. If you've built an integration for a CRM that isn't here yet, or want to extend one that is, contributions are encouraged.

To keep things consistent, a new connection should:

- Live in its own subfolder (e.g. `salesforce/`) with a self-contained README.
- Include the deploy scripts and infrastructure-as-code needed to stand it up.
- Default to the Partner Central **Sandbox** catalog and document how to switch to production.
- Ship templates/examples for any per-deployment config, and keep real credentials and account-specific values out of the repo (gitignore generated config).
- Include workshop or setup documentation so others can follow along.

See the repository [CONTRIBUTING guide](../CONTRIBUTING.md) for the pull request process and coding standards.

---

## Security

If you discover a potential security issue, please follow the [security issue notification process](../CONTRIBUTING.md#security-issue-notifications). Do not create a public GitHub issue.

---

## License

Licensed under the MIT-0 License. See the [LICENSE](../LICENSE) file.
