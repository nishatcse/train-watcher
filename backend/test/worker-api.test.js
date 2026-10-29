const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createHolds } = require("../src/services/holds");
const { createWorld, dayOffset, KEY, sessionBlob } = require("./helpers/fixtures");
const { sha256, encrypt } = require("../src/lib/crypto");

let world, server, base, holds;
const ADMIN = "a".repeat(32);
const DEVICE = "device-token-worker-tests";

const admin = async (path, { method = "GET", body, token = ADMIN } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const device = (path, method = "GET", body) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${DEVICE}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  world = await createWorld();
  await world.db.query("insert into devices (name, device_token_hash) values ('t', $1)", [sha256(DEVICE)]);
  holds = createHolds({ db: world.db });
  const app = createApp({ db: world.db, sessions: world.sessions, watchers: world.watchers, holds, notifier: world.notifier, scheduler: world.scheduler, shohoz: world.shohoz, config: { adminToken: ADMIN, sessionKey: KEY }, channels: {}, log: () => {} });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await world.db.close(); });

const newHold = () => device("/v1/holds", "POST", {
  fromCity: "Chattogram", toCity: "Dhaka", journeyDate: dayOffset(5), trainName: "TURNA (741)", seatNumbers: "KA-1,KA-2", holdSeconds: 375,
});

test("every worker endpoint needs the admin token", async () => {
  for (const [method, path] of [["POST", "/admin/worker/lease"], ["POST", "/admin/worker/claim"], ["GET", "/admin/worker/session"], ["GET", "/admin/worker/holds/x/status"]]) {
    assert.equal((await admin(path, { method, token: null, body: method === "POST" ? {} : undefined })).status, 401, path);
    assert.equal((await admin(path, { method, token: "wrong".repeat(8), body: method === "POST" ? {} : undefined })).status, 401, path);
  }
});

test("only one worker holds the lease; another is refused until the first goes quiet", async () => {
  assert.equal((await admin("/admin/worker/lease", { method: "POST", body: { workerId: "w1" } })).body.ok, true);
  assert.equal((await admin("/admin/worker/lease", { method: "POST", body: { workerId: "w1" } })).body.ok, true, "renewing is fine");
  assert.equal((await admin("/admin/worker/lease", { method: "POST", body: { workerId: "w2" } })).body.ok, false, "a second worker is refused");
  await world.db.query("update worker_lease set seen_at = now() - interval '2 minutes'");
  assert.equal((await admin("/admin/worker/lease", { method: "POST", body: { workerId: "w2" } })).body.ok, true, "a silent worker loses it");
  assert.equal((await admin("/admin/worker/lease", { method: "POST", body: {} })).status, 422);
});

test("claim returns nothing, then picks up a queued hold and marks it running", async () => {
  assert.equal((await admin("/admin/worker/claim", { method: "POST", body: {} })).body.hold, null);
  const made = (await newHold()).body.hold;
  const r = (await admin("/admin/worker/claim", { method: "POST", body: {} })).body;
  assert.equal(r.hold.id, made.id);
  assert.equal(r.hold.status, "running");
  assert.equal(r.resumed, false);
  assert.equal((await device(`/v1/holds/${made.id}`)).body.hold.status, "running");
  // a restarted worker gets the same running hold back
  const again = (await admin("/admin/worker/claim", { method: "POST", body: {} })).body;
  assert.equal(again.hold.id, made.id);
  assert.equal(again.resumed, true);
});

test("progress updates and events reach the app's view of the hold", async () => {
  const id = (await device("/v1/holds/current")).body.hold.id;
  await admin(`/admin/worker/holds/${id}/update`, { method: "POST", body: { phase: "holding", held_seats: ["KA-1", "KA-2"], cycle_count: 2, blocked_until: null, status: "failed", evil: 1 } });
  await admin(`/admin/worker/holds/${id}/event`, { method: "POST", body: { message: "Held 2/2 seat(s): KA-1, KA-2" } });
  const view = (await device(`/v1/holds/${id}`)).body;
  assert.equal(view.hold.phase, "holding");
  assert.deepEqual(view.hold.heldSeats, ["KA-1", "KA-2"]);
  assert.equal(view.hold.cycleCount, 2);
  assert.equal(view.hold.status, "running", "a worker cannot change the status through update");
  assert.match(view.events[0].message, /Held 2\/2/);
  assert.equal((await admin(`/admin/worker/holds/${id}/event`, { method: "POST", body: {} })).status, 422);
});

test("a stop request is visible to the worker, which then finishes the hold", async () => {
  const id = (await device("/v1/holds/current")).body.hold.id;
  assert.equal((await admin(`/admin/worker/holds/${id}/status`)).body.status, "running");
  await device(`/v1/holds/${id}`, "DELETE");
  assert.equal((await admin(`/admin/worker/holds/${id}/status`)).body.status, "stopping");
  assert.equal((await admin(`/admin/worker/holds/${id}/finish`, { method: "POST", body: { status: "bogus" } })).status, 422);
  await admin(`/admin/worker/holds/${id}/finish`, { method: "POST", body: { status: "stopped" } });
  const hold = (await device(`/v1/holds/${id}`)).body.hold;
  assert.equal(hold.status, "stopped");
  assert.equal(hold.active, false);
  assert.deepEqual(hold.heldSeats, []);
});

test("an interrupted finish (redeploy) leaves the hold running for the next worker", async () => {
  const made = (await newHold()).body.hold;
  await admin("/admin/worker/claim", { method: "POST", body: {} });
  await admin(`/admin/worker/holds/${made.id}/update`, { method: "POST", body: { phase: "holding", held_seats: ["KA-1"] } });
  await admin(`/admin/worker/holds/${made.id}/finish`, { method: "POST", body: { interrupted: true } });
  const hold = (await device(`/v1/holds/${made.id}`)).body.hold;
  assert.equal(hold.status, "running");
  assert.equal(hold.phase, null);
  assert.deepEqual(hold.heldSeats, []);
});

test("the worker gets the session still encrypted, and nothing when there is none", async () => {
  const none = (await admin("/admin/worker/session")).body;
  assert.equal(none.blobEnc, null);
  await world.db.query("update session set blob_enc = $1, updated_at = now() where id = 1", [encrypt(JSON.stringify(sessionBlob(Date.now() + 3600e3)), KEY)]);
  const r = (await admin("/admin/worker/session")).body;
  assert.match(r.blobEnc, /^v1\./, "an encrypted blob, never the plain session");
  assert.ok(r.updatedAt);
});
