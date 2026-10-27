const crypto = require("crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two independent channels. Each alert gets one log row per channel and is retried
 * on its own, so a Telegram outage never blocks the push (or the other way round).
 * `dispatch` returns as soon as the rows exist; delivery continues in the background
 * and the returned `done` promise lets tests (and the test-alert endpoint) wait on it.
 */
function createNotifier({ db, fcm, telegram, getSettings, log = () => {}, backoffsMs = [0, 15000, 60000], sleepFn = sleep }) {
  async function activeDevices() {
    return (await db.query("select id, fcm_token from devices where revoked_at is null and fcm_token is not null")).rows;
  }

  async function insertRow({ watcherId, kind, channel, title, body, payload }) {
    const r = await db.query(
      `insert into notifications_log (watcher_id, kind, channel, title, body, payload)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [watcherId, kind, channel, title, body, JSON.stringify(payload)]
    );
    return r.rows[0].id;
  }

  async function sendFcm(row) {
    const devices = await activeDevices();
    if (!devices.length) throw Object.assign(new Error("No paired device has a push token yet"), { retryable: false });
    let delivered = 0;
    let lastError = null;
    for (const device of devices) {
      try {
        await fcm.send(device.fcm_token, { ...row.payload, title: row.title, body: row.body, type: row.kind, notificationId: row.id });
        delivered += 1;
      } catch (error) {
        lastError = error;
        if (error.unregistered) {
          // The phone reinstalled or rotated tokens; stop sending to the dead one.
          await db.query("update devices set fcm_token = null where id = $1", [device.id]);
        }
      }
    }
    if (!delivered) throw Object.assign(lastError || new Error("FCM delivery failed"), { retryable: !(lastError && lastError.unregistered) });
  }

  async function sendTelegram(row) {
    const link = row.payload.url ? `\n\nBook (manually): ${row.payload.url}` : "";
    await telegram.send(`${row.title}\n\n${row.body}${link}`);
  }

  async function deliver(row) {
    const send = row.channel === "fcm" ? sendFcm : sendTelegram;
    for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
      if (backoffsMs[attempt] > 0) await sleepFn(backoffsMs[attempt]);
      try {
        await send(row);
        await db.query("update notifications_log set delivery_status='sent', attempts=$2, sent_at=now(), last_error=null where id=$1", [row.id, attempt + 1]);
        return "sent";
      } catch (error) {
        const final = attempt === backoffsMs.length - 1 || error.retryable === false;
        await db.query("update notifications_log set attempts=$2, last_error=$3, delivery_status=$4 where id=$1", [
          row.id,
          attempt + 1,
          String(error.message).slice(0, 300),
          final ? "failed" : "pending",
        ]);
        log(`${row.channel} delivery attempt ${attempt + 1} failed: ${error.message}`);
        if (final) return "failed";
      }
    }
    return "failed";
  }

  return {
    // `only` limits channels (used by "send test alert"); `force` ignores the enable toggles so a
    // test can prove a channel works even while it is switched off.
    async dispatch({ kind, watcherId = null, title, body, data = {}, only = null, force = false }) {
      const settings = await getSettings();
      const alertId = crypto.randomUUID();
      const payload = { ...data, alertId };
      const channels = [];
      const wanted = (channel) => !only || only.includes(channel);
      if (telegram && wanted("telegram") && (force || settings.telegramEnabled)) channels.push("telegram");
      if (fcm && wanted("fcm") && (force || settings.fcmEnabled)) channels.push("fcm");

      const rows = [];
      for (const channel of channels) {
        const id = await insertRow({ watcherId, kind, channel, title, body, payload });
        rows.push({ id, channel, kind, title, body, payload });
      }
      const done = Promise.all(rows.map((row) => deliver(row).catch((error) => log(`deliver crashed: ${error.message}`))));
      return { alertId, rowIds: rows.map((r) => r.id), channels, done };
    },

    /** After a restart, finish deliveries that were still pending. */
    async resumePending() {
      const pending = (
        await db.query(
          `select id, kind, channel, title, body, payload from notifications_log
           where delivery_status = 'pending' and created_at > now() - interval '15 minutes'`
        )
      ).rows;
      for (const row of pending) deliver(row).catch((error) => log(`resume crashed: ${error.message}`));
      return pending.length;
    },
  };
}

module.exports = { createNotifier };
