# Partner Central Agents — Integration Guide

## Amazon Quick Desktop

Amazon Quick Desktop provides a quick path for individual partners to start using Partner Central Agents outside of the AWS console. It's ideal for partner sales reps, solution architects, and account managers who want AI-powered pipeline insights without writing any code or changing their existing workflow.

With Amazon Quick Desktop, partners get a conversational AI interface on their local machine that connects directly to Partner Central Agents via MCP. This means they can ask natural language questions about their opportunities, get funding recommendations, generate sales plays, and receive deal progression guidance — all without opening a browser or navigating the AWS console. The setup takes minutes: configure the MCP connection with your AWS credentials, and you're ready to go.

Partners choose this option when they want a personal productivity tool that lives alongside their other desktop applications. It's particularly valuable for partners who spend their day in meetings, on calls, or working across multiple tools and want quick access to pipeline intelligence without context-switching. Since it runs locally, there's no infrastructure to manage, no middleware to deploy, and no ongoing maintenance. It's a single-user experience designed for speed and convenience.

This is a choice for partners who want to get started immediately with minimal friction, don't need to share the integration across a team, and prefer a desktop-native experience over a browser-based one.

---

## Slack

Slack integration brings Partner Central Agents into the collaboration tool where partner sales teams already communicate daily. Instead of one person accessing insights on their desktop, the entire team can query the pipeline, share opportunity summaries, and get funding guidance directly in their Slack channels and threads.

This approach is designed for partner organizations that want to make pipeline intelligence a shared, team-wide capability. When a sales rep asks about an opportunity in a Slack channel, the response is visible to the whole team — creating transparency, enabling coaching moments, and reducing the need for status update meetings. Managers can ask for pipeline summaries in team channels, and the answers become part of the team's shared context.

The Slack integration requires more setup than Amazon Quick Desktop because it involves deploying middleware (typically an AWS Lambda function behind API Gateway) that bridges Slack's event system with the Partner Central MCP endpoint. This middleware handles authentication, routes messages between Slack and the agent, and posts responses back to the appropriate channel or thread. Partners choose this path when they're willing to invest in a small amount of infrastructure to unlock a team-wide experience.

Beyond basic Q&A, the Slack integration opens up powerful workflow possibilities. Partners can set up slash commands for common queries (like `/pipeline` for a weekly summary), use interactive messages for write operation approvals (Approve/Reject buttons instead of typing), and maintain conversation context within Slack threads so follow-up questions work naturally. For write operations — like updating an opportunity — the agent posts an approval request as an interactive message, and the user can approve or reject with a single click.

This is a choice for partner organizations that want to democratize access to pipeline intelligence across their sales team, prefer a collaborative experience over an individual one, and are comfortable deploying a lightweight middleware layer to connect the two systems.
