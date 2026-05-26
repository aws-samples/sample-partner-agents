// lambda.js — AWS Lambda entry point.
// Two modes:
//   1. HTTP event from API Gateway → ack Slack quickly, self-invoke for heavy work
//   2. Direct invoke with { action: "process" } → run the MCP call and post to Slack

const { App, AwsLambdaReceiver } = require('@slack/bolt');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const mcpClient = require('./src/services/mcpClient');
const { createSessionStore } = require('./src/services/sessionStore');
const { RateLimiter } = require('./src/middleware/rateLimiter');
const { registerEventHandlers } = require('./src/handlers/events');
const { registerCommandHandlers } = require('./src/handlers/commands');
const { registerActionHandlers } = require('./src/handlers/actions');
const { loadSlackSecrets } = require('./src/services/secretsLoader');
const { processJob } = require('./src/services/jobProcessor');

let bootstrapped = null;
const lambdaClient = new LambdaClient({});

function _catalogGuard() {
  const catalog = process.env.CATALOG || 'Sandbox';
  if (catalog === 'AWS' && process.env.ACKNOWLEDGE_PRODUCTION !== 'true') {
    throw new Error(
      'REFUSING TO START: CATALOG=AWS requires ACKNOWLEDGE_PRODUCTION=true env var.'
    );
  }
  if (catalog === 'AWS') {
    console.warn('[WARNING] CATALOG=AWS — all operations will affect live production data');
  }
}

async function bootstrap() {
  if (bootstrapped) return bootstrapped;

  _catalogGuard();
  const secrets = await loadSlackSecrets();

  const receiver = new AwsLambdaReceiver({ signingSecret: secrets.signingSecret });
  const app = new App({ token: secrets.botToken, receiver });

  const sessionStore = createSessionStore();
  const rateLimiter = new RateLimiter();

  // Handler context shared across handlers so they can enqueue async jobs
  const jobDispatcher = (job) => _dispatchJob(job);

  registerEventHandlers(app, sessionStore, rateLimiter, jobDispatcher);
  registerCommandHandlers(app, sessionStore, rateLimiter, jobDispatcher);
  registerActionHandlers(app, sessionStore, rateLimiter, jobDispatcher);

  try {
    await mcpClient.initialize();
  } catch (err) {
    console.error('[Lambda] MCP init failed:', err.message);
  }

  bootstrapped = { receiver, sessionStore, rateLimiter, botToken: secrets.botToken };
  return bootstrapped;
}

// Self-invoke this Lambda asynchronously with the job payload
async function _dispatchJob(job) {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    // Running locally — just process inline
    console.log('[Lambda] No function name set, processing job inline');
    const { sessionStore, rateLimiter, botToken } = await bootstrap();
    return processJob(job, { sessionStore, rateLimiter, botToken });
  }
  await lambdaClient.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event', // async, returns immediately
    Payload: JSON.stringify({ action: 'process', job }),
  }));
}

module.exports.handler = async (event, context, callback) => {
  // Direct async invocation for background work
  if (event && event.action === 'process' && event.job) {
    const { sessionStore, rateLimiter, botToken } = await bootstrap();
    try {
      await processJob(event.job, { sessionStore, rateLimiter, botToken });
    } catch (err) {
      console.error('[Lambda] Job processing error:', err);
    }
    return { statusCode: 200 };
  }

  // Slack HTTP event from API Gateway
  const { receiver } = await bootstrap();
  const handler = await receiver.start();
  return handler(event, context, callback);
};
