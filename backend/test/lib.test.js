const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isoToSite, siteToIso, isValidIso, daysBetween } = require("../src/lib/dates");
const { extractAvailability, shouldNotify, buildSearchUrl } = require("../src/lib/availability");
const { groupTargets, runPool } = require("../src/lib/pool");
const { encrypt, decrypt, sha256, pairingCode } = require("../src/lib/crypto");
const { tokenExpiresAt } = require("../src/lib/jwt");
const { buildCatalog, validateWatcher } = require("../src/lib/catalog");

test("date conversion round-trips and validates", () => {
  assert.equal(isoToSite("2026-10-31"), "31-Oct-2026");
  assert.equal(siteToIso("31-Oct-2026"), "2026-10-31");
  assert.equal(siteToIso("1-Jan-2027"), "2027-01-01");
  assert.ok(isValidIso("2026-02-28"));
  assert.ok(!isValidIso("2026-02-30"));
  assert.ok(!isValidIso("2026-13-01"));
  assert.throws(() => isoToSite("2026-13-01"));
  assert.equal(daysBetween("2026-10-27", "2026-10-31"), 4);
  assert.equal(daysBetween("2026-10-31", "2026-10-27"), -4);
});

const train = (online, offline = 0) => [{
  trip_number: "BHRAMMAPUTRA EXPRESS (744)",
  seat_types: [{ type: "S_CHAIR", seat_counts: { online, offline }, fare: 185, vat_amount: 0 }],
}];
const W = { trainName: "BHRAMMAPUTRA EXPRESS (744)", seatClass: "S_CHAIR", fromCity: "Mymensingh", toCity: "Dhaka", journeyDate: "2026-10-31" };

test("available seats = online + counter (one number)", () => {
  const a = extractAvailability(train(3, 40), W);
  assert.equal(a.availableCount, 43);
  assert.equal(a.onlineCount, 3);
  assert.equal(a.offlineCount, 40);
  assert.equal(a.status, "ok");
  assert.equal(extractAvailability(train(0, 40), W).availableCount, 40, "counter-only seats still count");
  assert.equal(extractAvailability(train(5, 0), W).availableCount, 5);
  assert.equal(extractAvailability(train(0, 0), W).availableCount, 0);
});

test("the alert text shows one total, with no online/counter split", () => {
  const { describe } = require("../src/lib/availability");
  const d = describe(W, extractAvailability(train(3, 4), W));
  assert.match(d.body, /Available seats: 7\b/);
  assert.doesNotMatch(d.body, /online|counter/i);
});

test("missing train vs missing class are distinguished", () => {
  assert.equal(extractAvailability([], W).status, "train_not_listed");
  assert.equal(extractAvailability(train(5), { ...W, seatClass: "AC_B" }).status, "class_not_offered");
});

test("shouldNotify is edge-triggered on the online count", () => {
  assert.equal(shouldNotify(null, { availableCount: 0 }), false);
  assert.equal(shouldNotify(null, { availableCount: 2 }), true);
  assert.equal(shouldNotify({ availableCount: 2 }, { availableCount: 2 }), false);
  assert.equal(shouldNotify({ availableCount: 2 }, { availableCount: 5 }), true);
  assert.equal(shouldNotify({ availableCount: 2 }, { availableCount: 0 }), false);
});

test("booking URL uses site date form", () => {
  const url = buildSearchUrl(W);
  assert.match(url, /fromcity=Mymensingh/);
  assert.match(url, /doj=31-Oct-2026/);
  assert.match(url, /class=S_CHAIR/);
});

test("groupTargets collapses watchers sharing route+date+class", () => {
  const groups = groupTargets([
    { id: "a", fromCity: "Dhaka", toCity: "Sylhet", journeyDate: "2026-10-31", seatClass: "S_CHAIR", trainName: "A" },
    { id: "b", fromCity: "Dhaka", toCity: "Sylhet", journeyDate: "2026-10-31", seatClass: "S_CHAIR", trainName: "B" },
    { id: "c", fromCity: "Dhaka", toCity: "Sylhet", journeyDate: "2026-10-31", seatClass: "SNIGDHA", trainName: "A" },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.seatClass === "S_CHAIR").watchers.length, 2);
});

test("runPool bounds concurrency and isolates failures", async () => {
  let inFlight = 0, peak = 0;
  const items = Array.from({ length: 8 }, (_, i) => i);
  const results = await runPool(items, { concurrency: 2, jitterMs: 0 }, async (n) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (n === 3) throw new Error("boom");
    return n * 2;
  });
  assert.ok(peak <= 2, `peak concurrency ${peak}`);
  assert.equal(results[3].ok, false);
  assert.equal(results[4].value, 8);
});

test("crypto: encrypt round-trips, tamper is detected", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const blob = encrypt(JSON.stringify({ token: "secret" }), key);
  assert.equal(JSON.parse(decrypt(blob, key)).token, "secret");
  assert.throws(() => decrypt(blob.slice(0, -2) + "xx", key));
  assert.throws(() => decrypt(blob, Buffer.alloc(32, 8).toString("base64")));
  assert.equal(sha256("x").length, 64);
  assert.match(pairingCode(), /^[A-Z2-9]{8}$/);
});

test("tokenExpiresAt reads JWT exp", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
  assert.equal(tokenExpiresAt(jwt), exp * 1000);
  assert.equal(tokenExpiresAt("not-a-jwt"), null);
});

test("catalog validation produces warnings, not throws", () => {
  const catalog = buildCatalog({
    cities: [{ city_id: 1, city_name: "Dhaka", is_enable_for_from: 1 }, { city_id: 2, city_name: "Sylhet", is_enable_for_from: 1 }],
    train_names: [{ model: "709", name: "PARABAT EXPRESS (709)" }],
    seat_types: { en: [{ seat_class: "S_CHAIR" }, { seat_class: "SNIGDHA" }] },
    trip_search_day_limit: 10,
  });
  assert.deepEqual(validateWatcher(catalog, { fromCity: "Dhaka", toCity: "Sylhet", trainName: "PARABAT EXPRESS (709)", seatClass: "S_CHAIR", journeyDate: "2026-10-31" }, "2026-10-27"), []);
  const bad = validateWatcher(catalog, { fromCity: "Narnia", toCity: "Sylhet", trainName: "GHOST", seatClass: "WOOD", journeyDate: "2026-10-28" }, "2026-10-27");
  assert.ok(bad.length >= 3);
});
