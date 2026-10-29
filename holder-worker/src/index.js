// Entry point of the holder-worker service. Asks the backend (over HTTPS, admin token) for the single active hold and
// runs it with a real Chrome. A deploy (SIGTERM) releases the seats and leaves the hold 'running', so the next worker
// resumes it. Only one worker may run at a time: it must keep renewing a lease held by the backend.
const os = require('os');
const { ChromeDriver } = require('./driver');
const { HoldRunner } = require('./hold-loop');
const { createApi, createWorkerClient, createSessionReader, createHoldStore } = require('./store');

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const k of ['BACKEND_URL', 'ADMIN_TOKEN', 'SESSION_ENCRYPTION_KEY']) if (!process.env[k]) throw new Error(`${k} is required`);
  const api = createApi({ baseUrl: process.env.BACKEND_URL, adminToken: process.env.ADMIN_TOKEN });
  const workerId = `${os.hostname()}-${process.pid}-${Date.now()}`;
  const client = createWorkerClient({ api, workerId });
  const sessionReader = createSessionReader({ api, keyB64: process.env.SESSION_ENCRYPTION_KEY });
  // Alerts go through the backend, which owns the push (FCM) and Telegram channels.
  const alertFn = ({ title, body, loginNeeded }) => api.call('POST', '/admin/hold-alert', { title, body, loginNeeded });

  let current = null;
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: releasing seats and handing the hold over`);
    if (current) current.runner.shuttingDown = true;
    setTimeout(() => process.exit(0), 60000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Wait for the lease (another worker may still be shutting down), then keep renewing it in the background.
  let announced = false;
  while (!stopping && !(await client.lease().catch(() => false))) {
    if (!announced) { log('another holder-worker owns the lease, or the backend is unreachable; waiting'); announced = true; }
    await sleep(5000);
  }
  const heartbeat = setInterval(async () => {
    try {
      if (!(await client.lease())) { log('the lease was taken by another worker: stepping down'); shutdown('lease lost'); }
    } catch { /* backend briefly unreachable: keep going, the lease lasts 45 s */ }
  }, 10000);
  heartbeat.unref();

  log('holder-worker up, waiting for a hold');
  while (!stopping) {
    let claimed = null;
    try {
      claimed = await client.claimNext();
    } catch (e) {
      log(`backend error: ${e.message}`);
    }
    if (!claimed) { await sleep(3000); continue; }

    const { hold } = claimed;
    log(`running hold ${hold.id}: ${hold.trainName} ${hold.seatNumbers || `x${hold.seatCount}`} until ${hold.stopAt || 'stopped'}`);
    const driver = new ChromeDriver({ hold, getSession: () => sessionReader.current(), log });
    const store = createHoldStore({ api, holdId: hold.id, sessionReader, alertFn, log });
    const runner = new HoldRunner({ hold, driver, store });
    current = { runner };
    try {
      const outcome = await runner.run();
      log(`hold ${hold.id} ended: ${outcome}`);
    } catch (e) {
      log(`hold ${hold.id} crashed: ${e.stack || e.message}`);
      await store.finish({ status: 'failed', error: e.message, interrupted: false }).catch(() => {});
    } finally {
      await driver.stop();
      current = null;
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
