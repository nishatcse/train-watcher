const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createWorld, sessionBlob, dayOffset, trainsWith, KEY } = require("./helpers/fixtures");

let world, server, base, deviceToken;
const ADMIN = "a".repeat(32);
const DAY = dayOffset(4);

const call = async (path, { method = "GET", body, token = deviceToken, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  world = await createWorld();
  const config = { adminToken: ADMIN, sessionKey: KEY };
  const app = createApp({ db: world.db, sessions: world.sessions, watchers: world.watchers, notifier: world.notifier, scheduler: world.scheduler, shohoz: world.shohoz, config, channels: { telegram: true, fcm: true }, log: () => {} });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { server.close(); await world.db.close(); });

test("health needs no auth; unknown routes 404 as JSON", async () => {
  assert.equal((await call("/health", { token: null })).body.ok, true);
  assert.equal((await call("/nope", { token: null })).status, 404);
});

test("everything under /v1 refuses unpaired callers", async () => {
  for (const p of ["/v1/watchers", "/v1/status", "/v1/settings", "/v1/catalog", "/v1/session/status"]) {
    assert.equal((await call(p, { token: null })).status, 401, p);
    assert.equal((await call(p, { token: "bogus" })).status, 401, p);
  }
});

test("pairing: admin mints a one-time code, the device trades it for a token, reuse fails", async () => {
  assert.equal((await call("/admin/pairing-code", { method: "POST", token: null })).status, 401);
  const minted = await call("/admin/pairing-code", { method: "POST", token: null, headers: { "x-admin-token": ADMIN } });
  assert.equal(minted.status, 200);
  assert.match(minted.body.code, /^[A-Z2-9]{8}$/);

  assert.equal((await call("/v1/pair", { method: "POST", token: null, body: { code: "WRONGCODE" } })).status, 401);
  const paired = await call("/v1/pair", { method: "POST", token: null, body: { code: minted.body.code.toLowerCase(), deviceName: "Pixel" } });
  assert.equal(paired.status, 201);
  deviceToken = paired.body.deviceToken;
  assert.equal((await call("/v1/pair", { method: "POST", token: null, body: { code: minted.body.code } })).status, 401, "single use");

  const stored = (await world.db.query("select device_token_hash from devices")).rows.map((r) => r.device_token_hash);
  assert.ok(!stored.includes(deviceToken), "raw token is never stored");
  assert.equal((await call("/v1/status")).status, 200);
});

test("session upload makes the engine usable; status never leaks the token", async () => {
  assert.equal((await call("/v1/session/status")).body.status, "expired_awaiting_relogin");
  assert.equal((await call("/v1/session", { method: "POST", body: { token: "x" } })).status, 422);
  const ok = await call("/v1/session", { method: "POST", body: sessionBlob(Date.now() + 11 * 3600 * 1000) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "active");
  assert.doesNotMatch(JSON.stringify(ok.body), /sig|ssdk|uudid/);
});

test("watchers: create, duplicate, validate, patch, delete", async () => {
  const body = { fromCity: "Dhaka", toCity: "Sylhet", journeyDate: DAY, trainName: "UPABAN EXPRESS (739)", seatClass: "S_CHAIR" };
  const created = await call("/v1/watchers", { method: "POST", body });
  assert.equal(created.status, 201);
  const id = created.body.watcher.id;
  assert.equal((await call("/v1/watchers", { method: "POST", body })).status, 409);
  assert.equal((await call("/v1/watchers", { method: "POST", body: { ...body, journeyDate: "nope" } })).status, 422);

  const paused = await call(`/v1/watchers/${id}`, { method: "PATCH", body: { enabled: false } });
  assert.equal(paused.body.watcher.enabled, false);
  assert.equal((await call("/v1/watchers/00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await call(`/v1/watchers/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call("/v1/watchers")).body.watchers.length, 0);
});

test("a retried create with the same Idempotency-Key creates one watcher", async () => {
  const body = { fromCity: "Dhaka", toCity: "Chattogram", journeyDate: DAY, trainName: "TURNA (741)", seatClass: "S_CHAIR" };
  const h = { "idempotency-key": "retry-1" };
  const a = await call("/v1/watchers", { method: "POST", body, headers: h });
  const b = await call("/v1/watchers", { method: "POST", body, headers: h });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, "replayed response, not a 409");
  assert.equal(a.body.watcher.id, b.body.watcher.id);
});

test("settings: the 10s floor is explained, not silently clamped", async () => {
  const bad = await call("/v1/settings", { method: "PATCH", body: { scanCycleSeconds: 3 } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /10s/);
  assert.match(bad.body.error.message, /rate limit/i);
  const good = await call("/v1/settings", { method: "PATCH", body: { scanCycleSeconds: 20, scanConcurrency: 3 } });
  assert.equal(good.body.scanCycleSeconds, 20);
  assert.equal((await call("/v1/settings", { method: "PATCH", body: { scanConcurrency: 99 } })).status, 422);
  await call("/v1/settings", { method: "PATCH", body: { scanCycleSeconds: 15, scanConcurrency: 2 } });
});

test("push token registration and replacement", async () => {
  assert.equal((await call("/v1/device/fcm-token", { method: "PUT", body: {} })).status, 422);
  await call("/v1/device/fcm-token", { method: "PUT", body: { fcmToken: "tok-A" } });
  await call("/v1/device/fcm-token", { method: "PUT", body: { fcmToken: "tok-B" } });
  assert.equal((await world.db.query("select fcm_token from devices")).rows[0].fcm_token, "tok-B");
});

test("test alert goes through the real pipeline and reports per-channel delivery", async () => {
  const r = await call("/v1/settings/test-alert", { method: "POST", body: { channel: "both" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.channels.map((c) => [c.channel, c.status]).sort(), [["fcm", "sent"], ["telegram", "sent"]]);
  assert.equal(world.sent.fcm.at(-1).token, "tok-B");
  assert.equal(world.sent.fcm.at(-1).data.type, "test");
});

test("history groups channels per alert; ack marks it", async () => {
  const list = (await call("/v1/notifications")).body.notifications;
  const test = list.find((n) => n.kind === "test");
  assert.equal(test.channels.length, 2);
  await call(`/v1/notifications/${test.alertId}/ack`, { method: "POST" });
  assert.ok((await call("/v1/notifications")).body.notifications.find((n) => n.alertId === test.alertId).acknowledgedAt);
});

test("live verify reports whether the train and class exist on that search", async () => {
  world.script.trains = trainsWith("UPABAN EXPRESS (739)", "S_CHAIR", 6, 2);
  const body = { fromCity: "Dhaka", toCity: "Sylhet", journeyDate: DAY, trainName: "UPABAN EXPRESS (739)", seatClass: "S_CHAIR" };
  const ok = (await call("/v1/watchers/verify", { method: "POST", body })).body;
  assert.deepEqual([ok.trainListed, ok.classOffered, ok.onlineSeats, ok.counterSeats, ok.availableSeats], [true, true, 6, 2, 8]);
  const ghost = (await call("/v1/watchers/verify", { method: "POST", body: { ...body, trainName: "GHOST (1)" } })).body;
  assert.equal(ghost.trainListed, false);
  assert.ok(ghost.trainsOnThisSearch.includes("UPABAN EXPRESS (739)"));
});

test("status reports engine, session and channel health", async () => {
  const s = (await call("/v1/status")).body;
  assert.equal(s.session.status, "active");
  assert.equal(s.channels.pairedDevices, 1);
  assert.equal(s.watchers.total, 1);
  assert.equal(s.engine.cycleSeconds, 15);
});

test("a revoked device is locked out immediately", async () => {
  assert.equal((await call("/v1/device", { method: "DELETE" })).status, 200);
  assert.equal((await call("/v1/status")).status, 401);
});

test("admin session upload works without a device (CLI fallback)", async () => {
  const r = await call("/admin/session", { method: "POST", token: null, headers: { "x-admin-token": ADMIN }, body: sessionBlob(Date.now() + 9 * 3600 * 1000) });
  assert.equal(r.status, 200);
  assert.equal((await call("/admin/session", { method: "POST", token: null, body: {} })).status, 401);
});
