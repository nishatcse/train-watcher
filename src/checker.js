const fs = require("fs");
const { config } = require("./config");
const { searchTrips } = require("./api-client");
const { expandRoutes } = require("./scanner");
const { sendTelegramMessage } = require("./telegram");
const { sleep, log } = require("./helpers");

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

const NOTHING_AVAILABLE = { availableCount: 0, onlineCount: 0, offlineCount: 0, fare: null, vat: 0, totalFare: null };

function extractAvailability(trains, route) {
  const wantedTrain = route.train.trim().toLowerCase();
  const train = trains.find((entry) => (entry.trip_number || "").trim().toLowerCase() === wantedTrain);

  if (!train) {
    log(`${route.train} is not listed in the API results for ${route.from} -> ${route.to} on ${route.date}; treating as 0 available`);
    return { ...NOTHING_AVAILABLE };
  }

  const seatType = (train.seat_types || []).find((entry) => entry.type === route.class);
  if (!seatType) {
    log(`${route.class} is not offered on ${route.train} for ${route.from} -> ${route.to} on ${route.date}; treating as 0 available`);
    return { ...NOTHING_AVAILABLE };
  }

  // `seat_counts` carries `is_divided: true` — Bangladesh Railway splits each
  // class into an online quota and a counter quota. Only the online half can be
  // bought from this site, so adding the two (as this used to) roughly doubled
  // every alert and could even fire when zero seats were actually buyable.
  const online = Number(seatType.seat_counts && seatType.seat_counts.online) || 0;
  const offline = Number(seatType.seat_counts && seatType.seat_counts.offline) || 0;

  const fare = Number(seatType.fare) || 0;
  const vat = Number(seatType.vat_amount) || 0;

  return {
    availableCount: online,
    onlineCount: online,
    offlineCount: offline,
    fare: fare || null,
    vat,
    totalFare: fare ? fare + vat : null,
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
    `Online: ${result.onlineCount} seat(s) buyable now (counter quota: ${result.offlineCount})`,
  ];

  if (result.totalFare) {
    // Only spell out the split when VAT actually applies — S_CHAIR is 0%.
    lines.push(
      result.vat > 0
        ? `Fare: ${result.totalFare} BDT (${result.fare} + ${result.vat} VAT)`
        : `Fare: ${result.totalFare} BDT`
    );
  }

  lines.push(`Link: ${buildSearchUrl(route)}`);
  return lines.join("\n");
}

async function checkRoute(route, state) {
  log(`Checking ${route.train} ${route.class} for ${route.from} -> ${route.to} on ${route.date}`);

  const trains = await searchTrips(route);
  const availability = extractAvailability(trains, route);
  const result = { route, ...availability };

  const stateKey = routeStateKey(route);
  const previous = state[stateKey];

  log(
    `Result for ${route.from} -> ${route.to} on ${route.date}: ${result.onlineCount} online, ${result.offlineCount} counter`
  );

  if (shouldNotify(previous, result)) {
    await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, formatNotification(route, result));
    log(`Telegram notification sent for ${route.from} -> ${route.to} on ${route.date}`);
  }

  // The caller persists once per cycle: a full-train scan runs 36 of these in
  // parallel, and saving inside each one would mean 36 synchronous writes per
  // tick — pointless SD-card wear on a Pi.
  state[stateKey] = {
    availableCount: result.availableCount,
    checkedAt: new Date().toISOString(),
    url: buildSearchUrl(route),
  };

  return result;
}

async function runChecksOnce() {
  const state = loadState();
  const routes = await expandRoutes(config.routes);
  const results = [];

  for (const [index, route] of routes.entries()) {
    results.push(await checkRoute(route, state));

    if (index < routes.length - 1) {
      await sleep(1000);
    }
  }

  saveState(state);
  return results;
}

module.exports = {
  buildSearchUrl,
  checkRoute,
  loadState,
  saveState,
  runChecksOnce,
};
