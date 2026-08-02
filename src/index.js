const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("./config");
const { runChecksOnce, checkRoute, loadState } = require("./checker");
const { SessionExpiredError } = require("./api-client");
const { loadSession, reloadSessionFromDisk, tokenExpiresAt } = require("./session");
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
      : "No valid token, attempting re-login"
  );

  const ok = await runReloginProcess();
  if (ok) {
    reloadSessionFromDisk();
    lastReloginAlertAt = 0;
    log("Session renewed");
    return true;
  }

  await notifyReloginFailure("re-login script exited with an error (see watcher logs)");
  return false;
}

async function recoverFromExpiredSession(error) {
  log(`Session expired mid-run: ${error.message}`);
  const ok = await runReloginProcess();
  if (ok) {
    reloadSessionFromDisk();
    lastReloginAlertAt = 0;
    log("Session renewed after expiry");
    return true;
  }

  await notifyReloginFailure(error.message);
  return false;
}

function describeRoutes() {
  return config.routes.map((route) => `${route.from}->${route.to} ${route.date}`).join(", ");
}

async function main() {
  const once = process.argv.includes("--once");

  if (once) {
    await runChecksOnce();
    return;
  }

  log(`Watcher started on ${os.hostname()} — ${config.routes.length} route(s): ${describeRoutes()}`);

  try {
    await sendTelegramMessage(
      config.telegramBotToken,
      config.telegramChatId,
      `Ticket watcher started on ${os.hostname()} — ${config.routes.length} route(s): ${describeRoutes()}`
    );
  } catch (error) {
    log(`Startup Telegram message failed: ${error.message}`);
  }

  let routeIndex = 0;

  while (true) {
    const route = config.routes[routeIndex];
    let waitMs = config.pollIntervalSeconds * 1000;
    let advance = true;

    try {
      const sessionOk = await ensureFreshSession();
      if (sessionOk) {
        await checkRoute(route, loadState());
      } else {
        waitMs = RELOGIN_RETRY_MS;
        advance = false;
      }
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        const recovered = await recoverFromExpiredSession(error);
        if (recovered) {
          // retry the same route on the next tick instead of skipping it
          advance = false;
        } else {
          waitMs = RELOGIN_RETRY_MS;
          advance = false;
        }
      } else {
        log(`Check failed: ${error.message}`);
      }
    }

    if (advance) {
      routeIndex = (routeIndex + 1) % config.routes.length;
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
