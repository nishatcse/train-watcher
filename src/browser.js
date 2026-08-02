const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { config } = require("./config");
const { sleep, log } = require("./helpers");

// Turnstile detects Playwright-launched browsers (automation flags), so we spawn
// a plain Chrome with a debugging port and attach over CDP instead. Both relogin
// and the seat-hold flow reuse this so the Turnstile-friendly launch stays in one
// place.
function spawnChrome(profileDir, port) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    // Use a plaintext credential store instead of the system keyring, so a
    // headless Pi never blocks on a "unlock keyring" password prompt.
    "--password-store=basic",
    // NOTE: do not add "tuning" flags here without testing a full pre-warm.
    // A set of memory-saving flags (--renderer-process-limit=2,
    // --blink-settings=imagesEnabled=false, --disable-background-networking,
    // --disable-features=...) made the booking app hang forever on its trip-list
    // spinner: the page shell rendered but `app-single-trip` never appeared, and
    // every account failed to pre-warm. Plain Chrome works.
  ];
  if (process.env.RELOGIN_HEADLESS === "1") {
    args.push("--headless=new");
  }
  args.push("about:blank");
  return spawn(config.browserExecutablePath, args, { stdio: "ignore" });
}

async function waitForCdp(port) {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        return;
      }
    } catch {
      // Chrome not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Chrome did not open its debugging port ${port} within 30s`);
}

/**
 * Spawn a plain Chrome on `profileDir`, attach over CDP and return a ready page
 * plus a `close()` that tears everything down. The caller owns the lifetime —
 * used by the hold rotation, where the next account's browser must already be
 * open (and logged in) while the previous one is still holding.
 */
async function openChromePage(profileDir, port) {
  log(`Launching browser (profile ${profileDir}, port ${port})...`);
  const chrome = spawnChrome(profileDir, port);
  let browser = null;

  // Wait for Chrome to actually be gone before returning. A half-dead instance
  // still owns the profile's singleton lock, and the next launch on that same
  // profile then hands off to the dying process and exits — which surfaces later
  // as "Target page, context or browser has been closed".
  const close = async () => {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      return;
    }
    chrome.kill();
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        chrome.kill("SIGKILL");
        chrome.once("exit", done);
        setTimeout(done, 3000);
      }, 5000);
      chrome.once("exit", done);
    });
  };

  try {
    await waitForCdp(port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());
    return { page, browser, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Scoped variant of `openChromePage`: hand a ready page to `fn` and always clean
 * up afterwards. Used by the one-shot flows (relogin, holder login, hold-test).
 */
async function withChromePage(profileDir, port, fn) {
  const session = await openChromePage(profileDir, port);
  try {
    return await fn(session.page, { browser: session.browser, context: session.context });
  } finally {
    await session.close();
  }
}

module.exports = { spawnChrome, waitForCdp, openChromePage, withChromePage };
