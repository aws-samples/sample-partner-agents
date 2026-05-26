// src/services/sessionStore.js
// Maps Slack thread_ts → MCP sessionId.
// Uses in-memory store for local dev, DynamoDB for production.

const SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// --- In-Memory Store (local dev) ---
class InMemoryStore {
  constructor() {
    this._map = new Map();
    this._timers = new Map();
  }

  async get(threadTs) {
    const entry = this._map.get(threadTs);
    return entry || null;
  }

  async set(threadTs, sessionId) {
    this._map.set(threadTs, sessionId);
    // Auto-expire after 48hr
    if (this._timers.has(threadTs)) clearTimeout(this._timers.get(threadTs));
    this._timers.set(threadTs, setTimeout(() => {
      this._map.delete(threadTs);
      this._timers.delete(threadTs);
    }, SESSION_TTL_MS));
  }

  async delete(threadTs) {
    this._map.delete(threadTs);
    if (this._timers.has(threadTs)) {
      clearTimeout(this._timers.get(threadTs));
      this._timers.delete(threadTs);
    }
  }
}

// --- DynamoDB Store (production) ---
class DynamoDBStore {
  constructor(tableName) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    this._client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this._table = tableName;
    this._GetCommand = GetCommand;
    this._PutCommand = PutCommand;
    this._DeleteCommand = DeleteCommand;
  }

  async get(threadTs) {
    const res = await this._client.send(new this._GetCommand({
      TableName: this._table,
      Key: { threadTs },
    }));
    return res.Item?.sessionId || null;
  }

  async set(threadTs, sessionId) {
    const expiresAt = Math.floor((Date.now() + SESSION_TTL_MS) / 1000);
    await this._client.send(new this._PutCommand({
      TableName: this._table,
      Item: { threadTs, sessionId, expiresAt },
    }));
  }

  async delete(threadTs) {
    await this._client.send(new this._DeleteCommand({
      TableName: this._table,
      Key: { threadTs },
    }));
  }
}

// Factory — picks store based on env
function createSessionStore() {
  const tableName = process.env.SESSION_TABLE_NAME;
  if (tableName) {
    console.log(`[SessionStore] Using DynamoDB table: ${tableName}`);
    return new DynamoDBStore(tableName);
  }
  console.log('[SessionStore] Using in-memory store (local dev)');
  return new InMemoryStore();
}

module.exports = { createSessionStore };
