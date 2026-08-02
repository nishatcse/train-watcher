const { config } = require("./config");
const { holdSeats } = require("./browser-hold");
const { sendTelegramMessage } = require("./telegram");
const { log } = require("./helpers");

function notify(message) {
  return sendTelegramMessage(config.telegramBotToken, config.telegramChatId, message).catch((error) =>
    log(`Telegram send failed: ${error.message}`)
  );
}

/**
 * Hold seats on a trip by driving the real booking page (Turnstile is mandatory
 * on this account, so the API-only path is not usable). Reused by the watcher
 * (checker.js) and by the `hold-test` CLI.
 */
async function holdSeatsForTrip({
  route,
  seats = config.autoHold.seats,
  repeatCount = config.autoHold.repeatCount,
  refreshSeconds = config.autoHold.refreshSeconds,
}) {
  return holdSeats({
    from: route.from,
    to: route.to,
    date: route.date,
    train: route.train,
    seatClass: route.class,
    seats,
    // With named seats the count is however many were named; else the auto count.
    seatCount: seats.length > 0 ? seats.length : config.autoHold.seatsToHold,
    repeatCount,
    refreshSeconds,
    onEvent: notify,
  });
}

// --- CLI: `npm run hold-test` runs one hold on the HOLD_* target from .env ---
if (require.main === module) {
  const target = config.autoHold.target;
  if (!target) {
    console.error("Set HOLD_FROM / HOLD_TO / HOLD_DATE / HOLD_TRAIN / HOLD_CLASS in .env first.");
    process.exit(1);
  }
  const seatDesc =
    config.autoHold.seats.length > 0
      ? `seats ${config.autoHold.seats.join(", ")}`
      : `${config.autoHold.seatsToHold} auto seat(s)`;
  log(
    `hold-test: ${target.train} (${target.class}) ${target.from}->${target.to} on ${target.date} — ` +
      `${seatDesc}, ${config.autoHold.repeatCount} cycle(s), ${config.autoHold.refreshSeconds}s refresh`
  );
  holdSeatsForTrip({ route: target })
    .then((result) => {
      log(`hold-test finished. Seats touched: ${(result.held || []).join(", ") || "none"}`);
      process.exit(0);
    })
    .catch((error) => {
      log(`hold-test failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { holdSeatsForTrip };
