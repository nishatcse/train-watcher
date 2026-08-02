const { config } = require("./config");
const { sendTelegramMessage } = require("./telegram");

async function main() {
  // The single-route config vars this used to print (trainName / seatClass /
  // journeyDate) no longer exist — routes are a list now.
  const routes = config.routes.map((r) => `${r.train} ${r.class}: ${r.from} -> ${r.to} on ${r.date}`);

  await sendTelegramMessage(
    config.telegramBotToken,
    config.telegramChatId,
    [`Telegram test OK — watching ${routes.length} route(s):`, ...routes].join("\n")
  );

  console.log("Telegram test message sent successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
