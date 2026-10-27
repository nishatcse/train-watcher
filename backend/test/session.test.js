const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWorld, sessionBlob } = require("./helpers/fixtures");

const H = 3600 * 1000;
const MIN = 60 * 1000;

function clockWorld() {
  let t = Date.now();
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  return { clock };
}

test("session blob is encrypted at rest", async () => {
  const w = await createWorld();
  await w.sessions.save(sessionBlob(Date.now() + 5 * H, { refresh_token: "r-secret" }));
  const raw = (await w.db.query("select blob_enc from session")).rows[0].blob_enc;
  assert.doesNotMatch(raw, /ssdk|uudid|r-secret/);
  w.sessions.invalidateCache();
  assert.equal((await w.sessions.get()).refresh_token, "r-secret");
});

test("rejects expired, malformed and incomplete sessions", async () => {
  const w = await createWorld();
  await assert.rejects(() => w.sessions.save(sessionBlob(Date.now() - 1000)), /already expired/);
  await assert.rejects(() => w.sessions.save({ token: "x", ssdk: "a", uudid: "b" }), /JWT/);
  await assert.rejects(() => w.sessions.save({ token: "x" }), /ssdk/);
});

test("warns ~30 min and ~5 min before expiry, once each, then pauses when expired", async () => {
  const { clock } = clockWorld();
  const w = await createWorld({ now: clock.now });
  await w.pairDevice();
  await w.sessions.save(sessionBlob(clock.now() + 2 * H)); // no refresh token: the realistic case
  const alerts = async () => { await new Promise((r) => setTimeout(r, 15)); return w.sent.telegram.length; };

  assert.equal((await w.sessions.ensureUsable()).usable, true);
  assert.equal(await alerts(), 0);

  clock.advance(2 * H - 25 * MIN);
  const soon = await w.sessions.ensureUsable();
  assert.equal(soon.expiringSoon, true);
  assert.equal((await w.sessions.status()).status, "expiring_soon");
  assert.equal(await alerts(), 1);
  assert.match(w.sent.telegram[0], /25 minutes|about 2\d minutes/);

  await w.sessions.ensureUsable(); // same window: no repeat
  assert.equal(await alerts(), 1);

  clock.advance(21 * MIN); // ~4 min left
  await w.sessions.ensureUsable();
  assert.equal(await alerts(), 2);
  assert.match(w.sent.telegram[1], /about [1-5] minute/);

  clock.advance(10 * MIN); // expired
  const dead = await w.sessions.ensureUsable();
  assert.equal(dead.usable, false);
  assert.equal((await w.sessions.status()).status, "expired_awaiting_relogin");
  assert.equal(await alerts(), 3);
  await w.sessions.ensureUsable();
  assert.equal(await alerts(), 3, "expired alert is throttled");

  await w.sessions.save(sessionBlob(clock.now() + 12 * H)); // owner logs in
  assert.equal((await w.sessions.ensureUsable()).usable, true);
  assert.equal((await w.sessions.status()).status, "active");
});

test("headless refresh is used when a refresh token exists, and avoids any warning", async () => {
  const { clock } = clockWorld();
  const w = await createWorld({ now: clock.now });
  await w.pairDevice();
  await w.sessions.save(sessionBlob(clock.now() + 20 * MIN, { refresh_token: "rt1" }));
  w.shohoz.refreshToken = async (s) => (s.refresh_token === "rt1" ? { token: sessionBlob(clock.now() + 12 * H).token, refresh_token: "rt2" } : null);
  const out = await w.sessions.ensureUsable();
  assert.equal(out.refreshed, true);
  assert.equal((await w.sessions.get()).refresh_token, "rt2");
  assert.equal((await w.sessions.status()).status, "active");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(w.sent.telegram.length, 0);
});

test("a failed refresh falls back to asking the owner", async () => {
  const { clock } = clockWorld();
  const w = await createWorld({ now: clock.now });
  await w.pairDevice();
  await w.sessions.save(sessionBlob(clock.now() + 20 * MIN, { refresh_token: "rt1" }));
  w.shohoz.refreshToken = async () => null;
  const out = await w.sessions.ensureUsable();
  assert.equal(out.expiringSoon, true);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(w.sent.telegram.length, 1);
});

test("a 401 from the site pauses monitoring and asks for a login", async () => {
  const w = await createWorld();
  await w.pairDevice();
  await w.sessions.save(sessionBlob(Date.now() + 5 * H));
  const out = await w.sessions.handleRejected();
  assert.equal(out.usable, false);
  assert.equal((await w.sessions.status()).status, "expired_awaiting_relogin");
});
