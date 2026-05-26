// src/handlers/commands.js
// Slash commands: ack immediately, dispatch async jobs for heavy MCP work.

const mcpClient = require('../services/mcpClient');
const blockKit = require('../formatters/blockKit');
const { formatSlackError } = require('../utils/errors');

function _buildSessionKey(teamId, threadTs) {
  return (teamId || 'local') + ':' + threadTs;
}

// Slack auto-formats emails/URLs/channels into <mailto:...>/<http://...> wrappers.
// Strip those so the MCP agent sees plain text.
function _sanitize(text) {
  if (!text) return '';
  return text
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
    .replace(/<mailto:([^>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function registerCommandHandlers(app, sessionStore, rateLimiter, dispatchJob) {

  app.command('/pc', async ({ command, ack, respond, context }) => {
    await ack();
    const query = _sanitize(command.text);
    if (!query) {
      await respond({ text: 'Usage: `/pc <your question>`', response_type: 'ephemeral' });
      return;
    }
    await respond({ text: 'Asking Partner Central...', response_type: 'ephemeral' });
    await dispatchJob({
      type: 'slash',
      query,
      channel: command.channel_id,
      threadTs: command.thread_ts || null,
      sessionKey: _buildSessionKey(context.teamId, command.thread_ts || command.channel_id),
      formatterType: 'message',
      userId: command.user_id,
      responseUrl: command.response_url,
    });
  });

  app.command('/pc-opps', async ({ command, ack, respond, context }) => {
    await ack();
    await respond({ text: 'Fetching your opportunities...', response_type: 'ephemeral' });
    await dispatchJob({
      type: 'slash',
      query: 'List my open opportunities',
      channel: command.channel_id,
      threadTs: command.thread_ts || null,
      sessionKey: _buildSessionKey(context.teamId, command.thread_ts || command.channel_id),
      formatterType: 'opportunityList',
      userId: command.user_id,
      responseUrl: command.response_url,
    });
  });

  // /pc-session stays synchronous — it's a fast MCP getSession call
  app.command('/pc-session', async ({ command, ack, respond, context }) => {
    await ack();
    try {
      const sessionKey = _buildSessionKey(context.teamId, command.thread_ts || command.channel_id);
      const sessionId = await sessionStore.get(sessionKey);

      if (!sessionId) {
        await respond({ text: 'No active session for this thread.', response_type: 'ephemeral' });
        return;
      }

      const rpcResponse = await mcpClient.getSession(sessionId);
      if (rpcResponse.error) {
        await respond({ text: formatSlackError(rpcResponse.error.code, rpcResponse.error.message), response_type: 'ephemeral' });
        return;
      }

      let sessionData = { sessionId };
      if (rpcResponse.result && rpcResponse.result.content) {
        for (const block of rpcResponse.result.content) {
          if (block.type === 'text') {
            try { sessionData = Object.assign({ sessionId }, JSON.parse(block.text)); } catch (_) {}
          }
        }
      }

      const blocks = blockKit.formatSessionInfo(sessionData);
      await respond({ blocks, response_type: 'ephemeral', text: 'Session info' });

    } catch (err) {
      console.error('[Commands] /pc-session error:', err);
      await respond({ text: 'Error: ' + err.message, response_type: 'ephemeral' });
    }
  });
}

module.exports = { registerCommandHandlers };
