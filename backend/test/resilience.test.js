const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createScheduler } = require("../src/scheduler");

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function brokenDbScheduler(directAlert) {
  const db = { query: async () => { throw new Error("connection refused"); }, tx: async () => { throw new Error("connection refused"); } };
  return createScheduler({
    db,
    shohoz: { state: { pausedUntil: 0 }, searchTrips: async () => [] },
    sessions: { ensureUsable: async () => ({ usable: true }), handleRejected: async () => {} },
    notifier: { dispatch: async () => ({}) },
    watchers: { listEnabled: async () => [] },
    getSettings: async () => { throw new Error("connection refused"); },
    getSearchDayLimit: async () => null,
    directAlert,
    sleepFn: async () => tick(5),
  });
}

test("database down: the loop survives and Telegram is told once, straight from env credentials", async () => {
  const messages = [];
  const scheduler = brokenDbScheduler(async (text) => { messages.push(text); });
  scheduler.start();
  await tick(120); // many failed cycles
  await scheduler.stop();
  assert.equal(messages.length, 1, "throttled: one alert, not one per cycle");
  assert.match(messages[0], /database is unreachable/i);
});

test("database down with no Telegram configured does not crash the loop", async () => {
  const scheduler = brokenDbScheduler(null);
  scheduler.start();
  await tick(60);
  await scheduler.stop(); // resolves => the loop never threw
});

test("a failing direct alert is swallowed, not fatal", async () => {
  const scheduler = brokenDbScheduler(async () => { throw new Error("telegram down too"); });
  scheduler.start();
  await tick(60);
  await scheduler.stop();
});
