// One controlled browser login that captures EVERYTHING, to answer:
//   1. Does the browser login yield a refresh_token (and where)?
//   2. Does refreshing that refresh_token produce a BOOKING-VALID token?
// Saves the fresh (booking-valid) session to .env so nothing breaks.
//
//   node investigate-login.js       (or xvfb-run -a node investigate-login.js)

require("dotenv").config();
const path = require("path");
const { config } = require("./src/config");
const { withChromePage } = require("./src/browser");
const { saveSession } = require("./src/session");

const CDP_PORT = 9226;
const SEARCH = "https://railspaapi.shohoz.com/v1.0/web/bookings/search-trips-v2";

async function search(token, ssdk, uudid) {
  const p = new URLSearchParams({ from_city: "Dhaka", to_city: "Chattogram", date_of_journey: "05-Aug-2026", seat_class: "S_CHAIR" });
  const r = await fetch(`${SEARCH}?${p}`, { headers: { Authorization: `Bearer ${token}`, "x-device-key": ssdk, "x-device-id": uudid } });
  return r.status;
}

(async () => {
  const profileDir = path.resolve(__dirname, "state", "login-profile");
  await withChromePage(profileDir, CDP_PORT, async (page, { context }) => {
    const authResponses = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (!/train-iam\.shohoz|connect\/token|auth\/sign-in|auth\/validate-otp|handshake/.test(url)) return;
      let body = null;
      try { body = await res.text(); } catch { /* body gone */ }
      authResponses.push({ url, status: res.status(), body });
    });

    console.log("Logging in (real Chrome, solving Turnstile)…");
    await page.goto("https://eticket.railway.gov.bd/", { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto("https://eticket.railway.gov.bd/login", { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("#mobile_number", { timeout: 60000 });
    await page.locator("#mobile_number").fill(config.railwayUsername);
    await page.locator("#password").fill(config.railwayPassword);

    let turnstile = "";
    for (let i = 0; i < 120; i += 1) {
      turnstile = await page.evaluate(() => {
        const el = document.querySelector('input[name="cf-turnstile-response"]');
        return el ? el.value : "";
      });
      if (turnstile) break;
      await page.waitForTimeout(1000);
    }
    if (!turnstile) throw new Error("Turnstile did not solve in 120s");
    console.log("Turnstile solved, submitting…");
    await page.locator('button[type="submit"]').first().click();

    let token = null;
    for (let i = 0; i < 30; i += 1) {
      token = await page.evaluate(() => localStorage.getItem("token"));
      if (token) break;
      await page.waitForTimeout(1000);
    }
    if (!token) throw new Error("No token after login");

    const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    const cookies = await context.cookies();

    console.log("\n=== ALL localStorage keys ===");
    console.log(" ", Object.keys(storage).join(", "));
    console.log("=== cookies ===");
    console.log(" ", cookies.map((c) => c.name).join(", ") || "(none)");

    // Hunt for a refresh token anywhere.
    let refreshToken = null;
    let where = "";
    for (const [k, v] of Object.entries(storage)) {
      if (/refresh/i.test(k)) { refreshToken = v; where = `localStorage['${k}']`; }
    }
    for (const r of authResponses) {
      try {
        const j = JSON.parse(r.body);
        const rt = j.refresh_token || (j.data && j.data.refresh_token);
        if (rt) { refreshToken = rt; where = `response body of ${new URL(r.url).pathname}`; }
      } catch { /* not json */ }
    }
    for (const c of cookies) {
      if (/refresh/i.test(c.name)) { refreshToken = refreshToken || c.value; where = where || `cookie ${c.name}`; }
    }

    console.log("\n=== auth responses seen (body structure) ===");
    for (const r of authResponses) {
      console.log("  ", r.status, new URL(r.url).pathname);
      try {
        const j = JSON.parse(r.body);
        const top = j.data && typeof j.data === "object" ? { ...j, ...j.data } : j;
        console.log("       keys:", Object.keys(top).join(", "));
        for (const [k, v] of Object.entries(top)) {
          if (/token|refresh|expire|session/i.test(k)) {
            console.log(`       ~ ${k}: ${String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 50)}`);
          }
        }
      } catch { /* not json */ }
    }

    const ssdk = storage.ssdk;
    const uudid = storage.uudid;

    console.log("\n=== VERDICT ===");
    console.log("fresh browser token -> search:", await search(token, ssdk, uudid), "(expect 200)");
    console.log("refresh_token found:", refreshToken ? `YES (len ${refreshToken.length}) at ${where}` : "NO");

    if (refreshToken) {
      const rr = await (await fetch("https://train-iam.shohoz.com/connect/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "x-device-key": ssdk, "x-device-id": uudid },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "train-ticket-user" }),
      })).json();
      if (rr.access_token) {
        const status = await search(rr.access_token, ssdk, uudid);
        console.log("REFRESHED token -> search:", status, status === 200 ? "✅ BOOKING-VALID — clean cloud refresh WORKS" : "❌ orphaned — browser login needed each cycle");
      } else {
        console.log("refresh grant failed:", rr.error, rr.error_description || "");
      }
    }

    // Persist the fresh (booking-valid) session so watcher + aggregator keep working.
    const session = {
      token: storage.token, ssdk: storage.ssdk, user: storage.user, uudid: storage.uudid,
      handshake_data: storage.handshake_data, handshake_hash: storage.handshake_hash,
    };
    if (refreshToken) session.refresh_token = refreshToken;
    saveSession(session);
    console.log("\nFresh session saved to .env" + (refreshToken ? " (with refresh_token)" : ""));
  });
})().catch((e) => { console.error("investigation failed:", e.message); process.exit(1); });
