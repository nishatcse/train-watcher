const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid numeric environment variable: ${name}=${raw}`);
  }
  return value;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

const rootDir = path.resolve(__dirname, "..");
const stateDir = path.join(rootDir, "state");
const routesPath = path.join(rootDir, "routes.json");

fs.mkdirSync(stateDir, { recursive: true });

const DEFAULT_TRAIN = "TURNA (742)";
const DEFAULT_CLASS = "S_CHAIR";

function normalizeRoute(entry, source) {
  const from = (entry.from || "").trim();
  const to = (entry.to || "").trim();
  const date = (entry.date || "").trim();
  if (!from || !to || !date) {
    throw new Error(`Invalid route in ${source}: each route needs "from", "to" and "date" (got ${JSON.stringify(entry)})`);
  }
  return {
    from,
    to,
    date,
    train: (entry.train || DEFAULT_TRAIN).trim(),
    class: (entry.class || DEFAULT_CLASS).trim(),
    hold: entry.hold === true,
  };
}

// routes.json (if present) is the source of truth. Otherwise fall back to the
// single-route env vars so an older setup keeps working unchanged.
function loadRoutes() {
  if (fs.existsSync(routesPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(routesPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not parse routes.json: ${error.message}`);
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((entry) => normalizeRoute(entry, "routes.json"));
    }
    throw new Error("routes.json must be a non-empty array of route objects");
  }

  const from = required("FROM_CITY");
  const date = required("JOURNEY_DATE");
  const train = process.env.TRAIN_NAME || DEFAULT_TRAIN;
  const seatClass = process.env.SEAT_CLASS || DEFAULT_CLASS;

  return required("TO_CITIES")
    .split(",")
    .map((city) => city.trim())
    .filter(Boolean)
    .map((to) => normalizeRoute({ from, to, date, train, class: seatClass }, ".env"));
}

const routes = loadRoutes();

const autoHoldEnabled = boolFromEnv("AUTO_HOLD_ENABLED", false);

// The auto-hold target is defined by the HOLD_* env vars (independent of the
// routes.json the watcher polls). All five must be set for a target to exist.
function loadHoldTarget() {
  const from = (process.env.HOLD_FROM || "").trim();
  const to = (process.env.HOLD_TO || "").trim();
  const date = (process.env.HOLD_DATE || "").trim();
  const train = (process.env.HOLD_TRAIN || "").trim();
  const seatClass = (process.env.HOLD_CLASS || "").trim();
  if (!from || !to || !date || !train || !seatClass) {
    return null;
  }
  return { from, to, date, train, class: seatClass, hold: true };
}

const holdTarget = loadHoldTarget();

// When auto-hold is enabled, make sure the watcher actually polls the target so
// availability there triggers a hold. Add it to the routes if it isn't already
// one of them (matched by from/to/date/train/class).
if (autoHoldEnabled && holdTarget) {
  const already = routes.find(
    (r) =>
      r.from === holdTarget.from &&
      r.to === holdTarget.to &&
      r.date === holdTarget.date &&
      r.train === holdTarget.train &&
      r.class === holdTarget.class
  );
  if (already) {
    already.hold = true;
  } else {
    routes.push(holdTarget);
  }
}

// Clamp seats-to-hold to the 1-4 range the railway allows per user.
const seatsToHold = Math.max(1, Math.min(4, Math.round(numberFromEnv("SEATS_TO_HOLD", 2))));

// Specific seat numbers to hold (e.g. "THO-44,THO-43"). When set these override
// the auto-pick; empty means auto-pick. Capped at 4 (railway per-user limit).
const holdSeats = (process.env.HOLD_SEATS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 4);

// The holder account (B) is a SECOND railway account used only by the browser to
// hold seats, so holding never rotates the watcher account's (A) session.
const holder = {
  username: (process.env.HOLDER_USERNAME || "").trim(),
  password: (process.env.HOLDER_PASSWORD || "").trim(),
};

if (autoHoldEnabled && (!holder.username || !holder.password)) {
  throw new Error(
    "AUTO_HOLD_ENABLED=true requires HOLDER_USERNAME and HOLDER_PASSWORD (the second account used to hold seats)."
  );
}

const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),
  routes,
  pollIntervalSeconds: numberFromEnv("POLL_INTERVAL_SECONDS", 15),
  browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
  railwayUsername: required("RAILWAY_USERNAME"),
  railwayPassword: required("RAILWAY_PASSWORD"),
  holder,
  stateFilePath: path.join(stateDir, "availability-state.json"),
  autoHold: {
    enabled: autoHoldEnabled,
    target: holdTarget,
    seats: holdSeats,
    seatsToHold,
    repeatCount: Math.max(1, Math.round(numberFromEnv("HOLD_REPEAT_COUNT", 1))),
    refreshSeconds: numberFromEnv("HOLD_REFRESH_SECONDS", 180),
  },
};

module.exports = { config, rootDir, stateDir };
