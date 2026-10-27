// Loaded here too so `npm run refresh` works standalone; index.js pulls .env in
// via config.js, but this module is also a CLI entry point of its own.
require("dotenv").config({ quiet: true });

const { loadSession, saveSession } = require("./session");
const { log } = require("./helpers");

// The IAM server behind the booking site. Its discovery document advertises the
// `refresh_token` grant, and our access token carries the `offline_access`
// scope — so a 12-hourly renewal is a plain form POST, no browser required.
// (Discovery reports this endpoint over http; force https.)
const TOKEN_URL = "https://train-iam.shohoz.com/connect/token";

// Read out of the JWT the site itself issues, so we stay in step if they ever
// rename the SPA's client.
const CLIENT_ID = "train-ticket-user";

function hasRefreshToken() {
  try {
    return Boolean(loadSession().refresh_token);
  } catch {
    return false;
  }
}

/**
 * Swap the stored refresh token for a fresh access token and persist both.
 * Returns true on success. Never throws for an expected failure (no token,
 * server said no) — the caller falls back to the Chrome re-login.
 */
async function refreshSession() {
  let session;
  try {
    session = loadSession();
  } catch (error) {
    log(`Token refresh skipped: ${error.message}`);
    return false;
  }

  if (!session.refresh_token) {
    log("Token refresh skipped: no refresh token stored (run `npm run relogin` once to capture one)");
    return false;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refresh_token,
    client_id: CLIENT_ID,
  });

  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Keep the device identity on the renewal: the access token is bound to
        // this device pair, and dropping it here would hand back a token the
        // booking API then rejects.
        "x-device-key": session.ssdk,
        "x-device-id": session.uudid,
      },
      body,
    });
  } catch (error) {
    log(`Token refresh request failed: ${error.message}`);
    return false;
  }

  const text = await response.text();

  if (!response.ok) {
    log(`Token refresh rejected (HTTP ${response.status}): ${text.slice(0, 200)}`);
    return false;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    log(`Token refresh returned non-JSON: ${text.slice(0, 200)}`);
    return false;
  }

  if (!payload.access_token) {
    log(`Token refresh returned no access_token: ${text.slice(0, 200)}`);
    return false;
  }

  saveSession({
    ...session,
    token: payload.access_token,
    // Servers usually rotate the refresh token on use; keep the old one only if
    // this response did not carry a new one.
    refresh_token: payload.refresh_token || session.refresh_token,
  });

  log("Access token refreshed without Chrome");
  return true;
}

if (require.main === module) {
  refreshSession()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((error) => {
      log(`Token refresh failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { refreshSession, hasRefreshToken, TOKEN_URL };
