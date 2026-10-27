const { runPool, groupTargets } = require("./lib/pool");
const { extractAvailability, shouldNotify, describe } = require("./lib/availability");
const { todayDhaka, daysBetween } = require("./lib/dates");
const { SessionExpiredError, RateLimitedError } = require("./lib/shohoz");

const IDLE_MS = 30000;             // nothing to scan, or waiting for a login
const DB_DOWN_ALERT_EVERY_MS = 30 * 60 * 1000;

/**
 * One cycle scans every unique search target through a bounded pool, then sleeps
 * for the configured gap (gap-based, never overlapping, like the proven Pi loop).
 * Watchers on the same route/date/class share a single request.
 */
function createScheduler({ db, shohoz, sessions, notifier, watchers, getSettings, getSearchDayLimit, directAlert = null, log = () => {}, sleepFn = null }) {
  let running = false;
  let loopPromise = null;
  let wakeUp = null;
  let timer = null;
  let lastDbAlertAt = 0;
  const live = { cycleRunning: false, nextCycleAt: null, lastSkipReason: null };

  const interruptibleSleep = (ms) =>
    new Promise((resolve) => {
      live.nextCycleAt = new Date(Date.now() + ms).toISOString();
      timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /** Edge-triggered decision and state write happen in ONE transaction: the single source of truth for "should we alert". */
  async function applyResult(w, a) {
    const notify = await db.tx(async (tx) => {
      const prev = (await tx.query("select available_count from availability_state where watcher_id = $1 for update", [w.id])).rows[0];
      const decision = shouldNotify(prev ? { availableCount: prev.available_count } : null, a);
      await tx.query(
        `insert into availability_state (watcher_id, available_count, online_count, offline_count, fare, total_fare, checked_at)
         values ($1,$2,$3,$4,$5,$6,now())
         on conflict (watcher_id) do update set available_count=$2, online_count=$3, offline_count=$4, fare=$5, total_fare=$6, checked_at=now()`,
        [w.id, a.availableCount, a.onlineCount, a.offlineCount, a.fare, a.totalFare]
      );
      await tx.query("update watchers set last_check_status=$2, last_checked_at=now(), last_error=null where id=$1", [w.id, a.status]);
      return decision;
    });

    if (notify) {
      const d = describe(w, a);
      await notifier.dispatch({
        kind: "seat_available",
        watcherId: w.id,
        title: d.title,
        body: d.body,
        data: {
          action: "open_booking",
          url: d.url,
          route: d.route,
          trainName: w.trainName,
          seatClass: w.seatClass,
          journeyDate: w.journeyDate,
          seats: a.availableCount,
        },
      });
      log(`seat alert sent: ${w.fromCity}->${w.toCity} ${w.journeyDate} ${w.trainName} ${w.seatClass} (${a.availableCount})`);
    }
  }

  async function scanTarget(target) {
    let trains;
    try {
      trains = await shohoz.searchTrips(target);
    } catch (error) {
      if (error instanceof SessionExpiredError) throw error;
      const status = error instanceof RateLimitedError ? "rate_limited" : "error";
      for (const w of target.watchers) {
        await db.query("update watchers set last_check_status=$2, last_checked_at=now(), last_error=$3 where id=$1", [w.id, status, String(error.message).slice(0, 300)]);
      }
      throw error;
    }
    for (const w of target.watchers) {
      await applyResult(w, extractAvailability(trains, w));
    }
  }

  async function recordCycle(fields) {
    await db.query(
      `update engine_state set last_cycle_started_at=$1, last_cycle_finished_at=now(), last_cycle_ms=$2,
         last_cycle_targets=$3, last_cycle_failed=$4, last_error=$5, updated_at=now() where id=1`,
      [fields.startedAt, fields.ms, fields.targets, fields.failed, fields.lastError]
    );
  }

  async function runCycle() {
    const startedAt = new Date();
    const settings = await getSettings();
    const today = todayDhaka();

    // A journey that has already happened has nothing left to watch.
    await db.query("update watchers set enabled=false, last_check_status='journey_passed', updated_at=now() where enabled and journey_date < $1", [today]);

    const all = await watchers.listEnabled();
    if (!all.length) {
      live.lastSkipReason = "no_watchers";
      return { skipped: "no_watchers", waitMs: IDLE_MS };
    }

    const gate = await sessions.ensureUsable();
    if (!gate.usable) {
      live.lastSkipReason = gate.reason || "session";
      return { skipped: gate.reason || "session", waitMs: IDLE_MS };
    }
    live.lastSkipReason = null;

    // Don't spend a request on a journey the site won't sell yet.
    const limit = await getSearchDayLimit();
    const open = [];
    for (const w of all) {
      if (limit && daysBetween(today, w.journeyDate) > limit) {
        await db.query("update watchers set last_check_status='not_open_yet', last_checked_at=now(), last_error=null where id=$1", [w.id]);
      } else {
        open.push(w);
      }
    }

    const targets = groupTargets(open);
    const t0 = Date.now();
    const results = await runPool(targets, { concurrency: settings.scanConcurrency, jitterMs: settings.scanJitterMs }, scanTarget);

    const expired = results.find((r) => !r.ok && r.error instanceof SessionExpiredError);
    if (expired) await sessions.handleRejected();

    const failed = results.filter((r) => !r.ok);
    const real = failed.filter((r) => !(r.error instanceof SessionExpiredError));
    const lastError = real.length ? String(real[0].error.message).slice(0, 300) : null;
    await recordCycle({ startedAt, ms: Date.now() - t0, targets: targets.length, failed: failed.length, lastError });
    log(`cycle: ${targets.length} target(s), ${failed.length} failed, ${Date.now() - t0}ms`);

    return { targets: targets.length, failed: failed.length, waitMs: settings.scanCycleSeconds * 1000 };
  }

  async function onCycleError(error) {
    log(`cycle crashed: ${error.message}`);
    // If the database itself is unreachable we cannot read settings or log rows,
    // so say so over Telegram directly (its credentials live in env vars, not the DB).
    let dbUp = true;
    try {
      await db.query("select 1");
    } catch {
      dbUp = false;
    }
    if (!dbUp && directAlert && Date.now() - lastDbAlertAt > DB_DOWN_ALERT_EVERY_MS) {
      lastDbAlertAt = Date.now();
      directAlert("Train Watcher: the database is unreachable. Seat monitoring is paused until it comes back.").catch((e) => log(`direct alert failed: ${e.message}`));
    }
  }

  async function loop() {
    while (running) {
      let waitMs = IDLE_MS;
      live.cycleRunning = true;
      try {
        const r = await runCycle();
        waitMs = r.waitMs;
      } catch (error) {
        await onCycleError(error);
      }
      live.cycleRunning = false;
      if (!running) break;
      await (sleepFn ? sleepFn(waitMs) : interruptibleSleep(waitMs));
    }
  }

  return {
    runCycle,
    live,
    start() {
      if (running) return;
      running = true;
      loopPromise = loop();
    },
    /** Cut the current sleep short (a fresh session just arrived, or a watcher was added). */
    wake() {
      if (wakeUp) wakeUp();
    },
    async stop() {
      running = false;
      if (wakeUp) wakeUp();
      await loopPromise;
    },
  };
}

module.exports = { createScheduler };
