// The hold cycle: select all named seats -> hold -> release (confirmed by the site) -> select again, until the end
// time or Stop. Node port of mobile/lib/features/holder/seat_holder_controller.dart, with the same rules:
//
//  * seats are only selected again after the site has ANSWERED every release request (otherwise they still count
//    as held by the previous round and show as booked);
//  * the same page is reused: no reload unless the seat grid is actually gone;
//  * nothing is sent while the site has blocked seat selection ("temporarily disabled ... try again after ...");
//    that block is remembered in the database so a restart does not poke the site again;
//  * nothing is clicked while the booking site is unreachable.
//
// Everything outside this file (browser, database, clock) is injected, so the loop is testable with fakes.

/** How long a release may take before the page is refreshed. */
const RELEASE_DEADLINE_MS = 40000;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "...try again after 29 October 2026 at 01:31 AM" -> Date (site time is Bangladesh, UTC+6). */
function parseBlockedUntil(body) {
  if (!/temporarily disabled/i.test(String(body || ''))) return null;
  const m = /after (\d{1,2}) (\w+) (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)/i.exec(String(body));
  if (!m) return { until: null };
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return { until: null };
  const hour = (Number(m[4]) % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
  const utc = Date.UTC(Number(m[3]), month, Number(m[1]), hour - 6, Number(m[5]));
  return { until: new Date(utc) };
}

class HoldRunner {
  constructor({ hold, driver, store, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1000 }) {
    this.hold = hold; // { id, trainName, seatClass, bogieName, seatNumbers, seatCount, holdSeconds, stopAt, blockedUntil }
    this.driver = driver;
    this.store = store;
    this.now = now;
    this.sleepFn = sleep;
    this.pollMs = pollMs;
    this.cycle = 0;
    this.held = [];
    this.blockedUntil = hold.blockedUntil ? new Date(hold.blockedUntil).getTime() : 0;
    this.stopRequested = false;
    this.shuttingDown = false; // process is being stopped (deploy): release the seats but leave the hold running
    this.loginAlerted = false;
    this.allTargets = String(hold.seatNumbers || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    this.dropped = new Set(); // seats given up on for the rest of this hold
    this.selectFailures = new Map(); // seat -> consecutive failed select attempts
    driver.onNet = (n) => this.onNet(n);
  }

  /** The seats still being held for: the named ones minus any that were dropped. */
  get targets() { return this.allTargets.filter((n) => !this.dropped.has(n)); }

  get stopAtMs() { return this.hold.stopAt ? new Date(this.hold.stopAt).getTime() : null; }
  get pastStop() { return this.stopAtMs !== null && this.now() >= this.stopAtMs; }
  get running() { return !this.stopRequested && !this.shuttingDown; }

  async say(msg) { await this.store.event(msg); }

  /** Interruptible sleep: wakes up to check Stop roughly once a second. */
  async sleep(ms) {
    const end = this.now() + ms;
    while (this.running && this.now() < end) {
      await this.sleepFn(Math.min(this.pollMs, Math.max(0, end - this.now())));
      if (await this.store.shouldStop()) this.stopRequested = true;
    }
  }

  onNet({ status, body, seat, url }) {
    this.store.event(`NET ${url} ${seat || ''} -> ${status} ${String(body || '').slice(0, 160)}`).catch(() => {});
    if (status === 429) {
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + 60000);
      this.store.event('Rate limited by the site (429). Pausing all actions for 60s.').catch(() => {});
    }
    const block = parseBlockedUntil(body);
    if (block) {
      const until = (block.until ? block.until.getTime() : this.now() + 3600000) + 60000;
      if (until > this.blockedUntil) {
        const first = this.blockedUntil < this.now();
        this.blockedUntil = until;
        this.store.update({ blocked_until: new Date(until) }).catch(() => {});
        this.store.event(`SITE BLOCK: seat selection is disabled by the site. Sending nothing until ${new Date(until).toISOString()}.`).catch(() => {});
        if (first) this.store.alert('Site blocked seat selection', 'Too many select/release attempts. The holder is paused and carries on by itself when the block ends.').catch(() => {});
      }
    }
  }

  /** Sleeps out a site block. Returns true if it had to wait. */
  async waitOutBlock() {
    if (this.now() >= this.blockedUntil) return false;
    await this.store.update({ phase: 'blocked', blocked_until: new Date(this.blockedUntil) });
    while (this.running && !this.pastStop && this.now() < this.blockedUntil) await this.sleep(Math.min(5000, this.blockedUntil - this.now()));
    return true;
  }

  async waitOnline(limitMs = null) {
    if (await this.driver.online()) return true;
    const since = this.now();
    await this.say('Internet is down. Waiting for it to come back before touching the seats.');
    await this.store.update({ phase: 'offline' });
    let warned = false;
    while (this.running || limitMs !== null) {
      if (await this.driver.online()) {
        await this.say(`Internet is back after ${Math.round((this.now() - since) / 1000)}s.`);
        return true;
      }
      const down = this.now() - since;
      if (limitMs !== null && down > limitMs) return false;
      if (!warned && down > 120000) {
        warned = true;
        await this.store.alert('Server has no internet', 'The seat holder has been offline for over 2 minutes. It carries on when the connection returns.');
      }
      await this.sleepFn(3000);
      if (limitMs === null && (await this.store.shouldStop())) this.stopRequested = true;
    }
    return false;
  }

  /** Gets the page to the seat grid for the configured train. */
  async openGrid() {
    if (!(await this.waitOnline())) return false;
    await this.say('Loading the trip list');
    await this.store.update({ phase: 'loading' });
    const r = await this.driver.openGrid({
      trainName: this.hold.trainName, seatClass: this.hold.seatClass, bogieName: this.hold.bogieName,
    });
    if (r.ok) return true;
    await this.say(r.reason || 'Could not open the seat layout.');
    if (r.loggedOut) await this.waitForLogin();
    return false;
  }

  /** The login lasts ~12 hours. When it lapses, wait for the owner to log in on the phone (the new session
   *  reaches the database) and carry on with it. */
  async waitForLogin() {
    await this.store.update({ phase: 'waiting_login' });
    if (!this.loginAlerted) {
      this.loginAlerted = true;
      await this.say('The Railway login has expired. Waiting for a new login from the app.');
      await this.store.alert('Railway login needed', 'The seat holder is paused because the Railway login expired. Log in again in the app and it resumes by itself.', true);
    }
    while (this.running && !this.pastStop) {
      if (await this.store.sessionChanged()) {
        await this.say('A new login arrived. Resuming.');
        await this.driver.restart();
        this.loginAlerted = false;
        return;
      }
      await this.sleep(15000);
    }
  }

  async run() {
    try {
      let tries = 0;
      while (this.running && !this.pastStop) {
        if (await this.openGrid()) break;
        tries++;
        if (!this.running) break;
        await this.say(`Could not reach the seat layout (attempt ${tries}). Trying again shortly.`);
        await this.sleep(Math.min(60000, 5000 * tries));
      }
      let first = true;
      while (this.running) {
        if (this.pastStop) { await this.say('Scheduled stop time reached.'); this.outcome = 'finished'; break; }
        if (await this.waitOutBlock()) continue;

        await this.store.update({ phase: first ? 'selecting' : 'reselecting' });
        const held = await this.acquire();
        if (!held.length) {
          if (this.running && this.pastStop) { await this.say('Scheduled stop time reached.'); this.outcome = 'finished'; }
          break;
        }
        first = false;
        const heldAt = this.now();
        this.held = held;
        await this.store.update({ phase: 'holding', held_seats: held, cycle_count: this.cycle });

        const result = await this.holdWindow(heldAt);
        if (result === 'lost') {
          this.held = [];
          await this.store.update({ held_seats: [], phase: 'reselecting' });
          if (this.running) await this.releaseAll();
          continue;
        }
        if (!this.running) break;

        // The next select must not start until the site has confirmed this release.
        await this.store.update({ phase: 'releasing' });
        if (!(await this.releaseAll())) break;
        this.held = [];
        this.cycle += 1;
        await this.store.update({ held_seats: [], cycle_count: this.cycle });
        await this.sleep(250);
      }
    } catch (e) {
      this.outcome = 'failed';
      this.error = e.message;
      await this.say(`Holding loop crashed: ${e.message}`).catch(() => {});
    } finally {
      await this.finish();
    }
    return this.outcome || (this.shuttingDown ? 'interrupted' : 'stopped');
  }

  async acquire() {
    let failures = 0;
    while (this.running) {
      if (this.pastStop) return [];
      if (await this.waitOutBlock()) continue;
      if (!(await this.waitOnline())) return [];

      const r = await this.driver.selectSeats({ targets: this.targets, preferred: this.held, maxCount: this.hold.seatCount });
      if (r.error) await this.say(`Page error: ${r.error}`);
      const failedText = [
        (r.failed || []).length ? `failed: ${r.failed.map((f) => `${f.seat}=${f.status}`).join(', ')}` : '',
        (r.unavailable || []).length ? `not available: ${r.unavailable.join(', ')}` : '',
      ].filter(Boolean).join(' | ');
      await this.say(`Held ${r.seats.length}/${r.wanted} seat(s): ${r.seats.join(', ')}${failedText ? ` | ${failedText}` : ''}`);
      if (!this.running) return r.seats;

      // A seat that was clicked but not accepted: refresh the page and try once more; a second failure drops it.
      const bad = (r.failed || []).map((f) => f.seat).filter(Boolean);
      r.seats.forEach((n) => this.selectFailures.delete(n));
      if (bad.length) {
        const drop = bad.filter((n) => (this.selectFailures.get(n) || 0) >= 1);
        bad.forEach((n) => this.selectFailures.set(n, (this.selectFailures.get(n) || 0) + 1));
        if (drop.length) {
          await this.dropSeats(drop, 'could not be selected even after refreshing the page');
          drop.forEach((n) => this.selectFailures.delete(n));
          if (!this.running) return [];
          if (r.seats.length) return r.seats;
          continue;
        }
        await this.say(`${bad.join(', ')} could not be selected. Refreshing the page and trying again.`);
        await this.store.update({ phase: 'refreshing' });
        await this.openGrid();
        if (r.seats.length) return r.seats;
        await this.sleep(5000);
        continue;
      }
      if (r.seats.length) return r.seats;

      failures += 1;
      // Keep going until the stop time or Stop, but back off so a taken seat or a dead session is not hammered.
      const wait = failures < 3 ? 2000 : failures < 6 ? 10000 : 30000;
      await this.say(`No seat held (attempt ${failures}). Retrying in ${wait / 1000}s...`);
      if (failures === 8) await this.store.alert('Seat holder cannot get seats', 'No seat could be held for several minutes. Check the app.');
      // Normally just try again on the same page. Reload only if the seat grid is gone, or as a last resort after
      // many misses (a page left open for hours can go stale).
      const page = await this.driver.readPage();
      if (page && page.login) { await this.waitForLogin(); continue; }
      if (!page || !page.inGrid || failures % 12 === 0) {
        await this.store.update({ phase: 'loading' });
        if (!(await this.openGrid()) && !this.running) return [];
      }
      await this.sleep(wait);
    }
    return [];
  }

  /**
   * Counts the hold window down. Returns 'done' at the end of the window (or on Stop / the end time) and 'lost'
   * when the browser page stopped answering, so the seats can no longer be counted as held.
   */
  async holdWindow(heldAt) {
    const total = this.hold.holdSeconds * 1000;
    const start = heldAt; // the window counts from the moment the seats were taken, not from when verification ended
    const end = start + total;
    let probe = start;
    let probeFailures = 0;
    while (this.running && this.now() < end) {
      if (this.pastStop) break; // the end time can fall inside a long hold: release on time
      if (this.now() - probe > 30000) {
        probe = this.now();
        if (!(await this.driver.online())) await this.say('Internet dropped while holding.');
        if (this.driver.probe) {
          const p = await this.driver.probe();
          if (p.error) {
            probeFailures += 1;
            await this.say(`page check: ERROR ${p.error} (${probeFailures})`);
            if (probeFailures >= 2) {
              await this.say('The browser page is not answering. Restarting it; the seats are no longer counted as held.');
              await this.store.update({ phase: 'recovering', held_seats: [] });
              await this.driver.restart();
              return 'lost';
            }
          } else {
            probeFailures = 0;
            await this.say(`page check: ${p.vis}, focus ${p.focus}, timer drift ${p.drift}ms, Chrome ${p.mb ?? '?'} MB`);
          }
        }
      }
      await this.sleep(Math.min(1000, end - this.now()));
    }
    return 'done';
  }

  /**
   * Releases every selected seat and returns true only once that is settled. Clicking is tried for up to 40 s; if the
   * site has not confirmed by then the page is refreshed (a page reload also frees the seats), the seats are checked
   * again, and a seat that is STILL selected is refreshed once more after 5 s. A seat that survives that is dropped
   * from this hold and the owner is told. [maxAttempts] bounds the effort when the loop is shutting down.
   */
  async releaseAll({ maxAttempts = null } = {}) {
    const deadline = this.now() + RELEASE_DEADLINE_MS;
    let attempt = 0;
    let wasSelected = [...this.held];
    while (maxAttempts !== null || this.running) {
      if (maxAttempts !== null && attempt >= maxAttempts) {
        await this.say(`Could not confirm the release after ${attempt} attempts. The site frees the hold by itself when its timer runs out.`);
        return false;
      }
      if (maxAttempts === null && attempt > 0 && this.now() >= deadline) return this.refreshRelease(wasSelected);
      attempt += 1;
      if (!(await this.waitOnline(maxAttempts !== null ? 20000 : null))) return false;

      const before = await this.driver.readPage();
      if (before && before.inGrid && before.selected.length === 0) return true; // nothing selected: nothing to release
      if (before && before.selected.length) wasSelected = before.selected;

      const r = await this.driver.unselectSeats({ timeoutMs: maxAttempts !== null ? 60000 : Math.max(10000, deadline - this.now() + 5000) });
      const after = await this.driver.readPage();
      const still = after ? after.selected.length : -1;
      await this.say(`Released ${r.seats.length}/${r.wanted} seat(s): ${r.seats.join(', ')}${(r.failed || []).length ? ` | failed: ${r.failed.map((f) => `${f.seat}=${f.status}`).join(', ')}` : ''}`);
      if (!(r.failed || []).length && r.wanted >= 0 && r.seats.length === r.wanted && still === 0) return true;

      await this.say(`Release not confirmed (attempt ${attempt}): released ${r.seats.length}/${r.wanted}, still selected ${still}.`);
      if (maxAttempts !== null) await this.sleepFn(3000);
      else await this.sleep(2000);
    }
    return false;
  }

  /** The 40 s are up: refresh the page and look at the seats; refresh again after 5 s if any is still selected. */
  async refreshRelease(names) {
    let stuck = [];
    for (let round = 1; round <= 2 && this.running; round++) {
      await this.say(`The release did not finish within ${RELEASE_DEADLINE_MS / 1000} s. Refreshing the page (${round}/2).`);
      await this.store.update({ phase: 'refreshing' });
      if (!(await this.openGrid())) { await this.sleep(5000); continue; }
      const states = await this.driver.seatStates(names);
      stuck = names.filter((n) => states[n] === 'selected');
      await this.say(`After the refresh: ${names.map((n) => `${n} ${states[n]}`).join(', ')}.`);
      if (!stuck.length) return true;
      if (round === 1) {
        await this.say(`${stuck.join(', ')} still selected. Waiting 5 s, then refreshing again.`);
        await this.sleep(5000);
      }
    }
    if (stuck.length) await this.dropSeats(stuck, 'stayed selected after two page refreshes');
    return true;
  }

  /** Gives up on seats for the rest of this hold, and tells the owner (push + Telegram). */
  async dropSeats(seats, why) {
    const named = seats.filter((n) => this.allTargets.includes(n));
    if (!named.length) return; // seats chosen automatically have no name to drop
    named.forEach((n) => this.dropped.add(n));
    const left = this.targets;
    await this.say(`DROPPED ${named.join(', ')}: ${why}. Continuing with ${left.length ? left.join(', ') : 'no seats'}.`);
    await this.store.alert('Seat dropped from the hold', `${named.join(', ')} ${why}, so it was removed from this hold. Still holding for: ${left.length ? left.join(', ') : 'nothing'}.`);
    if (!left.length) {
      this.error = 'Every seat was dropped';
      this.outcome = 'failed';
      this.stopRequested = true;
      await this.store.alert('Seat holder stopped', 'Every seat was dropped, so there is nothing left to hold.');
    }
  }

  async finish() {
    // Release whatever is still held, whatever the reason we stopped (bounded effort).
    try {
      await this.releaseAll({ maxAttempts: 4 });
    } catch (e) {
      await this.say(`Release on shutdown failed: ${e.message}`).catch(() => {});
    }
    const status = this.shuttingDown ? 'running' : this.outcome === 'failed' ? 'failed' : this.outcome === 'finished' ? 'finished' : 'stopped';
    await this.store.finish({ status, error: this.error || null, interrupted: this.shuttingDown });
    await this.say(this.shuttingDown ? 'Worker restarting: seats released, the hold resumes by itself.' : `Stopped (${status}).`);
  }
}

module.exports = { HoldRunner, parseBlockedUntil };
