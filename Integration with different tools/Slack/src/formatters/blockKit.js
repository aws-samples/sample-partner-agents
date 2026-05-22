// src/formatters/blockKit.js
// Converts MCP agent responses into Slack Block Kit structures.

const MAX_TEXT_LENGTH = 2900; // Slack block text limit with buffer

function formatOpportunityList(text, sessionId) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Your Opportunities', emoji: false } },
    { type: 'divider' },
    ...splitLongResponse(text),
    { type: 'divider' },
    _footer(sessionId),
  ];
  return blocks;
}

function formatOpportunityDetail(text, sessionId) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Opportunity Details', emoji: false } },
    { type: 'divider' },
    ...splitLongResponse(text),
    { type: 'divider' },
    _footer(sessionId),
  ];
  return blocks;
}

function formatApprovalCard(approvalRequest, sessionId) {
  const { toolUseId, toolName, parameters } = approvalRequest || {};
  let paramText;
  if (typeof parameters === 'string') {
    paramText = parameters;
  } else if (parameters !== undefined && parameters !== null) {
    paramText = JSON.stringify(parameters, null, 2);
  } else {
    paramText = '(no parameters provided by agent)';
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Write Operation Requires Approval', emoji: false },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Operation:* \`${toolName || 'Unknown'}\`\n*Tool Use ID:* \`${toolUseId || 'N/A'}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Proposed Changes:*\n\`\`\`${paramText.substring(0, 2500)}\`\`\``,
      },
    },
    {
      type: 'actions',
      block_id: `approval_${toolUseId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: false },
          style: 'primary',
          action_id: 'approve_write',
          value: JSON.stringify({ toolUseId, sessionId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: false },
          style: 'danger',
          action_id: 'reject_write',
          value: JSON.stringify({ toolUseId, sessionId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Override', emoji: false },
          action_id: 'override_write',
          value: JSON.stringify({ toolUseId, sessionId }),
        },
      ],
    },
  ];
  return blocks;
}

function formatError(errorText) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: errorText },
    },
  ];
}

function formatSessionInfo(sessionData) {
  const parsed = typeof sessionData === 'string' ? JSON.parse(sessionData) : sessionData;
  const text = [
    `*Session ID:* \`${parsed.sessionId || 'N/A'}\``,
    `*Created:* ${parsed.createdAt || 'N/A'}`,
    `*Last Activity:* ${parsed.lastActivity || 'N/A'}`,
    `*Events:* ${parsed.eventCount ?? 'N/A'}`,
    `*Sequence:* ${parsed.sequenceNumber ?? 'N/A'}`,
  ].join('\n');

  return [
    { type: 'header', text: { type: 'plain_text', text: 'Session Info', emoji: false } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text } },
  ];
}

function formatMessage(text, sessionId) {
  const blocks = [
    ...splitLongResponse(text),
    { type: 'divider' },
    _footer(sessionId),
  ];
  return blocks;
}

function splitLongResponse(text) {
  if (!text) return [{ type: 'section', text: { type: 'mrkdwn', text: '_(empty response)_' } }];
  if (text.length <= MAX_TEXT_LENGTH) {
    return [{ type: 'section', text: { type: 'mrkdwn', text } }];
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.substring(0, MAX_TEXT_LENGTH);
    // Try to break at a newline
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > MAX_TEXT_LENGTH * 0.5) {
      chunk = remaining.substring(0, lastNewline + 1);
    }
    chunks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    remaining = remaining.substring(chunk.length);
  }
  return chunks;
}

function _footer(sessionId) {
  const sid = sessionId ? `Session: \`${sessionId.substring(0, 20)}...\`` : 'No active session';
  return {
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `${sid} • ${new Date().toISOString()}` },
    ],
  };
}

// Builds the "approved/rejected/overridden" update for an approval card
function formatApprovalResult(decision, userId) {
  const labels = { approve: 'Approved', reject: 'Rejected', override: 'Overridden' };
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${labels[decision] || decision}* by <@${userId}>` },
  };
}

module.exports = {
  formatOpportunityList,
  formatOpportunityDetail,
  formatApprovalCard,
  formatError,
  formatSessionInfo,
  formatMessage,
  splitLongResponse,
  formatApprovalResult,
};
