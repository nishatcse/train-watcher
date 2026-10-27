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
    // When true the watcher asks /train-routes for every stoppage and polls all
    // forward station pairs, not just from->to. from/to still matter: they are
    // the fallback if the stoppage lookup fails.
    scanAllPairs: entry.scanAllPairs === true,
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

const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),
  routes,
  pollIntervalSeconds: numberFromEnv("POLL_INTERVAL_SECONDS", 15),
  // Every scan request carries the same device identity, so the server sees one
  // device firing N requests at once. The real limit is unknown — start low and
  // raise it only after watching the logs for 429s.
  scan: {
    concurrency: Math.max(1, Math.min(10, Math.round(numberFromEnv("SCAN_CONCURRENCY", 2)))),
    jitterMs: numberFromEnv("SCAN_JITTER_MS", 120),
  },
  browserExecutablePath: process.env.BROWSER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
  railwayUsername: required("RAILWAY_USERNAME"),
  railwayPassword: required("RAILWAY_PASSWORD"),
  stateFilePath: path.join(stateDir, "availability-state.json"),
};

module.exports = { config, rootDir, stateDir };
