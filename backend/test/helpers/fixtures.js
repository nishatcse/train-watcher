const { createTestDb } = require("./testdb");
const { createNotifier } = require("../../src/services/notifier");
const { createSessions } = require("../../src/services/sessions");
const { createWatchers } = require("../../src/services/watchers");
const { createScheduler } = require("../../src/scheduler");
const { getSettings } = require("../../src/services/settings");
const { todayDhaka } = require("../../src/lib/dates");

const KEY = Buffer.alloc(32, 9).toString("base64");

function makeJwt(expMs) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: Math.floor(expMs / 1000) })}.sig`;
}

const sessionBlob = (expMs, extra = {}) => ({ token: makeJwt(expMs), ssdk: "ssdk", uudid: "uudid", user: "u", ...extra });

function dayOffset(n) {
  const [y, m, d] = todayDhaka().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const trainsWith = (name, cls, online, offline = 0) => [{ trip_number: name, seat_types: [{ type: cls, seat_counts: { online, offline }, fare: 100, vat_amount: 0 }] }];

/** A complete backend wired to PGlite with recording fake channels. */
async function createWorld({ now = Date.now, backoffsMs = [0, 0, 0] } = {}) {
  const db = await createTestDb();
  const sent = { telegram: [], fcm: [] };
  const behaviour = { telegramFailures: 0, fcmError: null };

  const telegram = {
    send: async (text) => {
      if (behaviour.telegramFailures > 0) {
        behaviour.telegramFailures -= 1;
        throw new Error("telegram down");
      }
      sent.telegram.push(text);
    },
  };
  const fcm = {
    send: async (token, data) => {
      if (behaviour.fcmError) throw behaviour.fcmError;
      sent.fcm.push({ token, data });
    },
  };

  const getSettingsFn = () => getSettings(db);
  const notifier = createNotifier({ db, fcm, telegram, getSettings: getSettingsFn, backoffsMs, sleepFn: async () => {} });
  const sessions = createSessions({ db, keyB64: KEY, notifier, now });
  const watchers = createWatchers({ db, getCatalog: async () => null });

  const calls = [];
  const script = { trains: [], error: null };
  const shohoz = {
    state: { pausedUntil: 0 },
    searchTrips: async (target) => {
      calls.push(target);
      if (script.error) throw script.error;
      return typeof script.trains === "function" ? script.trains(target) : script.trains;
    },
    refreshToken: async () => null,
  };
  sessions.attach({ refreshToken: (s) => shohoz.refreshToken(s) });

  const scheduler = createScheduler({
    db, shohoz, sessions, notifier, watchers, getSettings: getSettingsFn, getSearchDayLimit: async () => null, sleepFn: async () => {},
  });

  const pairDevice = async (fcmToken = "fcm-token-1") => {
    await db.query("insert into devices (name, device_token_hash, fcm_token) values ('t', $1, $2)", [`hash-${Math.random()}`, fcmToken]);
  };

  return { db, sent, behaviour, notifier, sessions, watchers, scheduler, shohoz, calls, script, pairDevice, getSettingsFn };
}

module.exports = { createWorld, makeJwt, sessionBlob, dayOffset, trainsWith, KEY };
