// src/services/secretsLoader.js
// Loads Slack credentials from Secrets Manager on Lambda cold start,
// falls back to environment variables for local dev.

let cachedSecrets = null;

async function loadSlackSecrets() {
  if (cachedSecrets) return cachedSecrets;

  const secretName = process.env.SLACK_SECRET_NAME;

  // Local dev / unset — use env vars directly
  if (!secretName) {
    cachedSecrets = {
      botToken: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      appToken: process.env.SLACK_APP_TOKEN, // for Socket Mode
    };
    return cachedSecrets;
  }

  // Pull from Secrets Manager
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  const parsed = JSON.parse(res.SecretString);

  cachedSecrets = {
    botToken: parsed.SLACK_BOT_TOKEN || parsed.botToken,
    signingSecret: parsed.SLACK_SIGNING_SECRET || parsed.signingSecret,
    appToken: parsed.SLACK_APP_TOKEN || parsed.appToken,
  };

  if (!cachedSecrets.botToken || !cachedSecrets.signingSecret) {
    throw new Error('Secret ' + secretName + ' is missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
  }

  console.log('[Secrets] Loaded Slack credentials from ' + secretName);
  return cachedSecrets;
}

module.exports = { loadSlackSecrets };
