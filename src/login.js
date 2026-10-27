const { log } = require("./helpers");

// The Pi is slow and the Turnstile challenge is CPU/RAM heavy, so give it plenty
// of time (overridable via env for tuning).
const TURNSTILE_WAIT_SECONDS = Number(process.env.TURNSTILE_WAIT_SECONDS) || 120;
const LOGIN_RESULT_WAIT_SECONDS = 30;

// The keys the API poller actually needs. Everything else in localStorage is UI
// state we do not want in .env.
const SESSION_KEYS = ["token", "ssdk", "user", "uudid", "handshake_data", "handshake_hash"];

// The IAM server advertises the `refresh_token` grant and our JWT carries the
// `offline_access` scope, so a refresh token exists somewhere — but the SPA
// bundle never mentions the string, so we cannot know its localStorage key up
// front. Match on the key name instead of hardcoding one.
const REFRESH_KEY_PATTERN = /refresh/i;

// Read the session blob (token + device keys) out of the page's localStorage,
// or null if the user is not logged in yet. Also picks up any refresh-token-ish
// key so `token-refresh.js` can renew without Chrome.
async function readSession(page) {
  return page.evaluate((wanted) => {
    if (!localStorage.getItem("token")) {
      return null;
    }
    const session = {};
    for (const key of wanted) {
      session[key] = localStorage.getItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (/refresh/i.test(key)) {
        session[key] = localStorage.getItem(key);
      }
    }
    return session;
  }, SESSION_KEYS);
}

/**
 * Watch the login network traffic for a refresh token. The SPA throws it away,
 * but the auth server still sends it, so scrape it off the response body before
 * it is lost. Returns a getter for whatever was captured.
 */
function captureRefreshToken(page) {
  let captured = null;

  page.on("response", async (response) => {
    const url = response.url();
    if (!/connect\/token|auth\/sign-in|auth\/validate-otp/.test(url)) {
      return;
    }
    try {
      const body = await response.json();
      // The token can sit at the top level or one level down under `data`.
      const found = body.refresh_token || (body.data && body.data.refresh_token);
      if (found) {
        captured = found;
        log(`Refresh token captured from ${new URL(url).pathname}`);
      }
    } catch {
      // Not JSON, or the body is already gone — nothing to capture here.
    }
  });

  return () => captured;
}

/**
 * Log the given account in on `page` (a real CDP-Chrome page so Turnstile solves).
 * Clears storage for a fresh device handshake, fills the credentials, waits for
 * Turnstile, submits, and returns the resulting session blob from localStorage.
 * Used by relogin.js.
 */
async function performLogin(page, { username, password }) {
  if (!username || !password) {
    throw new Error("login called without username/password");
  }

  // Start listening before the first navigation — the token response is the one
  // thing we cannot go back and re-read afterwards.
  const getRefreshToken = captureRefreshToken(page);

  await page.goto("https://eticket.railway.gov.bd/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  log("Storage cleared, loading login page for fresh device handshake...");
  await page.goto("https://eticket.railway.gov.bd/login", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("#mobile_number", { timeout: 60000 });

  await page.locator("#mobile_number").fill(username);
  await page.locator("#password").fill(password);

  log("Waiting for Turnstile to solve...");
  let turnstileToken = "";
  for (let i = 0; i < TURNSTILE_WAIT_SECONDS; i += 1) {
    turnstileToken = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return el ? el.value : "";
    });
    if (turnstileToken) {
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!turnstileToken) {
    throw new Error(`Turnstile did not solve within ${TURNSTILE_WAIT_SECONDS}s`);
  }

  log("Turnstile solved, submitting login...");
  await page.locator('button[type="submit"]').first().click();

  let session = null;
  for (let i = 0; i < LOGIN_RESULT_WAIT_SECONDS; i += 1) {
    session = await readSession(page);
    if (session) {
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!session) {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const hint = bodyText.replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`Login did not produce a token within ${LOGIN_RESULT_WAIT_SECONDS}s. Page said: ${hint}`);
  }

  // localStorage wins if it had one; otherwise fall back to what we scraped off
  // the network. Either way this is best-effort — the Chrome path still works
  // fine without a refresh token, it just cannot be skipped next time.
  const fromStorage = Object.keys(session).find((key) => REFRESH_KEY_PATTERN.test(key));
  const refreshToken = (fromStorage && session[fromStorage]) || getRefreshToken();

  if (refreshToken) {
    session.refresh_token = refreshToken;
    log("Refresh token saved — next renewal can skip Chrome");
  } else {
    log("No refresh token found; renewals will keep using Chrome");
  }

  return session;
}

module.exports = { performLogin, readSession };
