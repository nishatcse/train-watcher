const express = require("express");
const { sha256, randomToken, pairingCode, safeEqual } = require("../lib/crypto");
const { HttpError, notFound, unauthorized, badRequest } = require("../lib/errors");
const { updateSettings, getSettings } = require("../services/settings");
const { extractAvailability } = require("../lib/availability");
const { isValidIso, isoToSite } = require("../lib/dates");

const PAIRING_TTL_MINUTES = 10;
const STATIONS_TTL_MS = 6 * 60 * 60 * 1000;
const CATALOG_STALE_MS = 48 * 60 * 60 * 1000;

function createApiRouter(deps) {
  const { db, sessions, watchers, holds, notifier, scheduler, shohoz, config, channels } = deps;
  const router = express.Router();
  const stationsCache = new Map();
  const pairAttempts = new Map(); // ip -> [timestamps]

  // ---------- auth ----------
  const requireAdmin = (req, _res, next) => {
    const token = req.get("x-admin-token");
    if (!token || !safeEqual(token, config.adminToken)) return next(unauthorized("Invalid admin token"));
    next();
  };

  const requireDevice = async (req, _res, next) => {
    const header = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return next(unauthorized("Missing device token"));
    const r = await db.query("select id, name from devices where device_token_hash = $1 and revoked_at is null", [sha256(match[1])]);
    if (!r.rows[0]) return next(unauthorized("This device is not paired (or was revoked)"));
    req.device = r.rows[0];
    // Record activity at most once a minute instead of writing on every request.
    db.query("update devices set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '1 minute')", [req.device.id]).catch(() => {});
    next();
  };

  // ---------- pairing ----------
  router.post("/admin/pairing-code", requireAdmin, async (_req, res) => {
    const code = pairingCode();
    const r = await db.query("insert into pairing_codes (code, expires_at) values ($1, now() + ($2 || ' minutes')::interval) returning expires_at", [code, String(PAIRING_TTL_MINUTES)]);
    res.json({ code, expiresAt: r.rows[0].expires_at, validMinutes: PAIRING_TTL_MINUTES });
  });

  router.post("/v1/pair", async (req, res) => {
    // Short-lived single-use code, plus a throttle so it cannot be guessed.
    const ip = req.ip || "unknown";
    const recent = (pairAttempts.get(ip) || []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= 8) throw new HttpError(429, "too_many_attempts", "Too many pairing attempts. Wait a minute.");
    pairAttempts.set(ip, [...recent, Date.now()]);

    const code = String((req.body && req.body.code) || "").trim().toUpperCase();
    if (!code) throw badRequest("A pairing code is required", { field: "code" });
    const claimed = await db.query("update pairing_codes set consumed_at = now() where code = $1 and consumed_at is null and expires_at > now() returning code", [code]);
    if (!claimed.rows[0]) throw unauthorized("That pairing code is invalid or has expired. Ask for a new one.");

    const token = randomToken(32);
    const name = String((req.body && req.body.deviceName) || "Android phone").slice(0, 80);
    const d = await db.query("insert into devices (name, device_token_hash) values ($1, $2) returning id", [name, sha256(token)]);
    res.status(201).json({ deviceToken: token, deviceId: d.rows[0].id });
  });

  // ---------- admin session upload (CLI fallback when the phone cannot log in) ----------
  // ---------- holder-worker API (admin token; the worker has no database access) ----------
  router.post("/admin/worker/lease", requireAdmin, async (req, res) => {
    if (!req.body?.workerId) throw badRequest("workerId is required");
    res.json(await holds.lease(String(req.body.workerId)));
  });
  router.post("/admin/worker/claim", requireAdmin, async (_req, res) => res.json(await holds.claim()));
  router.get("/admin/worker/session", requireAdmin, async (_req, res) => {
    const r = (await db.query("select blob_enc, updated_at from session where id = 1")).rows[0];
    // The blob stays encrypted: the worker has the key (SESSION_ENCRYPTION_KEY) and decrypts it itself.
    res.json({ blobEnc: r?.blob_enc || null, updatedAt: r?.updated_at || null });
  });
  router.get("/admin/worker/holds/:id/status", requireAdmin, async (req, res) => res.json(await holds.workerStatus(req.params.id)));
  router.post("/admin/worker/holds/:id/event", requireAdmin, async (req, res) => {
    await holds.workerEvent(req.params.id, req.body?.message);
    res.json({ ok: true });
  });
  router.post("/admin/worker/holds/:id/update", requireAdmin, async (req, res) => {
    await holds.workerUpdate(req.params.id, req.body || {});
    res.json({ ok: true });
  });
  router.post("/admin/worker/holds/:id/finish", requireAdmin, async (req, res) => {
    await holds.workerFinish(req.params.id, req.body || {});
    res.json({ ok: true });
  });

  // The holder-worker asks the backend (which owns push + Telegram) to tell the owner something about a hold.
  router.post("/admin/hold-alert", requireAdmin, async (req, res) => {
    const { title, body, loginNeeded } = req.body || {};
    if (!title || !body) throw badRequest("title and body are required");
    const sent = await notifier.dispatch({
      kind: "hold_attention",
      title: String(title).slice(0, 120),
      body: String(body).slice(0, 400),
      data: loginNeeded ? { action: "open_login" } : {},
    });
    res.json({ ok: true, channels: sent.channels });
  });

  router.post("/admin/session", requireAdmin, async (req, res) => {
    const status = await sessions.save(req.body, { source: "admin" });
    scheduler.wake();
    res.json(status);
  });

  // ---------- everything below needs a paired device ----------
  const v1 = express.Router();
  v1.use(requireDevice);

  v1.put("/device/fcm-token", async (req, res) => {
    const fcmToken = String((req.body && req.body.fcmToken) || "").trim();
    if (!fcmToken) throw badRequest("fcmToken is required", { field: "fcmToken" });
    await db.query("update devices set fcm_token = null where fcm_token = $1 and id <> $2", [fcmToken, req.device.id]);
    await db.query("update devices set fcm_token = $1 where id = $2", [fcmToken, req.device.id]);
    res.json({ ok: true });
  });

  v1.delete("/device", async (req, res) => {
    await db.query("update devices set revoked_at = now(), fcm_token = null where id = $1", [req.device.id]);
    res.json({ ok: true });
  });

  // ---------- catalog ----------
  v1.get("/catalog", async (_req, res) => {
    const c = (await db.query("select * from catalog_cache where id = 1")).rows[0];
    const cachedAt = c.cached_at ? new Date(c.cached_at) : null;
    res.json({
      cities: c.cities,
      trains: c.trains,
      classes: c.classes,
      searchDayLimit: c.search_day_limit,
      maxTicketsPerOrder: c.max_ticket_per_order,
      maintenance: c.maintenance,
      cachedAt,
      stale: !cachedAt || Date.now() - cachedAt.getTime() > CATALOG_STALE_MS,
    });
  });

  // Live stoppage list for a train: lets the app offer only stations the train really serves.
  v1.get("/trains/stations", async (req, res) => {
    const train = String(req.query.train || "");
    const date = String(req.query.date || "");
    const model = /\((\d+)\)/.exec(train)?.[1];
    if (!model) throw badRequest("train must look like 'TURNA (742)'", { field: "train" });
    if (!isValidIso(date)) throw badRequest("date must be YYYY-MM-DD", { field: "date" });

    const key = `${model}|${date}`;
    const hit = stationsCache.get(key);
    if (hit && Date.now() - hit.at < STATIONS_TTL_MS) return res.json({ train, stations: hit.stations, days: hit.days, cached: true });

    const info = await shohoz.fetchTrainRoute(model, date, { interactive: true });
    if (info.stations.length < 2) throw badRequest("The booking site returned no stations for that train and date.");
    stationsCache.set(key, { at: Date.now(), stations: info.stations, days: info.days });
    res.json({ train, stations: info.stations, days: info.days, cached: false });
  });

  // ---------- watchers ----------
  async function idempotent(req, res, handler) {
    const key = req.get("idempotency-key");
    if (!key) return handler();
    const hit = (await db.query("select status, response from idempotency_keys where device_id = $1 and key = $2", [req.device.id, key])).rows[0];
    if (hit) return res.status(hit.status).json(hit.response);
    const { status, body } = await handler(true);
    await db.query("insert into idempotency_keys (device_id, key, status, response) values ($1,$2,$3,$4) on conflict do nothing", [req.device.id, key, status, JSON.stringify(body)]);
    res.status(status).json(body);
  }

  v1.get("/watchers", async (_req, res) => res.json({ watchers: await watchers.list() }));

  v1.post("/watchers", async (req, res) => {
    await idempotent(req, res, async (capture) => {
      const result = await watchers.create(req.body || {});
      scheduler.wake();
      if (capture) return { status: 201, body: result };
      res.status(201).json(result);
    });
  });

  // One live search to confirm the journey is real before it is saved.
  v1.post("/watchers/verify", async (req, res) => {
    const input = watchers.parseInput(req.body || {});
    const trains = await shohoz.searchTrips(input, { interactive: true });
    const a = extractAvailability(trains, input);
    res.json({
      status: a.status,
      trainListed: a.status !== "train_not_listed",
      classOffered: a.status === "ok",
      availableSeats: a.availableCount,
      onlineSeats: a.onlineCount,
      counterSeats: a.offlineCount,
      trainsOnThisSearch: trains.map((t) => t.trip_number).filter(Boolean).slice(0, 60),
      journey: `${input.fromCity} → ${input.toCity}, ${isoToSite(input.journeyDate)}`,
    });
  });

  v1.get("/watchers/:id", async (req, res) => res.json({ watcher: await watchers.get(req.params.id) }));

  v1.patch("/watchers/:id", async (req, res) => {
    const result = await watchers.update(req.params.id, req.body || {});
    scheduler.wake();
    res.json(result);
  });

  v1.delete("/watchers/:id", async (req, res) => {
    await watchers.remove(req.params.id);
    res.json({ ok: true });
  });

  // ---------- seat holds (run by the holder-worker service) ----------
  v1.post("/holds", async (req, res) => {
    res.status(201).json(await holds.create(req.body || {}));
  });

  // The phone's own holder (not the server worker) tells the owner something about a hold: push + Telegram.
  v1.post("/holds/alert", async (req, res) => {
    const { title, body } = req.body || {};
    if (!title || !body) throw badRequest("title and body are required");
    const sent = await notifier.dispatch({
      kind: "hold_attention",
      title: String(title).slice(0, 120),
      body: String(body).slice(0, 400),
      data: {},
    });
    res.json({ ok: true, channels: sent.channels });
  });

  v1.get("/holds/current", async (_req, res) => res.json((await holds.current()) || { hold: null, events: [] }));

  v1.get("/holds/:id", async (req, res) => res.json(await holds.get(req.params.id)));

  v1.delete("/holds/:id", async (req, res) => res.json(await holds.requestStop(req.params.id)));

  // ---------- notification history ----------
  v1.get("/notifications", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const rows = (await db.query("select * from notifications_log order by created_at desc limit $1", [limit * 3])).rows;
    const byAlert = new Map();
    for (const r of rows) {
      const id = (r.payload && r.payload.alertId) || r.id;
      if (!byAlert.has(id)) {
        byAlert.set(id, { alertId: id, kind: r.kind, title: r.title, body: r.body, payload: r.payload, watcherId: r.watcher_id, createdAt: r.created_at, acknowledgedAt: r.acknowledged_at, channels: [] });
      }
      byAlert.get(id).channels.push({ channel: r.channel, status: r.delivery_status, attempts: r.attempts, lastError: r.last_error, sentAt: r.sent_at });
    }
    res.json({ notifications: [...byAlert.values()].slice(0, limit) });
  });

  v1.post("/notifications/:alertId/ack", async (req, res) => {
    await db.query("update notifications_log set acknowledged_at = now() where payload->>'alertId' = $1 and acknowledged_at is null", [req.params.alertId]);
    res.json({ ok: true });
  });

  // ---------- session ----------
  v1.post("/session", async (req, res) => {
    const status = await sessions.save(req.body, { source: "login" });
    scheduler.wake();
    res.json(status);
  });

  v1.get("/session/status", async (_req, res) => res.json(await sessions.status()));

  // ---------- settings ----------
  v1.get("/settings", async (_req, res) => res.json({ ...(await getSettings(db)), telegramConfigured: channels.telegram, pushConfigured: channels.fcm }));
  v1.patch("/settings", async (req, res) => res.json({ ...(await updateSettings(db, req.body || {})), telegramConfigured: channels.telegram, pushConfigured: channels.fcm }));

  // Goes through the real notification pipeline, so a green result means real alerts will arrive too.
  v1.post("/settings/test-alert", async (req, res) => {
    const which = String((req.body && req.body.channel) || "both");
    const only = which === "fcm" ? ["fcm"] : which === "telegram" ? ["telegram"] : null;
    const sent = await notifier.dispatch({
      kind: "test",
      title: "Test alert",
      body: "Route: Test → Test\nTrain: TEST EXPRESS\nJourney: today\nClass: TEST\nAvailable seats: 3\n\nIf you can hear this, alerts work.",
      data: { action: "open_booking", url: "https://eticket.railway.gov.bd", route: "Test → Test", trainName: "TEST EXPRESS", seatClass: "TEST", journeyDate: "today", seats: 3 },
      only,
      force: true,
    });
    await Promise.race([sent.done, new Promise((r) => setTimeout(r, 20000))]);
    const rows = (await db.query("select channel, delivery_status, attempts, last_error from notifications_log where payload->>'alertId' = $1", [sent.alertId])).rows;
    res.json({ alertId: sent.alertId, channels: rows.map((r) => ({ channel: r.channel, status: r.delivery_status, attempts: r.attempts, error: r.last_error })), configured: channels });
  });

  // ---------- dashboard status ----------
  v1.get("/status", async (_req, res) => {
    const [engine, counts, devices, settings] = await Promise.all([
      db.query("select * from engine_state where id = 1"),
      db.query(`select count(*)::int as total, count(*) filter (where enabled)::int as active,
                  count(*) filter (where s.available_count > 0)::int as with_seats
                from watchers w left join availability_state s on s.watcher_id = w.id`),
      db.query("select count(*)::int as n from devices where revoked_at is null"),
      getSettings(db),
    ]);
    const e = engine.rows[0];
    const paused = shohoz.state.pausedUntil > Date.now() ? new Date(shohoz.state.pausedUntil).toISOString() : null;
    res.json({
      serverTime: new Date().toISOString(),
      engine: {
        cycleRunning: scheduler.live.cycleRunning,
        nextCycleAt: scheduler.live.nextCycleAt,
        skipReason: scheduler.live.lastSkipReason,
        lastCycleAt: e.last_cycle_finished_at,
        lastCycleMs: e.last_cycle_ms,
        lastCycleTargets: e.last_cycle_targets,
        lastCycleFailed: e.last_cycle_failed,
        lastError: e.last_error,
        rateLimitedUntil: paused,
        cycleSeconds: settings.scanCycleSeconds,
      },
      session: await sessions.status(),
      watchers: { total: counts.rows[0].total, active: counts.rows[0].active, withSeats: counts.rows[0].with_seats },
      channels: { ...channels, pairedDevices: devices.rows[0].n },
    });
  });

  router.use("/v1", v1);
  return router;
}

module.exports = { createApiRouter };
