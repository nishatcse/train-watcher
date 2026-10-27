function parseServiceAccount(env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
    : env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.project_id || !parsed.private_key || !parsed.client_email) throw new Error("missing project_id / private_key / client_email");
    return parsed;
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is not a valid service-account JSON: ${error.message}`);
  }
}

function loadConfig(env = process.env) {
  const need = (name) => {
    if (!env[name]) throw new Error(`Missing required environment variable: ${name}`);
    return env[name];
  };
  const adminToken = need("ADMIN_TOKEN");
  if (adminToken.length < 24) throw new Error("ADMIN_TOKEN must be at least 24 characters");

  const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : null;

  return {
    port: Number(env.PORT) || 3000,
    databaseUrl: need("DATABASE_URL"),
    adminToken,
    sessionKey: need("SESSION_ENCRYPTION_KEY"),
    telegram,
    serviceAccount: parseServiceAccount(env),
  };
}

module.exports = { loadConfig, parseServiceAccount };
