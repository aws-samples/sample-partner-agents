// src/utils/errors.js
// Maps MCP error codes to Slack-friendly messages and retry strategies.

const ERROR_MAP = {
  '-32001': {
    label: 'Authentication failed',
    message: 'Authentication failed. AWS credentials may have expired. Please contact your admin.',
    retry: false,
  },
  '-31004': {
    label: 'Permission denied',
    message: 'Permission denied. Missing IAM action required for this operation.',
    retry: false,
  },
  '-32002': {
    label: 'Access denied',
    message: 'Access denied. Check Partner Central enrollment and region configuration.',
    retry: false,
  },
  '-32004': {
    label: 'Rate limited',
    message: 'Rate limited, retrying...',
    retry: true,
    maxRetries: 5,
    baseDelayMs: 1000,
  },
  '-30001': {
    label: 'Not found',
    message: 'Resource not found. Please check the ID and try again.',
    retry: false,
  },
  '-32600': {
    label: 'Invalid request',
    message: 'Invalid request. Check your query syntax.',
    retry: false,
  },
  '-32603': {
    label: 'Server error',
    message: 'Server error. Retrying...',
    retry: true,
    maxRetries: 3,
    baseDelayMs: 1000,
  },
};

function getErrorInfo(code) {
  return ERROR_MAP[String(code)] || {
    label: 'Error',
    message: `Unknown error (code: ${code}). Check the bot logs for details.`,
    retry: false,
  };
}

function formatSlackError(code, detail) {
  const info = getErrorInfo(code);
  let text = `*${info.label}* — ${info.message}`;
  if (detail) text += `\n> ${detail}`;
  return text;
}

// Exponential backoff with jitter
function backoffDelay(attempt, baseMs = 1000) {
  const exp = Math.pow(2, attempt) * baseMs;
  const jitter = Math.random() * baseMs;
  return exp + jitter;
}

module.exports = { getErrorInfo, formatSlackError, backoffDelay };
