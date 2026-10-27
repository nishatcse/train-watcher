const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createShohozClient, SessionExpiredError, RateLimitedError } = require("../src/lib/shohoz");

const R = { from: 0 };
const route = { fromCity: "Dhaka", toCity: "Sylhet", journeyDate: "2026-10-31", seatClass: "S_CHAIR" };
const session = { token: "t", ssdk: "k", uudid: "u" };
const reply = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });

function client(fetchImpl, extra = {}) {
  let t = 1_000_000;
  const c = createShohozClient({ getSession: async () => session, fetchImpl, now: () => t, sleepFn: async (ms) => { t += ms; }, ...extra });
  return { c, advance: (ms) => { t += ms; } };
}

test("sends the site's date format and device headers", async () => {
  let seen;
  const { c } = client(async (url, init) => { seen = { url, init }; return reply(200, { data: { trains: [{ trip_number: "X" }] } }); });
  const trains = await c.searchTrips(route);
  assert.equal(trains.length, 1);
  assert.match(seen.url, /date_of_journey=31-Oct-2026/);
  assert.equal(seen.init.headers["x-device-key"], "k");
  assert.equal(seen.init.headers.Authorization, "Bearer t");
});

test("401 and 403 mean the session is dead", async () => {
  for (const status of [401, 403]) {
    const { c } = client(async () => reply(status, "no"));
    await assert.rejects(() => c.searchTrips(route), SessionExpiredError);
  }
});

test("429 pauses EVERY later request, and honours Retry-After", async () => {
  let calls = 0;
  const { c, advance } = client(async () => { calls += 1; return calls === 1 ? reply(429, "slow", { "retry-after": "30" }) : reply(200, { data: { trains: [] } }); });
  await assert.rejects(() => c.searchTrips(route), (e) => e instanceof RateLimitedError && e.retryAfterMs === 30000);
  // A person pressing a button is refused immediately with a clear error...
  await assert.rejects(() => c.searchTrips(route, { interactive: true }), RateLimitedError);
  assert.equal(calls, 1, "no request was sent while paused");
  // ...while the background loop waits out the pause and then proceeds.
  await c.searchTrips(route);
  assert.equal(calls, 2);
  advance(0);
});

test("429 without Retry-After backs off a minute", async () => {
  const { c } = client(async () => reply(429, "slow"));
  await assert.rejects(() => c.searchTrips(route), (e) => e.retryAfterMs === 60000);
});

test("a hung request times out instead of holding a pool slot forever", async () => {
  // AbortSignal.timeout's timer is unref'd (the real server's own sockets keep the loop alive);
  // hold the loop open here so the test measures the timeout rather than process exit.
  const keepAlive = setTimeout(() => {}, 2000);
  const { c } = client((url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))), { timeoutMs: 20 });
  try {
    await assert.rejects(() => c.searchTrips(route), /timed out/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("non-JSON and 5xx responses are errors, not empty results", async () => {
  await assert.rejects(() => client(async () => reply(200, "<html>")).c.searchTrips(route), /non-JSON/);
  await assert.rejects(() => client(async () => reply(502, "bad")).c.searchTrips(route), /HTTP 502/);
});

test("refreshToken returns null on every expected failure and never throws", async () => {
  const s = { ...session, refresh_token: "r" };
  assert.equal(await client(async () => reply(400, "no")).c.refreshToken(s), null);
  assert.equal(await client(async () => { throw new Error("net"); }).c.refreshToken(s), null);
  assert.equal(await client(async () => reply(200, {})).c.refreshToken(s), null);
  assert.equal(await client(async () => reply(200, {})).c.refreshToken(session), null, "no refresh token stored");
  const ok = await client(async () => reply(200, { access_token: "new", refresh_token: "r2" })).c.refreshToken(s);
  assert.deepEqual(ok, { token: "new", refresh_token: "r2" });
});
