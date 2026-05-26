// src/handlers/actions.js
// Approval button and modal handlers — dispatch async jobs for MCP approval calls.

const { isDuplicate } = require('../services/dedupe');

function _isSlackRetry(context) {
  const retryNum = context && context.retryNum;
  if (retryNum && retryNum > 0) {
    console.log('[Actions] Skipping Slack retry #' + retryNum);
    return true;
  }
  return false;
}

function registerActionHandlers(app, sessionStore, rateLimiter, dispatchJob) {

  // Approve button
  app.action('approve_write', async ({ body, ack, context }) => {
    await ack();
    if (_isSlackRetry(context)) return;

    const { toolUseId, sessionId } = JSON.parse(body.actions[0].value);

    // Dedupe by (sessionId, toolUseId, decision) — these stay stable across
    // Slack retries when the Lambda is slow to ack. A previous version keyed
    // on body.actions[0].action_ts which changes per retry, allowing duplicate
    // approval jobs to fire and creating duplicate opportunities downstream.
    const dedupeKey = 'approval:' + sessionId + ':' + toolUseId + ':approve';
    if (await isDuplicate(dedupeKey)) return;

    await dispatchJob({
      type: 'approval',
      sessionId,
      toolUseId,
      decision: 'approve',
      userId: body.user.id,
      channel: body.channel.id,
      messageTs: body.message.ts,
      threadTs: body.message.thread_ts || body.message.ts,
      originalBlocks: body.message.blocks,
    });
  });

  // Reject button — opens modal
  app.action('reject_write', async ({ body, ack, client, context }) => {
    await ack();
    if (_isSlackRetry(context)) return;
    const value = body.actions[0].value;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: _buildReasonModal('reject_submit', value, 'Reject Write Operation', 'Why are you rejecting? (optional)',
        body.channel.id, body.message.thread_ts || body.message.ts, body.message.ts, body.message.blocks),
    });
  });

  // Override button — opens modal
  app.action('override_write', async ({ body, ack, client, context }) => {
    await ack();
    if (_isSlackRetry(context)) return;
    const value = body.actions[0].value;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: _buildReasonModal('override_submit', value, 'Override Write Operation', 'Provide override instructions:',
        body.channel.id, body.message.thread_ts || body.message.ts, body.message.ts, body.message.blocks),
    });
  });

  // Modal submissions
  app.view('reject_submit', async ({ ack, view, body, context }) => {
    await ack();
    if (_isSlackRetry(context)) return;
    const { toolUseId, sessionId } = JSON.parse(JSON.parse(view.private_metadata).actionValue);
    const dedupeKey = 'approval:' + sessionId + ':' + toolUseId + ':reject';
    if (await isDuplicate(dedupeKey)) return;
    await _enqueueModalSubmit('reject', view, body, dispatchJob);
  });

  app.view('override_submit', async ({ ack, view, body, context }) => {
    await ack();
    if (_isSlackRetry(context)) return;
    const { toolUseId, sessionId } = JSON.parse(JSON.parse(view.private_metadata).actionValue);
    const dedupeKey = 'approval:' + sessionId + ':' + toolUseId + ':override';
    if (await isDuplicate(dedupeKey)) return;
    await _enqueueModalSubmit('override', view, body, dispatchJob);
  });
}

async function _enqueueModalSubmit(decision, view, body, dispatchJob) {
  const metadata = JSON.parse(view.private_metadata);
  const { toolUseId, sessionId } = JSON.parse(metadata.actionValue);
  const message = view.state.values.reason_block.reason_input.value || '';

  await dispatchJob({
    type: 'approval',
    sessionId,
    toolUseId,
    decision,
    message,
    userId: body.user.id,
    channel: metadata.channel,
    threadTs: metadata.threadTs,
    messageTs: metadata.messageTs,
    originalBlocks: metadata.originalBlocks,
  });
}

function _buildReasonModal(callbackId, actionValue, title, label, channel, threadTs, messageTs, originalBlocks) {
  return {
    type: 'modal',
    callback_id: callbackId,
    private_metadata: JSON.stringify({ actionValue, channel, threadTs, messageTs, originalBlocks }),
    title: { type: 'plain_text', text: title.substring(0, 24) },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reason_block',
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'reason_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: label },
        },
        label: { type: 'plain_text', text: label },
      },
    ],
  };
}

module.exports = { registerActionHandlers };
