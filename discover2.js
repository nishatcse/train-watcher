// ============================================================================
// discover2.js — aro gobhir e dekha: multi-user app er jonno ki ki API ache.
// SHUDHU PORAR kaj (ekta chhara: password-grant ta VUL cred diye mari, jate
// server ki ki field chay sheta error message theke bujha jay — kono asol
// login noy). Kichu book kore na.
//
// Chalao:  node discover2.js
// ============================================================================
require("dotenv").config({ quiet: true });

const s = JSON.parse(Buffer.from(process.env.RAILWAY_SESSION_COOKIES, "base64").toString());
const H = {
  Authorization: `Bearer ${s.token}`,
  "x-device-key": s.ssdk,
  "x-device-id": s.uudid,
};
const BASE = "https://railspaapi.shohoz.com/v1.0/web";
const IAM = "https://train-iam.shohoz.com";

const line = (t) => console.log("\n" + "=".repeat(72) + "\n  " + t + "\n" + "=".repeat(72));

async function show(label, res) {
  const text = await res.text();
  const mark = res.ok ? "OK " : res.status === 422 || res.status === 400 || res.status === 401 ? "?? " : "XX ";
  console.log(`  [${mark}${res.status}] ${label}`);
  console.log("       " + text.replace(/\s+/g, " ").slice(0, 400));
  try { return JSON.parse(text); } catch { return null; }
}

async function get(label, path, params, headers = H) {
  const qs = params ? "?" + new URLSearchParams(params) : "";
  return show(label, await fetch(`${BASE}${path}${qs}`, { headers }));
}
async function post(label, path, body, headers = H, base = BASE) {
  return show(label, await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

// 1) password grant — VUL cred. Multi-user app er asol proshno: Turnstile chhara
//    /connect/token die sorasori login kora jay ki na?
async function passwordGrant() {
  line("1. password grant — Turnstile chhara login hoy ki? (vul cred diye test)");
  const forms = [
    { grant_type: "password", username: "00000000000", password: "wrong", client_id: "train-ticket-user" },
    { grant_type: "password", username: "00000000000", password: "wrong", client_id: "train-ticket-user", scope: "shohoz.iam.train offline_access" },
  ];
  for (const form of forms) {
    const r = await fetch(`${IAM}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-device-key": s.ssdk, "x-device-id": s.uudid },
      body: new URLSearchParams(form),
    });
    const t = await r.text();
    console.log(`  [${r.status}] scope=${form.scope || "(none)"}`);
    console.log("       " + t.replace(/\s+/g, " ").slice(0, 400));
    console.log("       ^ 'invalid_grant'/'invalid credentials' = login endpoint kaj kore, shudhu pass vul.");
    console.log("         'turnstile'/'captcha'/'acr' jatiyo kichu chaile => Turnstile lagbei.\n");
  }
}

// 2) seat-layout — kon coach er kon seat number faka (Chrome chhara)?
async function seatLayout() {
  line("2. seat-layout — kon seat number faka (Chrome chhara paoya jay?)");
  // TURNA (742) Dhaka->Chattogram S_CHAIR trip_id/trip_route_id search theke ni.
  const p = new URLSearchParams({ from_city: "Dhaka", to_city: "Chattogram", date_of_journey: "07-Aug-2026", seat_class: "S_CHAIR" });
  const search = await (await fetch(`${BASE}/bookings/search-trips-v2?${p}`, { headers: H })).json();
  const train = (search.data.trains || []).find((t) => t.trip_number === "TURNA (742)");
  const st = train && (train.seat_types || []).find((x) => x.type === "S_CHAIR");
  if (!st) return console.log("  TURNA S_CHAIR paoya gelo na");
  console.log(`  trip_id=${st.trip_id} trip_route_id=${st.trip_route_id}`);
  await get("seat-layout GET", "/bookings/seat-layout", { trip_id: st.trip_id, trip_route_id: st.trip_route_id });
  await post("seat-layout POST", "/bookings/seat-layout", { trip_id: st.trip_id, trip_route_id: st.trip_route_id });
}

// 3) all-trains/info — app er train catalog (offline drop-down)
async function allTrains() {
  line("3. all-trains/info — koto ta train, ki structure");
  const j = await get("all-trains/info", "/all-trains/info", {});
  const trains = j && j.data && j.data.trains;
  if (trains) {
    console.log(`\n  total ${trains.length} ta train.  sample:`);
    console.log("  " + JSON.stringify(trains[0]));
  }
}

// 4) user er nijer tickets — app er "amar ticket" page
async function myTickets() {
  line("4. user er nijer data — purchase-history / trips-v2");
  await get("purchase-history", "/bookings/purchase-history", {});
  await get("trips-v2", "/trips-v2", {});
  await get("past-v2", "/trips/past-v2", {});
}

// 5) profile — login kore ki ki jana jay
async function profile() {
  line("5. /auth/profile — user er ki ki info");
  await get("auth/profile", "/auth/profile", {});
}

(async () => {
  for (const fn of [passwordGrant, seatLayout, allTrains, myTickets, profile]) {
    try { await fn(); } catch (e) { console.log(`  byartho: ${e.message}`); }
  }
  console.log("\n" + "=".repeat(72) + "\n");
})();
