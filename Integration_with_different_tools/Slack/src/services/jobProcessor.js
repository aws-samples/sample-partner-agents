// src/services/jobProcessor.js
// Processes async jobs invoked by the first Lambda's dispatch.
// Uses SSE streaming for message/slash jobs so users see progress in real time.
// Falls back to non-streaming for approvals (short calls, no progress needed).

const mcpClient = require('./mcpClient');
const blockKit = require('../formatters/blockKit');
const { getErrorInfo, formatSlackError, backoffDelay } = require('../utils/errors');
const { processStream } = require('./streamProcessor');

const SLACK_API = 'https://slack.com/api';
const STREAMING_ENABLED = process.env.STREAMING_ENABLED !== 'false';

// Post a message to Slack using the bot token directly (no Bolt client needed).
// If the bot isn't in the channel, falls back to the slash command's response_url
// (which is ephemeral and doesn't require channel membership) so the user sees
// an actionable "invite me" hint instead of silence.
async function _postMessage({ botToken, channel, thread_ts, text, blocks, responseUrl }) {
  const body = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;
  if (blocks) body.blocks = blocks;

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();

  if (!json.ok) {
    if (json.error === 'not_in_channel' || json.error === 'channel_not_found') {
      console.warn('[JobProcessor] Slack postMessage failed:', json.error);
      // Fall back to response_url if we have one (slash commands only).
      // App mentions and DMs don't hit this path because the bot is already reachable there.
      if (responseUrl) {
        await _postViaResponseUrl(responseUrl,
          "I can't post in this channel yet. Invite me with `/invite @Partner Central Bot` and try again.");
      }
    } else {
      console.error('[JobProcessor] Slack postMessage failed:', json.error);
    }
  }
  return json;
}

// Post to a Slack-provided response_url — ephemeral, no channel membership required.
// Valid for ~30 minutes after the originating slash command.
async function _postViaResponseUrl(responseUrl, text, blocks) {
  const body = { text, response_type: 'ephemeral', replace_original: false };
  if (blocks) body.blocks = blocks;
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn('[JobProcessor] response_url returned HTTP', res.status);
  } catch (err) {
    console.warn('[JobProcessor] response_url post failed:', err.message);
  }
}

async function _updateMessage({ botToken, channel, ts, text, blocks }) {
  const body = { channel, ts, text };
  if (blocks) body.blocks = blocks;

  const res = await fetch(`${SLACK_API}/chat.update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Main entrypoint — routes by job.type
async function processJob(job, { sessionStore, rateLimiter, botToken }) {
  console.log('[JobProcessor] Processing:', job.type);
  switch (job.type) {
    case 'message':
    case 'slash':
      return _processMessageJob(job, { sessionStore, rateLimiter, botToken });
    case 'approval':
      return _processApprovalJob(job, { sessionStore, rateLimiter, botToken });
    default:
      console.warn('[JobProcessor] Unknown job type:', job.type);
  }
}

// Handles app_mention, DM, and slash command queries — uses SSE streaming for progress
async function _processMessageJob(job, { sessionStore, rateLimiter, botToken }) {
  const { query, channel, threadTs, sessionKey, formatterType, responseUrl } = job;

  try {
    const sessionId = await sessionStore.get(sessionKey);
    await rateLimiter.acquire();

    if (STREAMING_ENABLED) {
      try {
        const result = await processStream({ query, sessionId, botToken, channel, threadTs, formatterType, responseUrl });

        // Persist updated session mapping
        if (result.sessionId) {
          await sessionStore.set(sessionKey, result.sessionId);
        }
        return;
      } catch (err) {
        console.warn('[JobProcessor] Streaming failed, falling back to non-streaming:', err.message);
        // Fall through to non-streaming below
      }
    }

    // Non-streaming fallback
    const rpcResponse = await mcpClient.sendMessage({ text: query, sessionId });
    const parsed = mcpClient.parseAgentResponse(rpcResponse);

    if (parsed.type === 'error') {
      const handled = await _handleErrorWithRetry(parsed, query, sessionId, rateLimiter, botToken, channel, threadTs, responseUrl);
      if (!handled) {
        await _postMessage({
          botToken, channel, thread_ts: threadTs, responseUrl,
          text: formatSlackError(parsed.code, parsed.message),
        });
      }
      return;
    }

    if (parsed.sessionId) {
      await sessionStore.set(sessionKey, parsed.sessionId);
    }

    if (parsed.type === 'approval_required') {
      const blocks = blockKit.formatApprovalCard(parsed.approvalRequest, parsed.sessionId);
      await _postMessage({ botToken, channel, thread_ts: threadTs, blocks, responseUrl, text: 'Write operation requires approval' });
      return;
    }

    const formatter = formatterType === 'opportunityList'
      ? blockKit.formatOpportunityList
      : blockKit.formatMessage;
    const blocks = formatter(parsed.text, parsed.sessionId);
    await _postMessage({ botToken, channel, thread_ts: threadTs, blocks, responseUrl, text: parsed.text });

  } catch (err) {
    console.error('[JobProcessor] Message job error:', err);
    await _postMessage({
      botToken, channel, thread_ts: threadTs, responseUrl,
      text: 'Something went wrong: ' + err.message,
    });
  }
}

// Handles approve/reject/override button responses
async function _processApprovalJob(job, { rateLimiter, botToken }) {
  const { sessionId, toolUseId, decision, message, channel, threadTs, messageTs, originalBlocks, userId, responseUrl } = job;

  try {
    await rateLimiter.acquire();
    const rpcResponse = await mcpClient.sendApproval({ sessionId, toolUseId, decision, message });
    const parsed = mcpClient.parseAgentResponse(rpcResponse);

    // Suppress the "already processed" error from duplicate submissions
    if (parsed.type === 'error' && parsed.code === -32602 &&
        /session state|already/i.test(parsed.message || '')) {
      console.log('[JobProcessor] Suppressing duplicate approval response');
      return;
    }

    // Update original approval card — disable buttons, show result
    if (messageTs && originalBlocks) {
      const updatedBlocks = originalBlocks
        .filter(b => b.type !== 'actions')
        .concat([blockKit.formatApprovalResult(decision, userId)]);
      await _updateMessage({
        botToken, channel, ts: messageTs,
        blocks: updatedBlocks, text: `Write ${decision}d`,
      });
    }

    // Chained approval — agent proposes a new write after processing this one
    if (parsed.type === 'approval_required') {
      const blocks = blockKit.formatApprovalCard(parsed.approvalRequest, parsed.sessionId);
      await _postMessage({
        botToken, channel, thread_ts: threadTs, blocks, responseUrl,
        text: 'Agent is proposing a follow-up write — approval required',
      });
      return;
    }

    const text = parsed.type === 'error'
      ? formatSlackError(parsed.code, parsed.message)
      : parsed.text || `Operation ${decision}d.`;

    await _postMessage({ botToken, channel, thread_ts: threadTs, text, responseUrl });

  } catch (err) {
    console.error('[JobProcessor] Approval job error:', err);
    await _postMessage({
      botToken, channel, thread_ts: threadTs, responseUrl,
      text: `${decision} failed: ${err.message}`,
    });
  }
}

async function _handleErrorWithRetry(parsed, query, sessionId, rateLimiter, botToken, channel, threadTs, responseUrl) {
  const info = getErrorInfo(parsed.code);
  if (!info.retry) return false;

  const maxRetries = info.maxRetries || 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const delay = backoffDelay(attempt, info.baseDelayMs || 1000);
    await new Promise(r => setTimeout(r, delay));
    await rateLimiter.acquire();

    const retryResponse = await mcpClient.sendMessage({ text: query, sessionId });
    const retryParsed = mcpClient.parseAgentResponse(retryResponse);

    if (retryParsed.type !== 'error') {
      const blocks = blockKit.formatMessage(retryParsed.text, retryParsed.sessionId);
      await _postMessage({ botToken, channel, thread_ts: threadTs, blocks, responseUrl, text: retryParsed.text });
      return true;
    }
  }

  await _postMessage({
    botToken, channel, thread_ts: threadTs, responseUrl,
    text: formatSlackError(parsed.code, `Failed after ${maxRetries} retries.`),
  });
  return true;
}

module.exports = { processJob };
