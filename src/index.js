const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("./config");
const { runChecksOnce, checkRoute, loadState, saveState } = require("./checker");
const { expandRoutes, runPool } = require("./scanner");
const { SessionExpiredError } = require("./api-client");
const { loadSession, reloadSessionFromDisk, tokenExpiresAt } = require("./session");
const { refreshSession } = require("./token-refresh");
const { validateRoutes } = require("./catalog");
const { sendTelegramMessage } = require("./telegram");
const { sleep, log } = require("./helpers");

const TOKEN_RENEW_MARGIN_MS = 30 * 60 * 1000;
const RELOGIN_RETRY_MS = 30 * 60 * 1000;
const RELOGIN_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

let lastReloginAlertAt = 0;

function runReloginProcess() {
  return new Promise((resolve) => {
    const reloginScript = path.join(__dirname, "relogin.js");
    const useXvfb = !process.env.DISPLAY;
    const command = useXvfb ? "xvfb-run" : process.execPath;
    const args = useXvfb ? ["-a", process.execPath, reloginScript] : [reloginScript];

    log(`Starting re-login (${useXvfb ? "xvfb-run" : "direct"})...`);
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      log(`Re-login process failed to start: ${error.message}`);
      resolve(false);
    });
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function notifyReloginFailure(reason) {
  const now = Date.now();
  if (now - lastReloginAlertAt < RELOGIN_ALERT_EVERY_MS) {
    return;
  }

  try {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      [
        "Ticket watcher: session dead, auto re-login FAILED.",
        `Host: ${os.hostname()}`,
        `Reason: ${reason}`,
        "Fix: SSH/VNC into the device and run `npm run relogin`, then the watcher resumes automatically.",
        `Watcher keeps retrying every ${Math.round(RELOGIN_RETRY_MS / 60000)} minutes.`,
      ].join("\n")
    );
    lastReloginAlertAt = now;
  } catch (error) {
    log(`Could not send Telegram alert: ${error.message}`);
  }
}

/**
 * Renew the session, cheapest route first: a refresh-token POST costs one HTTP
 * round trip, while the Chrome fallback spawns a browser and solves Turnstile —
 * minutes of CPU on a Pi. The fallback stays because refresh tokens expire too.
 */
async function renewSession() {
  if (await refreshSession()) {
    reloadSessionFromDisk();
    lastReloginAlertAt = 0;
    return true;
  }

  log("Falling back to browser re-login");
  const ok = await runReloginProcess();
  if (ok) {
    reloadSessionFromDisk();
    lastReloginAlertAt = 0;
    return true;
  }

  return false;
}

async function ensureFreshSession() {
  let expiresAt = null;
  try {
    expiresAt = tokenExpiresAt(loadSession().token);
  } catch (error) {
    log(`Session unreadable: ${error.message}`);
  }

  if (expiresAt && expiresAt - Date.now() > TOKEN_RENEW_MARGIN_MS) {
    return true;
  }

  log(
    expiresAt
      ? `Token expires at ${new Date(expiresAt).toISOString()}, renewing now`
      : "No valid token, attempting renewal"
  );

  if (await renewSession()) {
    log("Session renewed");
    return true;
  }

  await notifyReloginFailure("token refresh and browser re-login both failed (see watcher logs)");
  return false;
}

async function recoverFromExpiredSession(error) {
  log(`Session expired mid-run: ${error.message}`);
  if (await renewSession()) {
    log("Session renewed after expiry");
    return true;
  }

  await notifyReloginFailure(error.message);
  return false;
}

function describeRoutes() {
  return config.routes
    .map((route) => `${route.from}->${route.to}${route.scanAllPairs ? " (all pairs)" : ""} ${route.date}`)
    .join(", ");
}

/**
 * One tick: expand any `scanAllPairs` route into its station pairs, then check
 * them all with a bounded number in flight. Replaces the old round-robin, where
 * two routes on a 15s interval meant each was only seen every 30 seconds.
 */
async function scanAllRoutes() {
  const routes = await expandRoutes(config.routes);
  const state = loadState();
  const startedAt = Date.now();

  const results = await runPool(routes, config.scan, (route) => checkRoute(route, state));
  saveState(state);

  const expired = results.find((r) => !r.ok && r.error instanceof SessionExpiredError);
  if (expired) {
    throw expired.error;
  }

  const failed = results.filter((r) => !r.ok);
  const withSeats = results.filter((r) => r.ok && r.value.availableCount > 0).length;

  log(
    `Scanned ${routes.length} pair(s) in ${Date.now() - startedAt}ms ` +
      `— ${withSeats} with seats, ${failed.length} failed (concurrency ${config.scan.concurrency})`
  );

  for (const failure of failed.slice(0, 3)) {
    log(`  failure: ${failure.error.message}`);
  }
}

async function main() {
  const once = process.argv.includes("--once");

  if (once) {
    await runChecksOnce();
    return;
  }

  log(`Watcher started on ${os.hostname()} — ${config.routes.length} route(s): ${describeRoutes()}`);

  // Catch typos and dead dates up front instead of letting them look like
  // "0 seats available" for hours.
  for (const problem of validateRoutes(config.routes)) {
    log(`routes.json problem — ${problem}`);
  }

  try {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      `Ticket watcher started on ${os.hostname()} — ${config.routes.length} route(s): ${describeRoutes()}`
    );
  } catch (error) {
    log(`Startup Telegram message failed: ${error.message}`);
  }

  while (true) {
    let waitMs = config.pollIntervalSeconds * 1000;

    try {
      const sessionOk = await ensureFreshSession();
      if (sessionOk) {
        await scanAllRoutes();
      } else {
        waitMs = RELOGIN_RETRY_MS;
      }
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        if (!(await recoverFromExpiredSession(error))) {
          waitMs = RELOGIN_RETRY_MS;
        }
      } else {
        log(`Check failed: ${error.message}`);
      }
    }

    log(`Waiting ${Math.round(waitMs / 1000)} seconds before next cycle`);
    await sleep(waitMs);
  }
}

// Only run when started directly (`node src/index.js`). Without this guard a
// plain `require("./index")` — from a test or a health check — silently starts a
// second watcher, complete with its own re-login.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
