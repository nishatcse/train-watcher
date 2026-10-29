const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createHolds } = require("../src/services/holds");
const { createWorld, dayOffset, KEY } = require("./helpers/fixtures");
const { sha256 } = require("../src/lib/crypto");

let world, server, base;
const TOKEN = "device-token-for-holds-tests";
const ADMIN = "a".repeat(32);

const call = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const good = () => ({
  fromCity: "Chattogram", toCity: "Dhaka", journeyDate: dayOffset(5), trainName: "TURNA EXPRESS (741)",
  seatClass: "S_CHAIR", bogieName: "KA", seatNumbers: "KA-1, ka-2", holdSeconds: 375,
  stopAt: new Date(Date.now() + 3600e3).toISOString(),
});

before(async () => {
  world = await createWorld();
  await world.db.query("insert into devices (name, device_token_hash) values ('t', $1)", [sha256(TOKEN)]);
  const holds = createHolds({ db: world.db });
  const app = createApp({ db: world.db, sessions: world.sessions, watchers: world.watchers, holds, notifier: world.notifier, scheduler: world.scheduler, shohoz: world.shohoz, config: { adminToken: ADMIN, sessionKey: KEY }, channels: {}, log: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await world.db.close(); });

test("a hold is created queued, with normalised seats and a first event", async () => {
  const r = await call("/v1/holds", { method: "POST", body: good() });
  assert.equal(r.status, 201);
  assert.equal(r.body.hold.status, "queued");
  assert.equal(r.body.hold.seatNumbers, "KA-1,KA-2");
  assert.equal(r.body.hold.seatCount, 2);
  assert.equal(r.body.hold.active, true);
  assert.match(r.body.events[0].message, /Queued/);
});

test("only one hold can be active at a time", async () => {
  const r = await call("/v1/holds", { method: "POST", body: good() });
  assert.equal(r.status, 409);
});

test("current returns the active hold", async () => {
  const r = await call("/v1/holds/current");
  assert.equal(r.status, 200);
  assert.equal(r.body.hold.trainName, "TURNA EXPRESS (741)");
});

test("stopping a queued hold cancels it, and a new one can start", async () => {
  const cur = (await call("/v1/holds/current")).body.hold;
  const r = await call(`/v1/holds/${cur.id}`, { method: "DELETE" });
  assert.equal(r.body.hold.status, "stopped");
  assert.equal(r.body.hold.active, false);
  assert.equal((await call("/v1/holds", { method: "POST", body: good() })).status, 201);
});

test("stopping a running hold asks the worker to release the seats", async () => {
  const cur = (await call("/v1/holds/current")).body.hold;
  await world.db.query("update holds set status='running' where id=$1", [cur.id]);
  const r = await call(`/v1/holds/${cur.id}`, { method: "DELETE" });
  assert.equal(r.body.hold.status, "stopping");
  await world.db.query("update holds set status='stopped' where id=$1", [cur.id]);
});

test("a hold shorter than 60 s is refused (the site blocks the account for an hour)", async () => {
  const r = await call("/v1/holds", { method: "POST", body: { ...good(), holdSeconds: 25 } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.details.field, "holdSeconds");
});

test("input is validated: seats, count, date, end time", async () => {
  const bad = async (patch, field) => {
    const r = await call("/v1/holds", { method: "POST", body: { ...good(), ...patch } });
    assert.equal(r.status, 422, JSON.stringify(patch));
    assert.equal(r.body.error.details.field, field);
  };
  await bad({ seatNumbers: "KA1" }, "seatNumbers");
  await bad({ seatNumbers: "KA-1,KA-2,KA-3,KA-4,KA-5" }, "seatNumbers");
  await bad({ seatNumbers: "KA-1,KA-1" }, "seatNumbers");
  await bad({ seatNumbers: "", seatCount: 9 }, "seatCount");
  await bad({ journeyDate: "2020-01-01" }, "journeyDate");
  await bad({ stopAt: new Date(Date.now() - 1000).toISOString() }, "stopAt");
  await bad({ toCity: "chattogram" }, "toCity");
  await bad({ trainName: "" }, "trainName");
});

test("without seat numbers the count decides; get by id and unknown id", async () => {
  const r = await call("/v1/holds", { method: "POST", body: { ...good(), seatNumbers: "", seatCount: 3 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.hold.seatCount, 3);
  assert.equal((await call(`/v1/holds/${r.body.hold.id}`)).status, 200);
  assert.equal((await call("/v1/holds/00000000-0000-0000-0000-000000000000")).status, 404);
});

test("the worker's alert endpoint needs the admin token and sends a push/telegram message", async () => {
  const noToken = await fetch(base + "/admin/hold-alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", body: "b" }) });
  assert.equal(noToken.status, 401);
  await world.pairDevice();
  const ok = await fetch(base + "/admin/hold-alert", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN }, body: JSON.stringify({ title: "Railway login needed", body: "Log in again", loginNeeded: true }) });
  assert.equal(ok.status, 200);
  const rows = (await world.db.query("select kind, title from notifications_log where kind = 'hold_attention'")).rows;
  assert.ok(rows.length >= 1);
  assert.equal((await fetch(base + "/admin/hold-alert", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": ADMIN }, body: "{}" })).status, 422);
});

test("the phone's holder can send an alert (push + Telegram) with its device token", async () => {
  await world.pairDevice();
  const ok = await call("/v1/holds/alert", { method: "POST", body: { title: "Seat dropped from the hold", body: "KA-2 stayed selected after two page refreshes" } });
  assert.equal(ok.status, 200);
  const rows = (await world.db.query("select title from notifications_log where title = 'Seat dropped from the hold'")).rows;
  assert.ok(rows.length >= 1);
  assert.equal((await call("/v1/holds/alert", { method: "POST", body: {} })).status, 422);
  const res = await fetch(base + "/v1/holds/alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", body: "b" }) });
  assert.equal(res.status, 401, "needs a paired device");
});
