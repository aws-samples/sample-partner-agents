// src/handlers/events.js
// Receives Slack events and dispatches async jobs. Keeps the HTTP handler under 3s.

const { isDuplicate } = require('../services/dedupe');

function _isSlackRetry(context) {
  const retryNum = context && context.retryNum;
  if (retryNum && retryNum > 0) {
    console.log('[Events] Skipping Slack retry #' + retryNum);
    return true;
  }
  return false;
}

function _buildSessionKey(teamId, threadTs) {
  return (teamId || 'local') + ':' + threadTs;
}

function stripMention(text) {
  if (!text) return '';
  return text
    // Remove <@BOTID> mentions
    .replace(/<@[A-Z0-9]+>\s*/g, '')
    // Unwrap <mailto:foo@bar.com|foo@bar.com> → foo@bar.com
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
    // Unwrap <mailto:foo@bar.com> → foo@bar.com
    .replace(/<mailto:([^>]+)>/g, '$1')
    // Unwrap <http(s)://url|display text> → display text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    // Unwrap <http(s)://url> → url
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // Unwrap <#C12345|channel-name> → #channel-name
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    // Decode Slack's HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function registerEventHandlers(app, sessionStore, rateLimiter, dispatchJob) {
  app.event('app_mention', async (args) => {
    if (_isSlackRetry(args.context)) return;
    if (await isDuplicate(args.body && args.body.event_id)) return;
    await _enqueueMessageJob(args.event, args.context.teamId, dispatchJob);
  });

  app.event('message', async (args) => {
    const event = args.event;
    if (event.channel_type !== 'im' || event.bot_id || event.subtype) return;
    if (_isSlackRetry(args.context)) return;
    if (await isDuplicate(args.body && args.body.event_id)) return;
    await _enqueueMessageJob(event, args.context.teamId, dispatchJob);
  });
}

async function _enqueueMessageJob(event, teamId, dispatchJob) {
  const threadTs = event.thread_ts || event.ts;
  const userText = stripMention(event.text);
  if (!userText.trim()) return;

  await dispatchJob({
    type: 'message',
    query: userText,
    channel: event.channel,
    threadTs,
    sessionKey: _buildSessionKey(teamId, threadTs),
    formatterType: 'message',
    userId: event.user,
  });
}

module.exports = { registerEventHandlers };
