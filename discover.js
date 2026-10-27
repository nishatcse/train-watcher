// ============================================================================
// discover.js — Sohoz er API te ki ki ache ta ber korar jonno.
//
// SHUDHU PORAR kaj kore. Kichu book kore na, kichu bodlay na, kono seat
// dhore rakhe na. Tomar nijer session diye tomar nijer proshner uttor khoje.
//
// Chalao:  node discover.js
// (train-watcher folder er bhitore rakho, jate .env ta pay)
// ============================================================================

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const s = JSON.parse(Buffer.from(process.env.RAILWAY_SESSION_COOKIES, "base64").toString());
const H = {
  Authorization: `Bearer ${s.token}`,
  "x-device-key": s.ssdk,
  "x-device-id": s.uudid,
};

const line = (t) => console.log("\n" + "=".repeat(70) + "\n  " + t + "\n" + "=".repeat(70));

// ---------------------------------------------------------------------------
// 1. Auth server nijei bole dey se ki ki pare.
//    Ekhane "refresh_token" lekha thakle => Chrome puropuri bad deoya jabe.
// ---------------------------------------------------------------------------
async function authServer() {
  line("1. auth server ki ki support kore");
  for (const base of ["https://train-iam.shohoz.com", "http://train-iam.shohoz.com"]) {
    try {
      const r = await fetch(`${base}/.well-known/openid-configuration`);
      if (!r.ok) { console.log(`  ${base} -> HTTP ${r.status}`); continue; }
      const j = await r.json();
      console.log(`  ${base}  ✅`);
      console.log("    token endpoint :", j.token_endpoint);
      console.log("    grant types    :", (j.grant_types_supported || []).join(", "));
      console.log("    scopes         :", (j.scopes_supported || []).join(", "));
      if ((j.grant_types_supported || []).includes("refresh_token")) {
        console.log("\n    ✅ refresh_token SUPPORTED.");
        console.log("       mane: refresh token peye gele ar kokhono Chrome lagbe na.");
      }
      return;
    } catch (e) {
      console.log(`  ${base} -> ${e.message}`);
    }
  }
  console.log("  auth server er discovery document paoya gelo na.");
}

// ---------------------------------------------------------------------------
// 2. Site er NIJER JavaScript file theke shob API thikana tule ani.
//    Eta-i asol poddhoti — ondhokare guess na kore, ora nijera ja likhe
//    rekheche seta pora.
// ---------------------------------------------------------------------------
const SITE = "https://eticket.railway.gov.bd/";

async function endpoints() {
  line("2. site er JS bundle e ki ki API thikana lekha ache");
  const home = await (await fetch(SITE)).text();
  // Angular <base href="/"> use kore, tai script src gulo RELATIVE ("main-abc.js").
  // Age regex e leading "/" badhyotamulok chhilo — tai 0 ta file mil-to.
  const files = [...home.matchAll(/(?:src|href)="([^"]*\.js)"/g)].map((m) => m[1]);
  console.log(`  ${files.length} ta JS file paoya gelo`);

  // Bundle gulo local e rekhe dei — bar bar download na kore offline e ghata jay.
  const cacheDir = path.join(__dirname, "state", "bundle-cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const found = new Set();
  let refreshTokenSeen = false;

  for (const f of files) {
    const url = new URL(f, SITE).href;
    const cached = path.join(cacheDir, path.basename(f));
    try {
      const js = fs.existsSync(cached)
        ? fs.readFileSync(cached, "utf8")
        : await (await fetch(url)).text();
      fs.writeFileSync(cached, js, "utf8");
      console.log(`    ${f} — ${Math.round(js.length / 1024)} KB`);
      // Minified bundle e URL gulo tukro tukro kore jora lagano hoy, tai
      // ekta noy — kayekta pattern die khuji.
      for (const m of js.matchAll(/["'`](v\d[\d.]*\/[a-z0-9\-\/_{}$]{4,})["'`]/gi)) found.add(m[1]);
      for (const m of js.matchAll(/["'`](\/?api\/[a-z0-9\-\/_{}$]{3,})["'`]/gi)) found.add(m[1]);
      // "bookings/seat-layout" / "web/bookings/..." dhoroner khali path tukro
      for (const m of js.matchAll(/["'`]((?:web|mobile|bookings|auth|user)\/[a-z0-9\-\/_]{3,})["'`]/gi)) found.add(m[1]);
      // kono full URL hardcode kora ache kina
      for (const m of js.matchAll(/["'`](https?:\/\/[a-z0-9.\-]*shohoz[a-z0-9.\-\/]*)["'`]/gi)) found.add(m[1]);
      if (/refresh_token/.test(js)) refreshTokenSeen = true;
    } catch (e) {
      console.log(`    ${f} — para gelo na (${e.message})`);
    }
  }

  console.log(`\n  bundle gulo rakha holo: ${cacheDir}`);

  console.log(`\n  ${found.size} ta thikana paoya gelo:\n`);
  [...found].sort().forEach((p) => console.log("    " + p));
  console.log("\n  ekhane 'routes' ba 'stoppage' jatiyo kichu thakle sheta diye");
  console.log("  train er shob station programme nijei ene nite parbe.");
  console.log(`\n  bundle e "refresh_token" shobdo ta ache? ${refreshTokenSeen ? "HAA ✅" : "na"}`);
}

// ---------------------------------------------------------------------------
// 3. Ek hit e asole koto ta data ase? Shob class ki ekshathe ase?
// ---------------------------------------------------------------------------
async function oneHit() {
  line("3. ek hit e koto ta data ase");
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date(Date.now() + 5 * 864e5);           // 5 din porer tarikh
  const date = `${String(d.getDate()).padStart(2, "0")}-${M[d.getMonth()]}-${d.getFullYear()}`;

  const p = new URLSearchParams({
    from_city: "Dhaka", to_city: "Chattogram",
    date_of_journey: date, seat_class: "S_CHAIR",
  });

  const r = await fetch(`https://railspaapi.shohoz.com/v1.0/web/bookings/search-trips-v2?${p}`, { headers: H });
  console.log(`  HTTP ${r.status}  |  tarikh: ${date}`);
  if (!r.ok) return console.log("  " + (await r.text()).slice(0, 300));

  const trains = ((await r.json()).data || {}).trains || [];
  console.log(`  ei EK hit e ${trains.length} ta train elo:\n`);
  for (const t of trains) {
    const cls = (t.seat_types || [])
      .map((x) => `${x.type}:${x.seat_counts.online}+${x.seat_counts.offline}`)
      .join("   ");
    console.log(`    ${String(t.trip_number).padEnd(30)} ${cls}`);
  }
  console.log("\n  ↑ ek-i train er pashe ekadhik class dekhle => EK HIT E SHOB CLASS ASE.");
  console.log("    tokhon protita class er jonno alada hit marar dorkar nei.\n");
  console.log("  train object er shob field:");
  console.log("    " + Object.keys(trains[0] || {}).join(", "));
}

// ---------------------------------------------------------------------------
// 4. Amader nijer session blob e ki ki ache — refresh token ki dhora porechhe?
//    login.js er readSession() shudhu 6 ta key pore; refresh token onno kono
//    key te thakle sheta ekhane dhora porbe na — tokhon browser theke puro
//    localStorage dump kora lagbe.
// ---------------------------------------------------------------------------
async function sessionBlob() {
  line("4. amader session blob e ki ki ache");
  const keys = Object.keys(s);
  console.log("  saved keys :", keys.join(", "));

  const refreshKey = keys.find((k) => /refresh/i.test(k));
  console.log(`  refresh token saved? ${refreshKey ? `HAA -> "${refreshKey}" ✅` : "NA ❌ (login.js eta tulchhe na)"}`);

  const c = JSON.parse(Buffer.from(s.token.split(".")[1], "base64url").toString());
  const hrs = ((c.exp - c.nbf) / 3600).toFixed(2);
  console.log(`\n  token lifetime : ${hrs} ghonta`);
  console.log(`  valid till     : ${new Date(c.exp * 1000).toISOString()}  (${Date.now() > c.exp * 1000 ? "EXPIRED" : "ekhono valid"})`);
  console.log(`  scope          : ${(c.scope || []).join(", ")}`);
  console.log(`  client_id      : ${c.client_id}`);
  console.log(`  session id     : ${c.sid || "(nei)"}`);
  console.log(`  subject (sub)  : ${c.sub}`);

  if ((c.scope || []).includes("offline_access") && !refreshKey) {
    console.log("\n  ⚠️  scope e offline_access ACHE kintu blob e refresh token NEI.");
    console.log("      => login.js er readSession() ke puro localStorage dump korte hobe,");
    console.log("         ba /connect/token er response body hook korte hobe.");
  }
}

// ---------------------------------------------------------------------------
// 5. Bundle theke paoya endpoint gulo asole ki chay? Kayekta param-shape
//    cheshta kore dekhi — shob GET, kichu bodlay na.
//    Amader dorkar duita:
//      /train-routes              -> ek train er SHOB station (station list)
//      /statistics/tickets-available -> ek hit e bulk availability?
// ---------------------------------------------------------------------------
const BASE = "https://railspaapi.shohoz.com/v1.0/web";

async function tryGet(label, path, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? "?" + qs : ""}`;
  try {
    const r = await fetch(url, { headers: H });
    const body = await r.text();
    const mark = r.ok ? "✅" : r.status === 422 || r.status === 400 ? "⚠️ " : "❌";
    console.log(`  ${mark} HTTP ${r.status}  ${label}`);
    console.log(`       ${qs || "(param nei)"}`);
    console.log(`       ${body.replace(/\s+/g, " ").slice(0, 320)}`);
    return r.ok ? JSON.parse(body) : null;
  } catch (e) {
    console.log(`  ❌ ${label} — ${e.message}`);
    return null;
  }
}

// POST kora hocche karon endpoint ta GET e 405 dey. Eta O SHUDHU PORAR kaj —
// train er route jante chaoya, kono booking noy.
async function tryPost(label, path, body) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    console.log(`  ${r.ok ? "✅" : "⚠️ "} HTTP ${r.status}  ${label} (POST)`);
    console.log(`       body sent: ${JSON.stringify(body)}`);
    console.log(`       ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    return r.ok ? JSON.parse(text) : null;
  } catch (e) {
    console.log(`  ❌ ${label} — ${e.message}`);
    return null;
  }
}

async function probeEndpoints() {
  line("5. notun endpoint gulo ki chay");

  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const d = new Date(Date.now() + 5 * 864e5);
  const dmy = `${String(d.getDate()).padStart(2, "0")}-${M[d.getMonth()]}-${d.getFullYear()}`;
  const ymd = d.toISOString().slice(0, 10);

  console.log("\n  --- /train-routes (train er shob station?) — GET e 405, mane POST chay ---");
  await tryPost("train-routes", "/train-routes", { model: "TURNA (742)", departure_date_time: ymd });
  await tryPost("train-routes", "/train-routes", { model: "742", departure_date_time: dmy });

  console.log("\n  --- /statistics/tickets-available (bulk availability?) ---");
  await tryGet("statistics", "/statistics/tickets-available", {});
  await tryGet("statistics", "/statistics/tickets-available", { date: dmy });

  console.log("\n  --- /search-route ---");
  await tryGet("search-route", "/search-route", { from_city: "Dhaka", to_city: "Chattogram" });

  console.log("\n  --- /all-trains/info ---");
  await tryGet("all-trains-info", "/all-trains/info", {});

  console.log("\n  422/400 mane endpoint ta ACHE, shudhu param er nam mileni —");
  console.log("  error message porle prayoi shothik param er nam bole dey.");
}

(async () => {
  for (const [name, fn] of [["auth", authServer], ["endpoints", endpoints], ["onehit", oneHit], ["session", sessionBlob], ["probe", probeEndpoints]]) {
    try { await fn(); } catch (e) { console.log(`\n  [${name}] byartho: ${e.message}`); }
  }
  console.log("\n" + "=".repeat(70) + "\n");
})();