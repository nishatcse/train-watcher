const path = require("path");
const { config } = require("./config");
const { saveSession } = require("./session");
const { withChromePage } = require("./browser");
const { performLogin } = require("./login");
const { log } = require("./helpers");

const CDP_PORT = 9223;

// Re-login the WATCHER account (account A) into its own profile and save the
// session to RAILWAY_SESSION_COOKIES for the API poller to use.
async function relogin() {
  if (!config.railwayUsername || !config.railwayPassword) {
    throw new Error("RAILWAY_USERNAME / RAILWAY_PASSWORD missing from .env");
  }

  const profileDir = path.resolve(__dirname, "..", "state", "login-profile");
  log("Launching browser for re-login (watcher account)...");

  await withChromePage(profileDir, CDP_PORT, async (page) => {
    const session = await performLogin(page, {
      username: config.railwayUsername,
      password: config.railwayPassword,
    });
    saveSession(session);
    log("Re-login successful, fresh session saved to .env");
  });
}

if (require.main === module) {
  relogin()
    .then(() => process.exit(0))
    .catch((error) => {
      log(`Re-login failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { relogin };
