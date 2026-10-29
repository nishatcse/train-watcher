// The worker's view of the backend. It runs in a different Railway account from the backend and has NO database
// access: everything goes over HTTPS to /admin/worker/* with the admin token. The railway session arrives still
// encrypted and is decrypted here with SESSION_ENCRYPTION_KEY.
const crypto = require('crypto');

function decrypt(blob, keyB64) {
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  if (key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes, base64');
  const [version, iv, tag, data] = String(blob).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised encrypted blob');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON over HTTPS with the admin token. Retries network errors and 5xx (a redeploy of the backend must not kill a hold). */
function createApi({ baseUrl, adminToken, fetchFn = fetch, retries = 3, backoffMs = 500 }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  async function call(method, path, body) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetchFn(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        if (res.status >= 500) throw Object.assign(new Error(`backend answered ${res.status}`), { retryable: true });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), { status: res.status });
        return json;
      } catch (e) {
        lastError = e;
        if (e.status && e.status < 500) throw e; // a real answer (401, 422): retrying will not change it
        if (attempt < retries) await sleep(backoffMs * attempt);
      }
    }
    throw lastError;
  }
  return { call };
}

/** One worker process: the lease (only one worker may hold seats) and picking up the active hold. */
function createWorkerClient({ api, workerId }) {
  return {
    /** true while this worker owns the lease. Renew every few seconds. */
    async lease() {
      return (await api.call('POST', '/admin/worker/lease', { workerId })).ok === true;
    },
    /** The single active hold (queued -> running, or a running one left behind by a restarted worker), or null. */
    async claimNext() {
      const r = await api.call('POST', '/admin/worker/claim', {});
      return r.hold ? { hold: r.hold, resumed: Boolean(r.resumed) } : null;
    },
  };
}

function createSessionReader({ api, keyB64 }) {
  let seen = null; // updatedAt of the session last handed out
  return {
    async current() {
      const r = await api.call('GET', '/admin/worker/session');
      if (!r.blobEnc) return null;
      seen = String(r.updatedAt);
      return JSON.parse(decrypt(r.blobEnc, keyB64));
    },
    /** True when the phone has pushed a newer login than the one the browser was started with. */
    async changed() {
      const r = await api.call('GET', '/admin/worker/session');
      return Boolean(r.blobEnc && String(r.updatedAt) !== seen);
    },
  };
}

function createHoldStore({ api, holdId, sessionReader, alertFn, log = () => {}, now = Date.now, stopCheckMs = 2000 }) {
  const base = `/admin/worker/holds/${encodeURIComponent(holdId)}`;
  let stopCache = { at: 0, value: false };
  return {
    // Progress reporting must never take a hold down: a failed post is logged and the loop carries on.
    async event(message) {
      log(message);
      try { await api.call('POST', `${base}/event`, { message: String(message).slice(0, 500) }); } catch (e) { log(`event not saved: ${e.message}`); }
    },
    async update(fields) {
      try { await api.call('POST', `${base}/update`, fields); } catch (e) { log(`update not saved: ${e.message}`); }
    },
    async shouldStop() {
      if (now() - stopCache.at < stopCheckMs) return stopCache.value;
      try {
        const { status } = await api.call('GET', `${base}/status`);
        stopCache = { at: now(), value: !status || status === 'stopping' || status === 'stopped' };
      } catch {
        stopCache = { at: now(), value: false }; // cannot tell: keep holding
      }
      return stopCache.value;
    },
    async alert(title, body, loginNeeded = false) {
      try { await alertFn({ title, body, loginNeeded }); } catch (e) { log(`alert failed: ${e.message}`); }
    },
    sessionChanged: () => sessionReader.changed().catch(() => false),
    /** `interrupted`: the process is being stopped (deploy); the hold stays 'running' so the next worker resumes it. */
    async finish({ status, error, interrupted }) {
      await api.call('POST', `${base}/finish`, { status, error, interrupted: Boolean(interrupted) });
    },
  };
}

module.exports = { createApi, createWorkerClient, createSessionReader, createHoldStore, decrypt };
