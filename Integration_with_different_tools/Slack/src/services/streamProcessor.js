// src/services/streamProcessor.js
// Consumes the MCP SSE stream and progressively updates a Slack message.

const { streamSendMessage } = require('./mcpStreamClient');
const blockKit = require('../formatters/blockKit');
const { extractApprovalFields } = require('./mcpClient');

const SLACK_API = 'https://slack.com/api';
const UPDATE_THROTTLE_MS = 1100; // Slack chat.update rate-limited to ~1/sec per channel

async function _slackPost(botToken, endpoint, body) {
  const res = await fetch(`${SLACK_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.warn('[Slack]', endpoint, 'failed:', json.error);
  return json;
}

// Send an ephemeral "please invite me" hint via the slash command's response_url.
// response_url doesn't require channel membership, so it works even when chat.postMessage fails.
async function _postInviteHint(responseUrl) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        text: "I can't post in this channel yet. Invite me with `/invite @Partner Central Bot` and try again.",
        response_type: 'ephemeral',
        replace_original: false,
      }),
    });
  } catch (err) {
    console.warn('[StreamProcessor] response_url post failed:', err.message);
  }
}

class SlackMessageStream {
  constructor({ botToken, channel, threadTs, responseUrl }) {
    this.botToken = botToken;
    this.channel = channel;
    this.threadTs = threadTs;
    this.responseUrl = responseUrl;
    this.messageTs = null;
    this.currentRendered = 'Thinking...';
    this.pendingText = null;
    this.lastUpdate = 0;
    this.updateTimer = null;
    this.cannotPost = false;
  }

  async start() {
    const res = await _slackPost(this.botToken, 'chat.postMessage', {
      channel: this.channel,
      thread_ts: this.threadTs,
      text: this.currentRendered,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: this.currentRendered } }],
    });
    if (!res.ok) {
      if (res.error === 'not_in_channel' || res.error === 'channel_not_found') {
        this.cannotPost = true;
        await _postInviteHint(this.responseUrl);
      }
      return false;
    }
    this.messageTs = res.ts;
    return true;
  }

  update(text) {
    this.pendingText = text;
    const now = Date.now();
    const elapsed = now - this.lastUpdate;

    if (elapsed >= UPDATE_THROTTLE_MS) {
      this._flush();
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => this._flush(), UPDATE_THROTTLE_MS - elapsed);
    }
  }

  async _flush() {
    if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = null; }
    if (this.pendingText === null || this.pendingText === this.currentRendered) return;
    this.currentRendered = this.pendingText;
    this.lastUpdate = Date.now();
    if (!this.messageTs) return;

    await _slackPost(this.botToken, 'chat.update', {
      channel: this.channel,
      ts: this.messageTs,
      text: this.currentRendered.substring(0, 3000),
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: this.currentRendered.substring(0, 2900) } }],
    });
  }

  async finalize(text, sessionId, formatterFn) {
    if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = null; }
    const blocks = (formatterFn || blockKit.formatMessage)(text, sessionId);
    if (!this.messageTs) {
      await _slackPost(this.botToken, 'chat.postMessage', {
        channel: this.channel, thread_ts: this.threadTs,
        text: text.substring(0, 3000), blocks,
      });
      return;
    }
    await _slackPost(this.botToken, 'chat.update', {
      channel: this.channel, ts: this.messageTs,
      text: text.substring(0, 3000), blocks,
    });
  }

  async fail(errorText) {
    if (this.updateTimer) { clearTimeout(this.updateTimer); this.updateTimer = null; }
    if (!this.messageTs) {
      await _slackPost(this.botToken, 'chat.postMessage', {
        channel: this.channel, thread_ts: this.threadTs, text: errorText,
      });
      return;
    }
    await _slackPost(this.botToken, 'chat.update', {
      channel: this.channel, ts: this.messageTs, text: errorText,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: errorText } }],
    });
  }
}

const TOOL_ACTIVITY_LABELS = {
  thinking: 'Thinking',
  get_full_opportunity: 'Fetching opportunity details',
  list_opportunities: 'Loading opportunities',
  update_opportunity_enhanced: 'Preparing update',
  get_opportunity: 'Reading opportunity',
};

function _labelForTool(displayName, toolName) {
  if (displayName) return displayName;
  if (TOOL_ACTIVITY_LABELS[toolName]) return TOOL_ACTIVITY_LABELS[toolName];
  if (toolName) return 'Running ' + toolName;
  return 'Working';
}

// The MCP stream wraps events inside { method: "notifications/progress", params: {...} }.
// Extract the params object (the actual event payload) from the raw SSE data.
function _eventPayload(data) {
  if (!data) return {};
  // Real MCP event structure wraps payload in params
  if (data.params) return data.params;
  // Some events (stream_end) put result at the top
  return data;
}

async function processStream({ query, sessionId, botToken, channel, threadTs, formatterType, responseUrl }) {
  const slackStream = new SlackMessageStream({ botToken, channel, threadTs, responseUrl });
  const started = await slackStream.start();

  // Bail out early if we can't post in this channel — no point running a 30s MCP call
  // whose output no one will see. The invite hint has already been sent.
  if (!started && slackStream.cannotPost) {
    return { type: 'skipped', reason: 'not_in_channel' };
  }

  // Separate cumulative text buckets:
  //   deltaText  = concatenated 'assistant-response.delta' chunks (in-progress narration)
  //   finalText  = the final full text captured on 'assistant-response.completed'
  let deltaText = '';
  let finalText = '';
  let activityLine = '';
  let finalSessionId = sessionId;
  let approvalBlock = null;
  let streamError = null;

  try {
    for await (const frame of streamSendMessage({ text: query, sessionId })) {
      const { event, data } = frame;
      const payload = _eventPayload(data);
      const contentBlock = payload.contentBlock || {};
      const blockText = (contentBlock.content && contentBlock.content.text) || '';

      if (payload.sessionId) finalSessionId = payload.sessionId;

      // Stream lifecycle
      if (event === 'stream_start') continue;
      if (event === 'stream_end') break;
      if (event === 'done') continue;

      // Text delta — append to the running narration
      if (event === 'assistant-response.delta') {
        if (blockText) {
          deltaText += blockText;
          const display = deltaText + (activityLine ? '\n\n_' + activityLine + '..._' : '');
          slackStream.update(display);
        }
        continue;
      }

      // Completion of a single assistant-response block — replace deltaText with the canonical full text
      if (event === 'assistant-response.completed') {
        if (blockText) {
          // This block's full text supersedes any deltas accumulated so far for this block
          finalText = blockText; // store the last completed block as the final text
          deltaText = blockText; // reset the narration
          const display = deltaText + (activityLine ? '\n\n_' + activityLine + '..._' : '');
          slackStream.update(display);
        }
        continue;
      }

      // Tool activity indicators
      if (event === 'server-tool-use' || event === 'serverToolUse') {
        const toolName = contentBlock.name || contentBlock.toolName || payload.name;
        const displayActivity = contentBlock.displayToolActivity || payload.displayToolActivity;
        activityLine = _labelForTool(displayActivity, toolName);
        slackStream.update((deltaText || '') + '\n\n_' + activityLine + '..._');
        continue;
      }
      if (event === 'server-tool-response' || event === 'serverToolResult') {
        activityLine = '';
        slackStream.update(deltaText);
        continue;
      }

      // Approval
      if (event === 'tool-approval-request' || event === 'tool_approval_request' ||
          (contentBlock.type === 'tool_approval_request')) {
        approvalBlock = contentBlock;
        continue;
      }

      // Errors
      if (event === 'error' || (payload.error)) {
        streamError = payload.error || payload.message || 'Stream error';
      }
    }
  } catch (err) {
    console.error('[StreamProcessor] Stream error:', err);
    streamError = err.message;
  }

  // Outcome
  if (streamError) {
    await slackStream.fail('Error: ' + streamError);
    return { type: 'error', message: streamError };
  }

  if (approvalBlock) {
    const fields = extractApprovalFields(approvalBlock);
    const blocks = blockKit.formatApprovalCard(fields, finalSessionId);
    await _slackPost(botToken, 'chat.update', {
      channel, ts: slackStream.messageTs,
      text: 'Write operation requires approval', blocks,
    });
    return { type: 'approval_required', sessionId: finalSessionId, approvalRequest: fields };
  }

  const outputText = finalText || deltaText || '(no response)';
  const formatter = formatterType === 'opportunityList'
    ? blockKit.formatOpportunityList
    : blockKit.formatMessage;

  await slackStream.finalize(outputText, finalSessionId, formatter);
  return { type: 'message', sessionId: finalSessionId, text: outputText };
}

module.exports = { processStream };
