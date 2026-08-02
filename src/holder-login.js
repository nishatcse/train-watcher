const path = require("path");
const { config } = require("./config");
const { withChromePage } = require("./browser");
const { performLogin } = require("./login");
const { log } = require("./helpers");

const CDP_PORT = 9225;

// Log the HOLDER account (B) into its own profile so seat-holds start instantly.
// browser-hold also does this on demand; this is for first-time setup / manual
// re-login.
async function holderLogin() {
  if (!config.holder.username || !config.holder.password) {
    throw new Error("HOLDER_USERNAME / HOLDER_PASSWORD missing from .env");
  }

  const profileDir = path.resolve(__dirname, "..", "state", "holder-profile");
  log("Launching browser for holder-account login...");

  await withChromePage(profileDir, CDP_PORT, async (page) => {
    await performLogin(page, config.holder);
    log("Holder account logged in (profile: state/holder-profile)");
  });
}

if (require.main === module) {
  holderLogin()
    .then(() => process.exit(0))
    .catch((error) => {
      log(`Holder login failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { holderLogin };
