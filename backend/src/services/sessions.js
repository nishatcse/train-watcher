const { tokenExpiresAt } = require("../lib/jwt");
const { encrypt, decrypt } = require("../lib/crypto");
const { buildCatalog } = require("../lib/catalog");
const { ValidationError } = require("./settings");

const MARGIN_MS = 30 * 60 * 1000;      // start trying to renew / warn this long before expiry
const FINAL_WARNING_MS = 5 * 60 * 1000; // the "about five minutes left" alert
const REFRESH_RETRY_MS = 2 * 60 * 1000;
const EXPIRED_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Session lifecycle: active -> expiring_soon -> expired_awaiting_relogin.
 * Headless refresh is best-effort only. Only a browser login by the owner yields a
 * booking-valid session with no refresh token, so a login roughly every 12h is the
 * NORMAL steady state, and the owner is told in time (30 and 5 minutes before).
 */
function createSessions({ db, keyB64, notifier = null, now = Date.now, log = () => {} }) {
  let refresher = null;
  let cache = null; // decrypted session; dropped whenever the stored one changes

  const row = async () => (await db.query("select * from session where id = 1")).rows[0];

  async function get() {
    if (cache) return cache;
    const r = await row();
    if (!r.blob_enc) return null;
    cache = JSON.parse(decrypt(r.blob_enc, keyB64));
    return cache;
  }

  async function writeCatalog(handshakeData) {
    if (!handshakeData) return;
    const c = buildCatalog(handshakeData);
    await db.query(
      `update catalog_cache set cities=$1, trains=$2, classes=$3, search_day_limit=$4,
         max_ticket_per_order=$5, maintenance=$6, cached_at=now() where id=1`,
      [JSON.stringify(c.cities), JSON.stringify(c.trains), JSON.stringify(c.classes), c.searchDayLimit, c.maxTicketsPerOrder, c.maintenance]
    );
  }

  async function save(blob, { source = "login" } = {}) {
    if (!blob || typeof blob !== "object") throw new ValidationError("Session body is required");
    for (const field of ["token", "ssdk", "uudid"]) {
      if (typeof blob[field] !== "string" || !blob[field]) throw new ValidationError(`Session is missing "${field}"`);
    }
    const exp = tokenExpiresAt(blob.token);
    if (!exp) throw new ValidationError("The token is not a valid JWT");
    if (exp <= now()) throw new ValidationError("That session has already expired. Log in again and retry.");

    const payload = { token: blob.token, ssdk: blob.ssdk, uudid: blob.uudid, user: blob.user ?? null, refresh_token: blob.refresh_token || null };
    const nextStatus = exp - now() <= MARGIN_MS ? "expiring_soon" : "active";
    await db.query(
      `update session set blob_enc=$1, has_refresh=$2, token_expires_at=$3, status=$4,
         last_relogin_at = case when $5 = 'refresh' then last_relogin_at else now() end,
         warned_30_at=null, warned_5_at=null, expired_alert_at=null, updated_at=now() where id=1`,
      [encrypt(JSON.stringify(payload), keyB64), Boolean(payload.refresh_token), new Date(exp), nextStatus, source]
    );
    cache = payload;
    await writeCatalog(blob.handshake_data);
    log(`session saved (${source}); expires ${new Date(exp).toISOString()}`);
    return status();
  }

  async function status() {
    const r = await row();
    const catalog = (await db.query("select cached_at from catalog_cache where id = 1")).rows[0];
    const exp = r.token_expires_at ? new Date(r.token_expires_at).getTime() : null;
    let current = r.status;
    if (r.blob_enc && exp && exp <= now()) current = "expired_awaiting_relogin";
    return {
      status: current,
      expiresAt: exp ? new Date(exp).toISOString() : null,
      secondsLeft: exp ? Math.max(0, Math.round((exp - now()) / 1000)) : null,
      hasRefreshToken: r.has_refresh,
      lastReloginAt: r.last_relogin_at,
      catalogCachedAt: catalog.cached_at,
    };
  }

  async function setStatus(value) {
    await db.query("update session set status=$1, updated_at=now() where id=1", [value]);
  }

  async function alertExpired(reason) {
    const r = await row();
    if (r.expired_alert_at && now() - new Date(r.expired_alert_at).getTime() < EXPIRED_ALERT_EVERY_MS) return;
    await db.query("update session set expired_alert_at=now() where id=1");
    if (notifier) {
      await notifier.dispatch({
        kind: "session_expired",
        title: "Railway login required",
        body: `${reason}\nSeat monitoring is paused. Open the Train Watcher app and log in to resume.`,
        data: { action: "open_login" },
      });
    }
  }

  async function markExpired(reason) {
    await setStatus("expired_awaiting_relogin");
    await alertExpired(reason);
  }

  async function tryRefresh() {
    if (!refresher) return false;
    const r = await row();
    if (!r.has_refresh) return false;
    if (r.last_refresh_attempt_at && now() - new Date(r.last_refresh_attempt_at).getTime() < REFRESH_RETRY_MS) return false;
    await db.query("update session set last_refresh_attempt_at=now() where id=1");
    const current = await get();
    const renewed = await refresher(current);
    if (!renewed) return false;
    await save({ ...current, ...renewed }, { source: "refresh" });
    return true;
  }

  async function warn(secondsLeft, which) {
    const minutes = Math.max(1, Math.round(secondsLeft / 60));
    await db.query(`update session set ${which}=now() where id=1`);
    if (notifier) {
      await notifier.dispatch({
        kind: "session_expiring",
        title: "Railway login expires soon",
        body: `The Railway session expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.\nOpen the Train Watcher app and log in to keep monitoring.`,
        data: { action: "open_login" },
      });
    }
  }

  /** Called at the top of every scan cycle. Returns { usable }. */
  async function ensureUsable() {
    const r = await row();
    if (!r.blob_enc || !r.token_expires_at) {
      await markExpired("No Railway session is stored yet.");
      return { usable: false, reason: "no_session" };
    }
    const exp = new Date(r.token_expires_at).getTime();
    const left = exp - now();

    if (left > MARGIN_MS) {
      if (r.status !== "active") await setStatus("active");
      return { usable: true };
    }

    if (await tryRefresh()) return { usable: true, refreshed: true };

    if (left <= 0) {
      await markExpired("The Railway session has expired.");
      return { usable: false, reason: "expired" };
    }

    if (r.status !== "expiring_soon") await setStatus("expiring_soon");
    if (left <= FINAL_WARNING_MS) {
      if (!r.warned_5_at) await warn(left / 1000, "warned_5_at");
    } else if (!r.warned_30_at) {
      await warn(left / 1000, "warned_30_at");
    }
    return { usable: true, expiringSoon: true };
  }

  /** The booking site returned 401/403 mid-scan: renew once, else pause and ask the owner. */
  async function handleRejected() {
    cache = null;
    if (await tryRefresh()) return { usable: true, refreshed: true };
    await markExpired("The booking site rejected the session.");
    return { usable: false };
  }

  return {
    attach: ({ refreshToken }) => {
      refresher = refreshToken;
    },
    get,
    save,
    status,
    ensureUsable,
    handleRejected,
    invalidateCache: () => {
      cache = null;
    },
  };
}

module.exports = { createSessions, MARGIN_MS, FINAL_WARNING_MS };
