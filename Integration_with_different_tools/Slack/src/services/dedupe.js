// src/services/dedupe.js
// DynamoDB-backed event deduplication with in-memory fallback.
// Protects against Slack retrying events across different Lambda containers.

const DEDUPE_TTL_SECONDS = 5 * 60; // 5 minutes

let client = null;
let tableName = null;
let PutCommand = null;

function _init() {
  if (client !== null) return;
  tableName = process.env.DEDUPE_TABLE_NAME || process.env.SESSION_TABLE_NAME || null;
  if (!tableName) {
    console.log('[Dedupe] No table configured — falling back to in-memory dedupe');
    client = 'memory';
    return;
  }
  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand: _PutCommand } = require('@aws-sdk/lib-dynamodb');
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    PutCommand = _PutCommand;
    console.log('[Dedupe] Using DynamoDB table: ' + tableName);
  } catch (err) {
    console.warn('[Dedupe] DynamoDB init failed, falling back to memory:', err.message);
    client = 'memory';
  }
}

// In-memory fallback for local dev or if DynamoDB is unavailable
const memStore = new Map();

async function isDuplicate(eventId) {
  if (!eventId) return false;
  _init();

  if (client === 'memory') {
    return _memoryIsDuplicate(eventId);
  }

  // Use DynamoDB conditional put — only succeeds if the key doesn't exist
  const expiresAt = Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS;
  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        threadTs: 'dedupe:' + eventId,
        sessionId: 'processed',
        expiresAt,
      },
      ConditionExpression: 'attribute_not_exists(threadTs)',
    }));
    return false; // first time seeing this event
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log('[Dedupe] Duplicate event ' + eventId);
      return true;
    }
    // On any other error, fail open (allow processing) and log
    console.warn('[Dedupe] DynamoDB error, allowing event:', err.message);
    return false;
  }
}

function _memoryIsDuplicate(eventId) {
  const now = Date.now();
  for (const [id, ts] of memStore) {
    if (now - ts > DEDUPE_TTL_SECONDS * 1000) memStore.delete(id);
  }
  if (memStore.has(eventId)) {
    console.log('[Dedupe] Duplicate event (memory) ' + eventId);
    return true;
  }
  memStore.set(eventId, now);
  return false;
}

module.exports = { isDuplicate };
