async function sendTelegramMessage(botToken, chatId, message) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

module.exports = { sendTelegramMessage };
