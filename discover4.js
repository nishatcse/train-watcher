// discover4.js — aro deep: project e ki ki kaje lagte pare.
// SHUDHU PORAR kaj. Kichu book/hold kore na.
require("dotenv").config({ quiet: true });
const s = JSON.parse(Buffer.from(process.env.RAILWAY_SESSION_COOKIES, "base64").toString());
const H = { Authorization: `Bearer ${s.token}`, "x-device-key": s.ssdk, "x-device-id": s.uudid };
const BASE = "https://railspaapi.shohoz.com/v1.0/web";
const line = (t) => console.log("\n" + "=".repeat(72) + "\n  " + t + "\n" + "=".repeat(72));
const DATE = "08-Aug-2026";

// 1) Response headers — rate-limit / cache clue ache kina (scanning tune korte)
async function headers() {
  line("1. response headers — rate-limit / cache clue");
  const p = new URLSearchParams({ from_city: "Dhaka", to_city: "Chattogram", date_of_journey: DATE, seat_class: "S_CHAIR" });
  const r = await fetch(`${BASE}/bookings/search-trips-v2?${p}`, { headers: H });
  console.log("  HTTP", r.status);
  for (const [k, v] of r.headers.entries()) {
    if (/rate|limit|retry|cache|age|x-|cf-|ratel|remaining|reset/i.test(k)) console.log(`    ${k}: ${v}`);
  }
}

// 2) search-trips-v2 seat_class chhara kaj kore? (ek call e shob class emnitei ase)
async function noClass() {
  line("2. seat_class param chhara search kaj kore?");
  const p = new URLSearchParams({ from_city: "Dhaka", to_city: "Chattogram", date_of_journey: DATE });
  const r = await fetch(`${BASE}/bookings/search-trips-v2?${p}`, { headers: H });
  console.log("  without seat_class -> HTTP", r.status);
  if (r.ok) {
    const j = await r.json();
    const t = (j.data.trains || [])[0];
    console.log("  train count:", (j.data.trains || []).length, "| first train classes:", (t.seat_types || []).map((x) => x.type).join(","));
  }
}

// 3) search response er 'recommendations' + 'extra' e ki ache
async function extras() {
  line("3. recommendations / extra field");
  const p = new URLSearchParams({ from_city: "Dhaka", to_city: "Sylhet", date_of_journey: DATE, seat_class: "S_CHAIR" });
  const j = await (await fetch(`${BASE}/bookings/search-trips-v2?${p}`, { headers: H })).json();
  console.log("  data keys:", Object.keys(j.data));
  console.log("  recommendations:", JSON.stringify(j.data.recommendations).slice(0, 300));
  console.log("  selected_seat_class:", JSON.stringify(j.data.selected_seat_class));
  console.log("  extra:", JSON.stringify(j.extra).slice(0, 200));
}

// 4) /statistics/tickets-available abar — bulk availability endpoint hote pare (matrix er jonno sonar khoni)
async function stats() {
  line("4. /statistics/tickets-available abar (bulk availability?)");
  const tries = [
    ["GET no-param", () => fetch(`${BASE}/statistics/tickets-available`, { headers: H })],
    ["GET date", () => fetch(`${BASE}/statistics/tickets-available?date=${DATE}`, { headers: H })],
    ["POST date", () => fetch(`${BASE}/statistics/tickets-available`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ date: DATE }) })],
  ];
  for (const [label, fn] of tries) {
    try {
      const r = await fn();
      const t = await r.text();
      console.log(`  [${r.status}] ${label}: ${t.replace(/\s+/g, " ").slice(0, 160)}`);
    } catch (e) { console.log(`  ${label} -> ${e.message}`); }
  }
}

// 5) /search-route — hash-er mane ki, route info dey?
async function searchRoute() {
  line("5. /search-route full response");
  const j = await (await fetch(`${BASE}/search-route?from_city=Dhaka&to_city=Sylhet`, { headers: H })).json();
  console.log("  ", JSON.stringify(j).slice(0, 300));
  console.log("  (extra.hash ki handshake_hash er soman? =>", s.handshake_hash, ")");
}

// 6) all-trains/info — zone-wise count (network graph er base)
async function network() {
  line("6. all-trains/info — zone-wise network");
  const j = await (await fetch(`${BASE}/all-trains/info`, { headers: H })).json();
  const trains = j.data.trains || [];
  const byZone = {};
  const cities = new Set();
  for (const t of trains) { byZone[t.zone] = (byZone[t.zone] || 0) + 1; cities.add(t.origin_city); cities.add(t.destination_city); }
  console.log("  total trains:", trains.length, "| zones:", JSON.stringify(byZone), "| distinct endpoint-cities:", cities.size);
}

(async () => {
  for (const fn of [headers, noClass, extras, stats, searchRoute, network]) {
    try { await fn(); } catch (e) { console.log("  byartho:", e.message); }
  }
  console.log("\n" + "=".repeat(72) + "\n");
})();
