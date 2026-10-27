async function sendTelegramMessage(botToken, chatId, text, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    // Report Telegram's own description only; never echo the request URL (it holds the bot token).
    throw new Error(`Telegram send failed (HTTP ${response.status}): ${payload.description || "unknown error"}`);
  }
  return payload;
}

module.exports = { sendTelegramMessage };
