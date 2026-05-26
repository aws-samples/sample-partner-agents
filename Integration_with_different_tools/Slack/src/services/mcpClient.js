// src/services/mcpClient.js
// Server-side MCP JSON-RPC 2.0 client with AWS SigV4 signing.
// Ported from the React app's mcpService.js for Node.js.

const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');

const MCP_ENDPOINT = 'https://partnercentral-agents-mcp.us-east-1.api.aws/mcp';
const SERVICE = 'partnercentral-agents-mcp';
const REGION = 'us-east-1';

let requestId = 1;
let credentialProvider = null;

function getCredentialProvider() {
  if (!credentialProvider) {
    credentialProvider = defaultProvider();
  }
  return credentialProvider;
}

async function signedFetch(body) {
  const credentials = await getCredentialProvider()();
  const signer = new SignatureV4({
    credentials,
    region: REGION,
    service: SERVICE,
    sha256: Sha256,
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
      host: url.hostname,
    },
    body: bodyStr,
  };

  const signed = await signer.sign(request);

  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: signed.headers,
    body: bodyStr,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

// Initialize MCP connection — call on startup to verify endpoint
async function initialize() {
  const body = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'slack-partner-central-bot', version: '1.0.0' },
      capabilities: {},
    },
  };
  const result = await signedFetch(body);
  if (result.error) {
    throw new Error(`MCP initialize failed: ${result.error.message}`);
  }
  console.log('[MCP] Connected:', result.result?.serverInfo?.name);
  return result;
}

// Send a message to the Partner Central agent
async function sendMessage({ text, sessionId, catalog, stream = false }) {
  catalog = catalog || process.env.CATALOG || 'Sandbox';
  const params = {
    catalog,
    content: [{ type: 'text', text }],
  };
  if (sessionId) params.sessionId = sessionId;
  if (stream) params.stream = true;

  const body = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: { name: 'sendMessage', arguments: params },
  };
  console.log('[MCP] sendMessage request:', JSON.stringify(body.params.arguments).substring(0, 500));
  const response = await signedFetch(body);
  console.log('[MCP] sendMessage response:', JSON.stringify(response).substring(0, 1500));
  return response;
}

// Send a tool approval response (approve / reject / override)
async function sendApproval({ sessionId, toolUseId, decision, message, catalog }) {
  catalog = catalog || process.env.CATALOG || 'Sandbox';
  const approvalContent = {
    type: 'tool_approval_response',
    toolUseId,
    decision,
  };
  if (message) approvalContent.message = message;

  const body = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: {
      name: 'sendMessage',
      arguments: {
        catalog,
        sessionId,
        content: [approvalContent],
      },
    },
  };
  console.log('[MCP] sendApproval payload:', JSON.stringify(body.params.arguments));
  const response = await signedFetch(body);
  console.log('[MCP] sendApproval response:', JSON.stringify(response).substring(0, 1000));
  return response;
}

// Get session state
async function getSession(sessionId) {
  const body = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: { name: 'getSession', arguments: { sessionId } },
  };
  return signedFetch(body);
}

// Parse the agent response into a usable shape
function parseAgentResponse(rpcResponse) {
  if (rpcResponse.error) {
    return { type: 'error', code: rpcResponse.error.code, message: rpcResponse.error.message };
  }

  const result = rpcResponse.result;
  if (!result) return { type: 'error', message: 'Empty response' };

  const content = result.content || [];

  // First pass: look for structured tool_approval_request content block per MCP docs
  const approvalBlock = content.find(b => b.type === 'tool_approval_request');
  if (approvalBlock) {
    console.log('[MCP] approval block:', JSON.stringify(approvalBlock).substring(0, 500));
    const extracted = extractApprovalFields(approvalBlock);
    const textBlocks = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return {
      type: 'approval_required',
      sessionId: result.sessionId,
      approvalRequest: extracted,
      text: textBlocks,
    };
  }

  // Second pass: the agent may wrap content inside a JSON text block
  for (const block of content) {
    if (block.type !== 'text') continue;
    try {
      const parsed = JSON.parse(block.text);

      if (parsed.status === 'requires_approval') {
        // Approval request may appear as top-level field OR nested inside content array
        let approval = parsed.tool_approval_request;
        if (!approval && Array.isArray(parsed.content)) {
          approval = parsed.content.find(c => c.type === 'tool_approval_request');
        }
        if (approval) {
          console.log('[MCP] approval (nested):', JSON.stringify(approval).substring(0, 500));
          const extracted = extractApprovalFields(approval);
          const textInContent = Array.isArray(parsed.content)
            ? parsed.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : '';
          return {
            type: 'approval_required',
            sessionId: parsed.sessionId,
            approvalRequest: extracted,
            text: textInContent,
          };
        }
      }

      if (parsed.content && Array.isArray(parsed.content)) {
        const assistantTexts = parsed.content
          .filter(c => c.type === 'ASSISTANT_RESPONSE' && c.content?.text)
          .map(c => c.content.text);

        const text = assistantTexts.length > 0
          ? assistantTexts[assistantTexts.length - 1]
          : block.text;

        return { type: 'message', sessionId: parsed.sessionId, text, status: parsed.status };
      }

      if (parsed.sessionId) {
        return { type: 'message', sessionId: parsed.sessionId, text: block.text, status: parsed.status };
      }
    } catch (_) {
      // not JSON — fall through
    }

    if (block.text) {
      return { type: 'message', text: block.text };
    }
  }

  return { type: 'message', text: '(no response)' };
}

// Extracts toolUseId, toolName, parameters from an approval block.
// The MCP server may return fields in different shapes:
//   1. Documented: { toolUseId, toolName, parameters }
//   2. Observed:   { content: { text: "{\"tool_use_id\":..., \"tool_name\":..., \"input\":{...}}" } }
// Snake-case vs camelCase is also normalized here.
function extractApprovalFields(block) {
  if (!block) return { toolUseId: undefined, toolName: undefined, parameters: undefined };

  // Try direct fields first (documented shape)
  let toolUseId = block.toolUseId || block.tool_use_id;
  let toolName = block.toolName || block.tool_name;
  let parameters = block.parameters || block.input || block.arguments;

  // If not present, dig into nested content.text (observed real shape)
  if (!toolUseId && block.content?.text) {
    try {
      const inner = JSON.parse(block.content.text);
      toolUseId = inner.tool_use_id || inner.toolUseId;
      toolName = inner.tool_name || inner.toolName;
      parameters = inner.input || inner.parameters || inner.arguments;
    } catch (e) {
      console.warn('[MCP] Could not parse nested approval content:', e.message);
    }
  }

  return { toolUseId, toolName, parameters };
}

module.exports = { initialize, sendMessage, sendApproval, getSession, parseAgentResponse, extractApprovalFields };