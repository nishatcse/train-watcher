const { loadConfig } = require("./config");
const { createPgDb } = require("./db/pool");
const { migrate } = require("./db/migrate");
const { log } = require("./lib/log");
const { createFcm } = require("./services/fcm");
const { sendTelegramMessage } = require("./services/telegram");
const { createNotifier } = require("./services/notifier");
const { createSessions } = require("./services/sessions");
const { createWatchers } = require("./services/watchers");
const { createScheduler } = require("./scheduler");
const { createShohozClient } = require("./lib/shohoz");
const { getSettings } = require("./services/settings");
const { createApp } = require("./app");

async function main() {
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl);
  await migrate(db, log);

  const telegram = config.telegram ? { send: (text) => sendTelegramMessage(config.telegram.botToken, config.telegram.chatId, text) } : null;
  const fcm = createFcm({ serviceAccount: config.serviceAccount });
  const settings = () => getSettings(db);

  const notifier = createNotifier({ db, fcm, telegram, getSettings: settings, log });
  const sessions = createSessions({ db, keyB64: config.sessionKey, notifier, log });
  const shohoz = createShohozClient({ getSession: () => sessions.get(), log });
  sessions.attach({ refreshToken: (s) => shohoz.refreshToken(s) });

  const getCatalog = async () => {
    const c = (await db.query("select cities, trains, classes, search_day_limit from catalog_cache where id = 1")).rows[0];
    return c.cities.length ? { cities: c.cities, trains: c.trains, classes: c.classes, searchDayLimit: c.search_day_limit } : null;
  };
  const getSearchDayLimit = async () => (await db.query("select search_day_limit from catalog_cache where id = 1")).rows[0].search_day_limit;

  const watchers = createWatchers({ db, getCatalog });
  const scheduler = createScheduler({
    db, shohoz, sessions, notifier, watchers, getSettings: settings, getSearchDayLimit, log,
    directAlert: telegram ? (text) => telegram.send(text) : null,
  });

  const channels = { telegram: Boolean(telegram), fcm: Boolean(fcm) };
  const app = createApp({ db, sessions, watchers, notifier, scheduler, shohoz, config, channels, log });

  const server = app.listen(config.port, () => log(`listening on :${config.port} (telegram ${channels.telegram ? "on" : "off"}, push ${channels.fcm ? "on" : "off"})`));

  const resumed = await notifier.resumePending();
  if (resumed) log(`resuming ${resumed} pending notification(s)`);
  scheduler.start();

  // Railway sends SIGTERM on every deploy: finish the cycle in flight, then exit cleanly.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, shutting down`);
    server.close();
    await scheduler.stop().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason && reason.message ? reason.message : reason}`));

main().catch((error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});
