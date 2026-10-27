const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWorld, sessionBlob, dayOffset, trainsWith } = require("./helpers/fixtures");

const DAY = dayOffset(3);
const mk = (over = {}) => ({ fromCity: "Dhaka", toCity: "Sylhet", journeyDate: DAY, trainName: "UPABAN EXPRESS (739)", seatClass: "S_CHAIR", ...over });

async function ready(world) {
  await world.pairDevice();
  await world.sessions.save(sessionBlob(Date.now() + 10 * 3600 * 1000));
}

test("watchers that share route/date/class cost ONE request per cycle", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  await w.watchers.create(mk({ trainName: "PARABAT EXPRESS (709)" }));
  await w.watchers.create(mk({ toCity: "Chattogram" }));
  w.script.trains = [];
  await w.scheduler.runCycle();
  assert.equal(w.calls.length, 2, "3 watchers, 2 unique searches");
});

test("alert fires on both channels once; unchanged result does not repeat; change and restart behave", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());

  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 0, 0);
  await w.scheduler.runCycle();
  assert.equal(w.sent.fcm.length + w.sent.telegram.length, 0, "no seats, no alert");

  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 3, 12);
  await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.sent.telegram.length, 1);
  assert.equal(w.sent.fcm.length, 1);
  assert.equal(w.sent.fcm[0].data.seats, 15, "the total is online + counter");
  assert.match(w.sent.telegram[0], /eticket\.railway\.gov\.bd/);
  assert.match(w.sent.telegram[0], /Available seats: 15\b/);
  assert.doesNotMatch(w.sent.telegram[0], /online|counter/i);

  await w.scheduler.runCycle(); // unchanged
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.sent.telegram.length, 1, "no duplicate for unchanged count");

  // A brand-new scheduler on the same database == a backend restart: state survives.
  const { createScheduler } = require("../src/scheduler");
  const restarted = createScheduler({ db: w.db, shohoz: w.shohoz, sessions: w.sessions, notifier: w.notifier, watchers: w.watchers, getSettings: w.getSettingsFn, getSearchDayLimit: async () => null, sleepFn: async () => {} });
  await restarted.runCycle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.sent.telegram.length, 1, "no duplicate after restart");

  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 0);
  await w.scheduler.runCycle(); // sells out
  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 2);
  await w.scheduler.runCycle(); // comes back
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.sent.telegram.length, 2, "sold out then back is a new alert");
});

test("one channel failing does not stop the other; failures are retried then recorded", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  w.behaviour.telegramFailures = 99; // telegram is down for good
  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 4);
  await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.sent.fcm.length, 1, "push still delivered");
  const rows = (await w.db.query("select channel, delivery_status, attempts from notifications_log order by channel")).rows;
  assert.deepEqual(rows.map((r) => [r.channel, r.delivery_status, r.attempts]), [["fcm", "sent", 1], ["telegram", "failed", 3]]);
});

test("telegram recovers on a retry", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  w.behaviour.telegramFailures = 2;
  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 4);
  await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 30));
  const t = (await w.db.query("select delivery_status, attempts from notifications_log where channel='telegram'")).rows[0];
  assert.deepEqual([t.delivery_status, t.attempts], ["sent", 3]);
});

test("a dead push token is cleared instead of retried forever", async () => {
  const w = await createWorld();
  await ready(w);
  w.behaviour.fcmError = Object.assign(new Error("gone"), { unregistered: true });
  const out = await w.notifier.dispatch({ kind: "test", title: "t", body: "b", only: ["fcm"], force: true });
  await out.done;
  const token = (await w.db.query("select fcm_token from devices")).rows[0].fcm_token;
  assert.equal(token, null);
});

test("an error on one target does not stop the others", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  await w.watchers.create(mk({ toCity: "Chattogram", trainName: "TURNA (741)" }));
  w.script.trains = (target) => {
    if (target.toCity === "Sylhet") throw new Error("boom");
    return trainsWith("TURNA (741)", "S_CHAIR", 5);
  };
  const out = await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out.failed, 1);
  assert.equal(w.sent.telegram.length, 1);
  const bad = (await w.db.query("select last_check_status, last_error from watchers where to_city='Sylhet'")).rows[0];
  assert.equal(bad.last_check_status, "error");
});

test("a train missing from the search is reported, not treated as sold out", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  w.script.trains = trainsWith("SOMETHING ELSE (1)", "S_CHAIR", 9);
  await w.scheduler.runCycle();
  const row = (await w.db.query("select last_check_status from watchers")).rows[0];
  assert.equal(row.last_check_status, "train_not_listed");
});

test("without a session nothing is scanned and the owner is told once", async () => {
  const w = await createWorld();
  await w.pairDevice();
  await w.watchers.create(mk());
  const r1 = await w.scheduler.runCycle();
  await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(r1.skipped, "no_session");
  assert.equal(w.calls.length, 0);
  assert.equal(w.sent.telegram.length, 1, "login-required alert is not repeated every cycle");
  assert.match(w.sent.telegram[0], /login required/i);
});

test("past journeys are switched off automatically", async () => {
  const w = await createWorld();
  await ready(w);
  await w.db.query("insert into watchers (from_city,to_city,journey_date,train_name,seat_class) values ('A','B',$1,'T','S_CHAIR')", [dayOffset(-2)]);
  await w.scheduler.runCycle();
  const row = (await w.db.query("select enabled, last_check_status from watchers")).rows[0];
  assert.deepEqual([row.enabled, row.last_check_status], [false, "journey_passed"]);
});

test("watcher validation: duplicates, past dates, same station", async () => {
  const w = await createWorld();
  await w.watchers.create(mk());
  await assert.rejects(() => w.watchers.create(mk()), /already watching/);
  await assert.rejects(() => w.watchers.create(mk({ journeyDate: dayOffset(-1) })), /past/);
  await assert.rejects(() => w.watchers.create(mk({ toCity: "Dhaka" })), /different/);
  await assert.rejects(() => w.watchers.create(mk({ trainName: "" })), /trainName/);
  await assert.rejects(() => w.watchers.create(mk({ journeyDate: "31-Oct-2026" })), /YYYY-MM-DD/);
});

test("editing a journey resets what the last observation said", async () => {
  const w = await createWorld();
  await ready(w);
  const { watcher } = await w.watchers.create(mk());
  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 3);
  await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 20));
  await w.watchers.update(watcher.id, { seatClass: "SNIGDHA" });
  assert.equal((await w.db.query("select count(*)::int n from availability_state")).rows[0].n, 0);
});

test("seats that exist only in the counter quota still count as available", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 0, 5);
  await w.scheduler.runCycle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.sent.telegram.length, 1);
  assert.match(w.sent.telegram[0], /Available seats: 5\b/);
  const [row] = await w.watchers.list();
  assert.equal(row.availableSeats, 5);
});

test("alerts follow the total: an unchanged total stays quiet even if the split moved", async () => {
  const w = await createWorld();
  await ready(w);
  await w.watchers.create(mk());
  const sent = () => w.sent.telegram.length;
  const run = async (online, offline) => {
    w.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", online, offline);
    await w.scheduler.runCycle();
    await new Promise((r) => setTimeout(r, 15));
  };
  await run(2, 3);          // total 5 -> first sighting
  assert.equal(sent(), 1);
  await run(2, 3);          // same
  assert.equal(sent(), 1);
  await run(4, 1);          // parts moved but the total is still 5: nothing new to say
  assert.equal(sent(), 1);
  await run(4, 3);          // total 7
  assert.equal(sent(), 2);
});
