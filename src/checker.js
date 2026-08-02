const fs = require("fs");
const { config } = require("./config");
const { searchTrips } = require("./api-client");
const { holdSeatsForTrip } = require("./seat-holder");
const { sendTelegramMessage } = require("./telegram");
const { sleep, log } = require("./helpers");

// Guards against launching a second hold while one is already running (a user
// can hold at most 4 seats at a time).
let holdInProgress = false;
// After a hold ends (success or failure) wait this long before triggering another,
// so a failing hold can't hammer the (weak) Pi with back-to-back browser launches.
const HOLD_COOLDOWN_MS = (Number(process.env.HOLD_COOLDOWN_SECONDS) || 30) * 1000;
let holdCooldownUntil = 0;

function buildSearchUrl(route) {
  const params = new URLSearchParams({
    fromcity: route.from,
    tocity: route.to,
    doj: route.date,
    class: route.class,
  });

  return `https://eticket.railway.gov.bd/booking/train/search?${params.toString()}`;
}

function routeStateKey(route) {
  return `${route.date}__${route.from}__${route.to}__${route.train}__${route.class}`;
}

function loadState() {
  if (!fs.existsSync(config.stateFilePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(config.stateFilePath, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(config.stateFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function extractAvailability(trains, route) {
  const wantedTrain = route.train.trim().toLowerCase();
  const train = trains.find((entry) => (entry.trip_number || "").trim().toLowerCase() === wantedTrain);

  if (!train) {
    log(`${route.train} is not listed in the API results for ${route.from} -> ${route.to} on ${route.date}; treating as 0 available`);
    return { availableCount: 0, onlineCount: 0, offlineCount: 0, fare: null };
  }

  const seatType = (train.seat_types || []).find((entry) => entry.type === route.class);
  if (!seatType) {
    log(`${route.class} is not offered on ${route.train} for ${route.from} -> ${route.to} on ${route.date}; treating as 0 available`);
    return { availableCount: 0, onlineCount: 0, offlineCount: 0, fare: null };
  }

  const online = Number(seatType.seat_counts && seatType.seat_counts.online) || 0;
  const offline = Number(seatType.seat_counts && seatType.seat_counts.offline) || 0;

  return {
    availableCount: online + offline,
    onlineCount: online,
    offlineCount: offline,
    fare: seatType.fare || null,
  };
}

function shouldNotify(previous, current) {
  if (current.availableCount <= 0) {
    return false;
  }

  if (!previous) {
    return true;
  }

  return previous.availableCount !== current.availableCount;
}

function formatNotification(route, result) {
  const lines = [
    "Train ticket available!",
    `Train: ${route.train}`,
    `Class: ${route.class}`,
    `Route: ${route.from} -> ${route.to}`,
    `Date: ${route.date}`,
    `Available: ${result.availableCount} (online ${result.onlineCount} + counter ${result.offlineCount})`,
  ];

  if (result.fare) {
    lines.push(`Fare: ${result.fare} BDT`);
  }

  lines.push(`Link: ${buildSearchUrl(route)}`);
  return lines.join("\n");
}

function isHoldInProgress() {
  return holdInProgress;
}

// Launches the browser-based hold WITHOUT blocking the watcher loop, so other
// routes keep being polled while seats are held.
function maybeAutoHold(route, result) {
  if (!config.autoHold.enabled || !route.hold || result.availableCount <= 0) {
    return;
  }
  if (holdInProgress) {
    log("Auto-hold skipped: a hold is already in progress");
    return;
  }
  if (Date.now() < holdCooldownUntil) {
    return; // still cooling down from the previous hold attempt
  }

  holdInProgress = true;
  log(`Auto-hold triggered for ${route.train} ${route.from} -> ${route.to} (${result.availableCount} available)`);
  holdSeatsForTrip({ route })
    .catch((error) => log(`Auto-hold ended with error: ${error.message}`))
    .finally(() => {
      holdInProgress = false;
      holdCooldownUntil = Date.now() + HOLD_COOLDOWN_MS;
    });
}

async function checkRoute(route, state) {
  log(`Checking ${route.train} ${route.class} for ${route.from} -> ${route.to} on ${route.date}`);

  const trains = await searchTrips(route);
  const availability = extractAvailability(trains, route);
  const result = { route, ...availability };

  const stateKey = routeStateKey(route);
  const previous = state[stateKey];

  log(`Result for ${route.from} -> ${route.to} on ${route.date}: ${result.availableCount} seat(s) available`);

  if (shouldNotify(previous, result)) {
    await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, formatNotification(route, result));
    log(`Telegram notification sent for ${route.from} -> ${route.to} on ${route.date}`);
  }

  maybeAutoHold(route, result);

  state[stateKey] = {
    availableCount: result.availableCount,
    checkedAt: new Date().toISOString(),
    url: buildSearchUrl(route),
  };

  saveState(state);
  return result;
}

async function runChecksOnce() {
  const state = loadState();
  const results = [];

  for (const [index, route] of config.routes.entries()) {
    const result = await checkRoute(route, state);
    results.push(result);

    if (index < config.routes.length - 1) {
      await sleep(1000);
    }
  }

  return results;
}

module.exports = {
  buildSearchUrl,
  checkRoute,
  loadState,
  saveState,
  runChecksOnce,
  isHoldInProgress,
};
