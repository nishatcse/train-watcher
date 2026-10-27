// Credentials must never reach the logs: strip anything that looks like a JWT or a
// Telegram bot token before a line is printed, however the message was built.
function redact(text) {
  return String(text)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[jwt]")
    .replace(/bot\d+:[\w-]{20,}/g, "bot[redacted]")
    .replace(/Bearer\s+[\w.~+/-]+=*/gi, "Bearer [redacted]");
}

const log = (message) => console.log(`[${new Date().toISOString()}] ${redact(message)}`);

module.exports = { log, redact };
