# Sample Meeting Notes

Five realistic scenarios designed to demonstrate how the orchestrator agent generates **noticeably different next steps** depending on what's in the meeting notes. Use these for the workshop's "Update Next Steps" tab to show the agent's reasoning quality.

## How to use

1. Open the demo UI at `http://localhost:8002`
2. Switch to the **✏️ Update Next Steps** tab
3. Paste the contents of any file below into the meeting notes textarea
4. Click **🤖 Generate Next Steps** and observe how the AI tailors the output

Or for the **📝 Create from Notes** tab, paste these as the deal description — the agent will extract customer details and create the opportunity.

## Scenarios

| File | Stage | What the agent should generate |
|------|-------|-------------------------------|
| `meeting_notes_discovery_call.txt` | **Discovery** — first meeting, customer brand new to AWS | Education-focused next steps: send overview deck, schedule technical deep-dive, share whitepapers, pricing calculator |
| `meeting_notes_technical_validation.txt` | **Technical Validation** — security and architecture review | Technical actions: schedule Well-Architected Review, deliver SOC 2 docs, run benchmark, scope POC |
| `meeting_notes_funding_request.txt` | **Committed** — qualified deal, customer asking about funding | Funding-focused: submit MAP request, build business case deck, lock Savings Plan terms |
| `meeting_notes_renewal_at_risk.txt` | **At Risk** — existing customer considering competitor | Retention actions: cost optimization assessment, exec escalation, modernization roadmap, multi-year proposal |
| `meeting_notes_closing_obstacles.txt` | **Late Negotiation** — multiple non-technical blockers | Closing actions: exec 1:1, reference customer calls, contract red-line response, replacement champion plan |

## Create-from-Notes scenarios

These files have all required ACE fields filled out and are intended for the **📝 Create from Notes** tab. They each pick a different combination of enum values, industry, and AWS involvement type so the demo can show the agent extracting very different opportunities from the same workflow.

| File | Industry | Use Case | AWS Involvement | Opportunity Type |
|------|----------|----------|-----------------|------------------|
| `meeting_notes_complete_for_create.txt` | Financial Services | Migration / Database Migration | Co-Sell | Net New Business |
| `meeting_notes_complete_for_create_healthcare_ml.txt` | Healthcare and Life Sciences | AI Machine Learning and Analytics | For Visibility Only | Expansion |

## Why these scenarios

Each file is designed to:
- **Be realistic** — written like actual sales call notes, not toy examples
- **Stress different agent reasoning paths** — discovery generates very different next steps than retention
- **Highlight the agent's ability to extract specifics** — names, dollar amounts, deadlines, action owners
- **Pair with different stages** — useful when you want to show how the same agent handles a deal at different points in the pipeline

## Demo tip

Run the agent on two scenarios back-to-back (e.g., discovery + closing obstacles). Partners will see the AI is actually reading the content rather than producing generic boilerplate.
