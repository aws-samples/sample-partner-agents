// src/services/mcpStreamClient.js
// SSE streaming client for the Partner Central MCP Server.
// Parses the event stream and yields typed events as they arrive.

const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');

const MCP_ENDPOINT = 'https://partnercentral-agents-mcp.us-east-1.api.aws/mcp';
const SERVICE = 'partnercentral-agents-mcp';
const REGION = 'us-east-1';

let requestId = 1000; // different range from non-streaming client to avoid clashes
let credentialProvider = null;

function getCredentialProvider() {
  if (!credentialProvider) credentialProvider = defaultProvider();
  return credentialProvider;
}

async function _signedRequest(body) {
  const credentials = await getCredentialProvider()();
  const signer = new SignatureV4({
    credentials, region: REGION, service: SERVICE, sha256: Sha256,
  });

  const url = new URL(MCP_ENDPOINT);
  const bodyStr = JSON.stringify(body);

  const request = {
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    protocol: 'https:',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      host: url.hostname,
    },
    body: bodyStr,
  };

  const signed = await signer.sign(request);
  return fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: signed.headers,
    body: bodyStr,
  });
}

// Async generator — yields parsed SSE events as they arrive
async function* streamSendMessage({ text, sessionId, catalog }) {
  catalog = catalog || process.env.CATALOG || 'Sandbox';
  const args = {
    catalog,
    content: [{ type: 'text', text }],
    stream: true,
  };
  if (sessionId) args.sessionId = sessionId;

  const body = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: { name: 'sendMessage', arguments: args },
  };

  console.log('[MCP-Stream] request text="' + (text || '').substring(0, 80) + '" sessionId=' + (sessionId || 'NEW'));

  const response = await _signedRequest(body);
  console.log('[MCP-Stream] HTTP status=' + response.status + ' contentType=' + response.headers.get('content-type'));
  if (!response.ok) {
    const errText = await response.text();
    throw new Error('HTTP ' + response.status + ': ' + errText);
  }

  // If server didn't honor stream=true, it will return plain JSON — detect and throw so we fall back
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const bodyText = await response.text();
    console.log('[MCP-Stream] Server returned non-stream response, body=' + bodyText.substring(0, 500));
    throw new Error('Server did not return event-stream, got: ' + ct);
  }

  // Parse SSE stream: lines of "event: X\ndata: Y\n\n"
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline = event boundary
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        console.log('[MCP-Stream] raw frame=' + raw.substring(0, 200));
        const parsed = _parseSseFrame(raw);
        if (parsed) yield parsed;
      }
    }
    // Flush any trailing frame
    if (buffer.trim()) {
      const parsed = _parseSseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

// Parse a single SSE frame into { event, data } where data is JSON-parsed if possible
function _parseSseFrame(raw) {
  const lines = raw.split('\n');
  let eventType = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
    // ignore comments (lines starting with :) and other fields
  }

  if (dataLines.length === 0) return null;

  const dataStr = dataLines.join('\n');
  let data;
  try { data = JSON.parse(dataStr); } catch (_) { data = dataStr; }

  return { event: eventType, data };
}

module.exports = { streamSendMessage };
