const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HoldRunner, parseBlockedUntil } = require('../src/hold-loop');

/** Virtual time: sleeping just moves the clock, so a 6-minute hold takes microseconds. */
function makeWorld(holdOverrides = {}, script = {}) {
  const clock = { t: Date.UTC(2026, 10, 1, 0, 0, 0) };
  const calls = []; // ordered log of everything the loop did to the page
  const events = [];
  const store = {
    events, updates: [], alerts: [], finished: null,
    stop: false, sessionChange: false,
    event: async (m) => { events.push(m); },
    update: async (f) => { store.updates.push(f); },
    shouldStop: async () => store.stop,
    alert: async (title, body, loginNeeded) => { store.alerts.push({ title, loginNeeded }); },
    sessionChanged: async () => store.sessionChange,
    finish: async (f) => { store.finished = f; },
  };
  const page = { selected: [], inGrid: true, login: false };
  const driver = {
    onNet: null,
    online: async () => (script.online ? script.online(clock.t) : true),
    openGrid: async (cfg) => { calls.push(['open', clock.t]); return script.openGrid ? script.openGrid(calls) : { ok: true }; },
    readPage: async () => ({ ...page, selected: [...page.selected] }),
    restart: async () => { calls.push(['restart', clock.t]); },
    ...(script.probe ? { probe: async () => { calls.push(['probe', clock.t]); return script.probe(calls); } } : {}),
    selectSeats: async (args) => {
      calls.push(['select', clock.t, args.targets.join(',')]);
      if (script.select) return script.select(args, page, driver, clock, calls);
      const taken = args.targets.length ? args.targets : ['KA-1', 'KA-2'].slice(0, args.maxCount);
      page.selected = [...taken];
      return { seats: [...taken], wanted: taken.length, failed: [], unavailable: [] };
    },
    seatStates: async (names) => {
      calls.push(['states', clock.t, names.join(',')]);
      return script.seatStates ? script.seatStates(names, calls) : Object.fromEntries(names.map((n) => [n, 'available']));
    },
    unselectSeats: async () => {
      calls.push(['unselect', clock.t]);
      if (script.unselect) return script.unselect(page, calls, clock);
      const was = [...page.selected];
      page.selected = [];
      return { seats: was, wanted: was.length, failed: [] };
    },
  };
  const hold = { id: 'h1', trainName: 'TURNA (741)', seatClass: 'S_CHAIR', bogieName: 'KA', seatNumbers: 'KA-1,KA-2', seatCount: 2, holdSeconds: 375, stopAt: null, blockedUntil: null, ...holdOverrides };
  const runner = new HoldRunner({ hold, driver, store, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
  return { runner, store, driver, calls, events, clock, page };
}

const kinds = (calls) => calls.map((c) => c[0]);

test('select, hold 375 s, release, select again, until the end time; seats are released at the end', async () => {
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 20, 0)).toISOString() });
  const outcome = await w.runner.run();
  assert.equal(outcome, 'finished');
  const seq = kinds(w.calls);
  assert.deepEqual(seq.slice(0, 5), ['open', 'select', 'unselect', 'select', 'unselect']);
  // the second select happens only after the first unselect
  assert.ok(w.calls[3][1] >= w.calls[2][1]);
  // hold time between select and release is 375 s
  assert.equal((w.calls[2][1] - w.calls[1][1]) / 1000, 375);
  assert.equal(w.store.finished.status, 'finished');
  assert.deepEqual(w.page.selected, [], 'nothing left held');
});

test('the end time inside a hold releases the seats right then', async () => {
  const stop = Date.UTC(2026, 10, 1, 0, 2, 0); // 120 s into a 375 s hold
  const w = makeWorld({ stopAt: new Date(stop).toISOString() });
  await w.runner.run();
  const unselect = w.calls.find((c) => c[0] === 'unselect');
  assert.ok(unselect[1] >= stop && unselect[1] < stop + 2000, 'released at the end time, not 375 s later');
});

test('Stop during the hold releases the seats and ends as stopped', async () => {
  const w = makeWorld();
  setTimeout(() => {}, 0);
  let slept = 0;
  const original = w.runner.sleepFn;
  w.runner.sleepFn = async (ms) => { slept += ms; if (slept > 30000) w.store.stop = true; return original(ms); };
  const outcome = await w.runner.run();
  assert.equal(outcome, 'stopped');
  assert.equal(w.store.finished.status, 'stopped');
  assert.deepEqual(w.page.selected, []);
});

test('a worker shutdown (deploy) releases the seats but leaves the hold running to resume', async () => {
  const w = makeWorld();
  let slept = 0;
  const original = w.runner.sleepFn;
  w.runner.sleepFn = async (ms) => { slept += ms; if (slept > 30000) w.runner.shuttingDown = true; return original(ms); };
  await w.runner.run();
  assert.equal(w.store.finished.status, 'running');
  assert.equal(w.store.finished.interrupted, true);
  assert.deepEqual(w.page.selected, []);
});

test('a release the site did not confirm is retried on the SAME page, never by reloading', async () => {
  let n = 0;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 10, 0)).toISOString() }, {
    unselect: (page) => {
      n += 1;
      if (n === 1) { // slow site: only one of two released
        page.selected = ['KA-2'];
        return { seats: ['KA-1'], wanted: 2, failed: [] };
      }
      const was = [...page.selected];
      page.selected = [];
      return { seats: was, wanted: was.length, failed: [] };
    },
  });
  await w.runner.run();
  assert.ok(n >= 2, 'tried again');
  assert.equal(w.calls.filter((c) => c[0] === 'open').length, 1, 'the page was opened once');
  // no select happened between the failed and the confirmed release
  const firstUnselect = w.calls.findIndex((c) => c[0] === 'unselect');
  assert.deepEqual(kinds(w.calls).slice(firstUnselect, firstUnselect + 3), ['unselect', 'unselect', 'select']);
});

test('a seat taken by someone else is skipped; the rest are still held', async () => {
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 10, 0)).toISOString(), seatNumbers: 'DHA-1,DHA-2,DHA-7' }, {
    select: (args, page) => {
      page.selected = ['DHA-1', 'DHA-7'];
      return { seats: ['DHA-1', 'DHA-7'], wanted: 2, failed: [], unavailable: ['DHA-2'] };
    },
  });
  await w.runner.run();
  assert.ok(w.events.some((e) => /Held 2\/2 seat\(s\): DHA-1, DHA-7 \| not available: DHA-2/.test(e)));
});

test('the site\'s "temporarily disabled" block pauses everything until the time it names, then carries on', async () => {
  const body = '{"error":{"error_msg":"Your seat selection is temporarily disabled due to repeated attempts. Please try again after 01 November 2026 at 06:30 AM"}}';
  let first = true;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 3, 0, 0)).toISOString() }, {
    select: (args, page, driver) => {
      if (first) { first = false; driver.onNet({ status: 422, body, seat: 'KA-1', url: 'reserve-seat' }); return { seats: [], wanted: 2, failed: [{ seat: 'KA-1', status: 422 }], unavailable: [] }; }
      page.selected = ['KA-1', 'KA-2'];
      return { seats: ['KA-1', 'KA-2'], wanted: 2, failed: [], unavailable: [] };
    },
  });
  await w.runner.run();
  const selects = w.calls.filter((c) => c[0] === 'select');
  // 06:30 AM Bangladesh = 00:30 UTC on 01 Nov; the stop time (03:00 UTC) is later, so the retry waits for it.
  const blockEnd = Date.UTC(2026, 10, 1, 0, 30, 0);
  assert.ok(selects.length >= 2);
  assert.ok(selects[1][1] >= blockEnd, 'the next select waited for the block to end');
  assert.ok(w.store.alerts.some((a) => /blocked/i.test(a.title)));
  assert.ok(w.store.updates.some((u) => u.blocked_until), 'the block time is saved for restarts');
});

test('a remembered block from before a restart is honoured at start', async () => {
  const until = Date.UTC(2026, 10, 1, 0, 45, 0);
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 2, 0, 0)).toISOString(), blockedUntil: new Date(until).toISOString() });
  await w.runner.run();
  assert.ok(w.calls.find((c) => c[0] === 'select')[1] >= until);
});

test('nothing is clicked while the internet is down; it carries on when it returns', async () => {
  const downUntil = Date.UTC(2026, 10, 1, 0, 5, 0);
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 12, 0)).toISOString() }, { online: (t) => t >= downUntil });
  await w.runner.run();
  assert.ok(w.calls.every((c) => c[1] >= downUntil), 'no page action before the connection came back');
  assert.ok(w.events.some((e) => /Internet is down/.test(e)) && w.events.some((e) => /Internet is back/.test(e)));
});

test('an expired login waits for a new one from the app, then resumes with it', async () => {
  let opens = 0;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 1, 0, 0)).toISOString() }, {
    openGrid: () => { opens += 1; return opens === 1 ? { ok: false, loggedOut: true, reason: 'login page' } : { ok: true }; },
  });
  let slept = 0;
  const original = w.runner.sleepFn;
  w.runner.sleepFn = async (ms) => { slept += ms; if (slept > 60000) w.store.sessionChange = true; return original(ms); };
  await w.runner.run();
  assert.ok(w.calls.some((c) => c[0] === 'restart'), 'the browser was restarted with the new session');
  assert.ok(w.store.alerts.some((a) => a.loginNeeded), 'the owner was told to log in');
  assert.ok(w.calls.some((c) => c[0] === 'select'), 'holding resumed');
});

test('parseBlockedUntil reads the site message as Bangladesh time', () => {
  const r = parseBlockedUntil('x temporarily disabled ... try again after 29 October 2026 at 01:31 AM');
  assert.equal(r.until.toISOString(), '2026-10-28T19:31:00.000Z');
  assert.equal(parseBlockedUntil('... after 3 November 2026 at 11:05 PM'), null, 'only the block message counts');
  assert.equal(parseBlockedUntil('temporarily disabled after 3 November 2026 at 11:05 PM').until.toISOString(), '2026-11-03T17:05:00.000Z');
  assert.equal(parseBlockedUntil('Seat already booked'), null);
});

test('a browser page that stops answering is restarted and the seats are no longer counted as held', async () => {
  let probes = 0;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 20, 0)).toISOString() }, {
    probe: () => { probes += 1; return probes <= 2 ? { error: 'probe timed out after 30s' } : { vis: 'visible', focus: true, drift: 0 }; },
  });
  await w.runner.run();
  assert.ok(w.calls.some((c) => c[0] === 'restart'), 'Chrome was restarted');
  assert.ok(w.events.some((e) => /not answering/.test(e)));
  assert.ok(w.store.updates.some((u) => u.phase === 'recovering' && u.held_seats.length === 0));
  // after the restart it selects again
  const restartAt = w.calls.findIndex((c) => c[0] === 'restart');
  assert.ok(kinds(w.calls).slice(restartAt).includes('select'));
});

const failedRelease = (page, clock) => { clock.t += 41000; return { seats: [], wanted: page.selected.length, failed: page.selected.map((s) => ({ seat: s, status: 'no-request' })) }; };

test('a release not done in 40 s: the page is refreshed, and seats that are free afterwards simply carry on', async () => {
  let n = 0;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 12, 0)).toISOString() }, {
    unselect: (page, calls, clock) => { n += 1; return n === 1 ? failedRelease(page, clock) : { seats: [], wanted: 0, failed: [] }; },
    seatStates: (names) => Object.fromEntries(names.map((s) => [s, 'available'])),
  });
  await w.runner.run();
  assert.ok(w.events.some((e) => /did not finish within 40 s. Refreshing the page \(1\/2\)/.test(e)));
  assert.equal(w.calls.filter((c) => c[0] === 'open').length >= 2, true, 'the page was reloaded');
  assert.equal(w.runner.dropped.size, 0, 'nothing is dropped when the seats are free after the refresh');
  assert.ok(kinds(w.calls).slice(kinds(w.calls).indexOf('states')).includes('select'), 'and it selects again');
});

test('a seat still selected after the first refresh is refreshed again after 5 s', async () => {
  let rounds = 0;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 12, 0)).toISOString() }, {
    unselect: (page, calls, clock) => failedRelease(page, clock),
    seatStates: (names) => { rounds += 1; return Object.fromEntries(names.map((s) => [s, rounds === 1 ? 'selected' : 'available'])); },
  });
  await w.runner.run();
  const states = w.calls.filter((c) => c[0] === 'states');
  assert.equal(states.length >= 2, true);
  assert.ok(states[1][1] - states[0][1] >= 5000, 'the second look is at least 5 s after the first');
  assert.ok(w.events.some((e) => /still selected\. Waiting 5 s, then refreshing again/.test(e)));
  assert.equal(w.runner.dropped.size, 0);
});

test('a seat that stays selected after two refreshes is dropped, the owner is told, and the rest carries on', async () => {
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 30, 0)).toISOString() }, {
    unselect: (page, calls, clock) => failedRelease(page, clock),
    seatStates: (names) => Object.fromEntries(names.map((s) => [s, s === 'KA-2' ? 'selected' : 'available'])),
  });
  await w.runner.run();
  assert.deepEqual([...w.runner.dropped], ['KA-2']);
  assert.ok(w.events.some((e) => /DROPPED KA-2: stayed selected after two page refreshes\. Continuing with KA-1/.test(e)));
  assert.ok(w.store.alerts.some((a) => /dropped/i.test(a.title)), 'push + Telegram alert sent');
  const selects = w.calls.filter((c) => c[0] === 'select');
  assert.ok(selects.length >= 2);
  assert.equal(selects[selects.length - 1][2], 'KA-1', 'later rounds only ask for the seats that are left');
});

test('when every named seat has been dropped the hold stops and says why', async () => {
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 30, 0)).toISOString() }, {
    unselect: (page, calls, clock) => failedRelease(page, clock),
    seatStates: (names) => Object.fromEntries(names.map((s) => [s, 'selected'])),
  });
  const outcome = await w.runner.run();
  assert.equal(outcome, 'failed');
  assert.equal(w.store.finished.status, 'failed');
  assert.match(w.store.finished.error, /Every seat was dropped/);
  assert.ok(w.store.alerts.some((a) => /stopped/i.test(a.title)));
});

test('a seat that cannot be selected is retried after a refresh, then dropped with a notification', async () => {
  let first = true;
  const w = makeWorld({ stopAt: new Date(Date.UTC(2026, 10, 1, 0, 20, 0)).toISOString() }, {
    select: (args, page) => {
      // KA-2 is clicked but never accepted; KA-1 is fine
      const ok = args.targets.filter((t) => t !== 'KA-2');
      page.selected = ok;
      first = false;
      return { seats: ok, wanted: args.targets.length, failed: args.targets.includes('KA-2') ? [{ seat: 'KA-2', status: 'no-request' }] : [], unavailable: [] };
    },
  });
  await w.runner.run();
  assert.ok(w.events.some((e) => /KA-2 could not be selected\. Refreshing the page and trying again/.test(e)));
  assert.ok(w.events.some((e) => /DROPPED KA-2: could not be selected even after refreshing the page/.test(e)));
  assert.deepEqual([...w.runner.dropped], ['KA-2']);
  assert.ok(w.store.alerts.some((a) => /dropped/i.test(a.title)));
  assert.equal(first, false);
});
