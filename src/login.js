const { log } = require("./helpers");

// The Pi is slow and the Turnstile challenge is CPU/RAM heavy, so give it plenty
// of time (overridable via env for tuning).
const TURNSTILE_WAIT_SECONDS = Number(process.env.TURNSTILE_WAIT_SECONDS) || 120;
const LOGIN_RESULT_WAIT_SECONDS = 30;

// Read the full session blob (token + device keys) out of the page's localStorage,
// or null if the user is not logged in yet.
async function readSession(page) {
  return page.evaluate(() => {
    if (!localStorage.getItem("token")) {
      return null;
    }
    return {
      token: localStorage.getItem("token"),
      ssdk: localStorage.getItem("ssdk"),
      user: localStorage.getItem("user"),
      uudid: localStorage.getItem("uudid"),
      handshake_data: localStorage.getItem("handshake_data"),
      handshake_hash: localStorage.getItem("handshake_hash"),
    };
  });
}

/**
 * Log the given account in on `page` (a real CDP-Chrome page so Turnstile solves).
 * Clears storage for a fresh device handshake, fills the credentials, waits for
 * Turnstile, submits, and returns the resulting session blob from localStorage.
 * Shared by relogin.js (watcher account) and browser-hold.js (holder account).
 */
async function performLogin(page, { username, password }) {
  if (!username || !password) {
    throw new Error("login called without username/password");
  }

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

  return session;
}

module.exports = { performLogin, readSession };
