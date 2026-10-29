const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApi, createWorkerClient, createSessionReader, createHoldStore } = require('../src/store');

const KEY = Buffer.alloc(32, 7).toString('base64');
function encrypt(plain) { // same format as backend/src/lib/crypto.js
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

let server, base;
const requests = [];
const script = { status: 'running', failNext: 0, session: { blobEnc: null, updatedAt: null }, lease: true, claim: { hold: null } };

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, token: req.headers['x-admin-token'], body: body ? JSON.parse(body) : undefined });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers['x-admin-token'] !== 'secret') return send(401, { error: { message: 'Invalid admin token' } });
      if (script.failNext > 0) { script.failNext -= 1; return send(503, {}); }
      if (req.url === '/admin/worker/lease') return send(200, { ok: script.lease });
      if (req.url === '/admin/worker/claim') return send(200, script.claim);
      if (req.url === '/admin/worker/session') return send(200, script.session);
      if (/\/status$/.test(req.url)) return send(200, { status: script.status });
      if (req.url === '/admin/worker/holds/bad/update') return send(422, { error: { message: 'nope' } });
      return send(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = () => createApi({ baseUrl: base, adminToken: 'secret', backoffMs: 1 });

test('requests carry the admin token; a 5xx is retried, a 4xx is not', async () => {
  requests.length = 0;
  script.failNext = 2;
  assert.deepEqual(await api().call('POST', '/admin/worker/lease', { workerId: 'w' }), { ok: true });
  assert.equal(requests.length, 3, 'two 503s, then success');
  assert.ok(requests.every((r) => r.token === 'secret'));

  requests.length = 0;
  await assert.rejects(createApi({ baseUrl: base, adminToken: 'wrong', backoffMs: 1 }).call('GET', '/admin/worker/session'), /Invalid admin token/);
  assert.equal(requests.length, 1, 'a 401 is final');
  await assert.rejects(api().call('POST', '/admin/worker/holds/bad/update', {}), /nope/);
});

test('the lease and the claim', async () => {
  const c = createWorkerClient({ api: api(), workerId: 'w1' });
  script.lease = true;
  assert.equal(await c.lease(), true);
  script.lease = false;
  assert.equal(await c.lease(), false);
  script.claim = { hold: null };
  assert.equal(await c.claimNext(), null);
  script.claim = { hold: { id: 'h1', trainName: 'TURNA (741)' }, resumed: true };
  assert.deepEqual(await c.claimNext(), { hold: { id: 'h1', trainName: 'TURNA (741)' }, resumed: true });
});

test('the session comes encrypted and is decrypted here; a newer login is noticed', async () => {
  const reader = createSessionReader({ api: api(), keyB64: KEY });
  script.session = { blobEnc: null, updatedAt: null };
  assert.equal(await reader.current(), null);
  assert.equal(await reader.changed(), false);
  script.session = { blobEnc: encrypt(JSON.stringify({ token: 't1', ssdk: 's', uudid: 'u' })), updatedAt: '2026-10-29T01:00:00.000Z' };
  assert.equal((await reader.current()).token, 't1');
  assert.equal(await reader.changed(), false, 'same login as the browser was started with');
  script.session = { blobEnc: encrypt(JSON.stringify({ token: 't2' })), updatedAt: '2026-10-29T09:00:00.000Z' };
  assert.equal(await reader.changed(), true, 'a new login arrived');
  const wrongKey = createSessionReader({ api: api(), keyB64: Buffer.alloc(32, 1).toString('base64') });
  await assert.rejects(wrongKey.current());
});

test('hold store: events, updates and finish go to the hold\'s own endpoints', async () => {
  const store = createHoldStore({ api: api(), holdId: 'h 1', sessionReader: { changed: async () => false }, alertFn: async () => {} });
  requests.length = 0;
  await store.event('Held 2/2');
  await store.update({ phase: 'holding', held_seats: ['KA-1'] });
  await store.finish({ status: 'finished', error: null, interrupted: false });
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
    'POST /admin/worker/holds/h%201/event', 'POST /admin/worker/holds/h%201/update', 'POST /admin/worker/holds/h%201/finish',
  ]);
  assert.deepEqual(requests[0].body, { message: 'Held 2/2' });
  assert.deepEqual(requests[1].body, { phase: 'holding', held_seats: ['KA-1'] });
});

test('hold store: progress reporting never throws, even when the backend is down', async () => {
  const dead = createApi({ baseUrl: 'http://127.0.0.1:1', adminToken: 'secret', retries: 1, backoffMs: 1 });
  const logs = [];
  const store = createHoldStore({ api: dead, holdId: 'h1', sessionReader: { changed: async () => false }, alertFn: async () => { throw new Error('no push'); }, log: (m) => logs.push(m) });
  await store.event('x');
  await store.update({ phase: 'holding' });
  await store.alert('t', 'b');
  assert.equal(await store.shouldStop(), false, 'cannot tell: keep holding');
  assert.equal(await store.sessionChanged(), false);
  assert.ok(logs.some((l) => /not saved/.test(l)) && logs.some((l) => /alert failed/.test(l)));
});

test('hold store: Stop is noticed, and the check is cached for two seconds', async () => {
  let t = 1_000_000;
  const store = createHoldStore({ api: api(), holdId: 'h1', sessionReader: { changed: async () => false }, alertFn: async () => {}, now: () => t });
  script.status = 'running';
  requests.length = 0;
  assert.equal(await store.shouldStop(), false);
  assert.equal(await store.shouldStop(), false);
  assert.equal(requests.length, 1, 'cached: one request for two checks');
  script.status = 'stopping';
  t += 2500;
  assert.equal(await store.shouldStop(), true);
  assert.equal(requests.length, 2);
  script.status = 'stopped';
  t += 2500;
  assert.equal(await store.shouldStop(), true);
});
