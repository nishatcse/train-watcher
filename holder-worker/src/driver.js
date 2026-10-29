// The real browser: a plain Google Chrome (not Playwright's own build, which Cloudflare Turnstile flags) started
// with a remote-debugging port, attached over CDP, exactly like src/browser.js in the legacy watcher. The stored
// railway session is put into the site's own localStorage, then the same page-side functions as the phone run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns').promises;
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright-core');
const page_js = require('./page-js');

const SITE = 'eticket.railway.gov.bd';
const PORT = 9222;
const SESSION_KEYS = ['token', 'ssdk', 'uudid', 'user', 'handshake_data', 'handshake_hash'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A hung browser call must never hang the hold: give up after `ms`. */
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms))]);
const isoToSite = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`; };

class ChromeDriver {
  constructor({ hold, getSession, log = () => {} }) {
    this.hold = hold; // { fromCity, toCity, journeyDate (ISO), seatClass }
    this.getSession = getSession; // async () => decrypted session blob
    this.log = log;
    this.onNet = null;
    this.chrome = null;
    this.browser = null;
    this.page = null;
    this.profile = null;
  }

  async online() {
    try {
      await Promise.race([dns.lookup(SITE), sleep(4000).then(() => { throw new Error('dns timeout'); })]);
      return true;
    } catch {
      return false;
    }
  }

  async start() {
    await this.stop();
    const session = await this.getSession();
    if (!session || !session.token) throw new Error('no stored railway session');
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
    // Same recipe as src/browser.js, plus --no-sandbox (containers have no user namespaces). No memory-saving flags:
    // they made the booking app hang there.
    this.chrome = spawn(process.env.CHROME_BIN || 'google-chrome-stable', [
      `--user-data-dir=${this.profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
      '--disable-dev-shm-usage', '--password-store=basic', '--no-sandbox', '--window-size=1280,1000',
      // A page nobody looks at is throttled hard after a few minutes (timers fire once a minute), which stalls the
      // click/wait scripts. These only keep it running at full speed; they are not memory-saving tuning flags.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
      'about:blank',
    ], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
      await sleep(500);
    }
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const ctx = this.browser.contexts()[0] || (await this.browser.newContext());
    await ctx.addInitScript(page_js.installTracker);
    this.page = ctx.pages()[0] || (await ctx.newPage());
    this.page.on('response', (r) => this.#onResponse(r));
    // Say what happens to the browser: a silent crash is what once left the hold running with a dead page.
    this.page.on('crash', () => this.log('BROWSER: the page crashed'));
    this.page.on('pageerror', (e) => this.log(`page error: ${String(e.message).slice(0, 120)}`));
    this.browser.on('disconnected', () => this.log('BROWSER: Chrome disconnected'));
    this.chrome.once('exit', (code, sig) => this.log(`BROWSER: Chrome process exited (code ${code}, signal ${sig})`));
    // Make the page believe it is focused and visible, whatever the (virtual) display does.
    try {
      const cdp = await ctx.newCDPSession(this.page);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    } catch (e) {
      this.log(`focus emulation unavailable: ${e.message}`);
    }
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => { if (this.page && !this.page.isClosed()) this.page.bringToFront().catch(() => {}); }, 20000);
    await this.page.goto(`https://${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.evaluate((s) => {
      for (const k of ['token', 'ssdk', 'uudid', 'user', 'handshake_data', 'handshake_hash']) if (s[k]) localStorage.setItem(k, s[k]);
    }, Object.fromEntries(SESSION_KEYS.map((k) => [k, session[k]])));
    this.log('Chrome started with the stored session');
  }

  async stop() {
    clearInterval(this.keepAlive);
    try { if (this.browser) await this.browser.close(); } catch {}
    try { if (this.chrome) this.chrome.kill('SIGKILL'); } catch {}
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); } catch {}
    this.browser = this.chrome = this.page = this.profile = null;
  }

  async restart() { await this.start(); }

  /** After a timeout the page is in an unknown state: drop the browser, the next call starts a fresh one. */
  async #recover(e) {
    this.log(`browser call failed: ${e.message}`);
    if (/timed out/.test(e.message)) await this.stop();
  }

  /** How the page shows each named seat right now ('selected' = still ours, 'available', 'taken', 'missing'). */
  async seatStates(names) {
    try {
      await this.#ensure();
      return await withTimeout(this.page.evaluate(page_js.readSeatStates, { names }), 20000, 'seatStates');
    } catch {
      return Object.fromEntries(names.map((n) => [n, 'unknown']));
    }
  }

  /** Memory used by all Chrome processes, to see whether a hang is the container running out of RAM. */
  chromeMb() {
    try {
      const out = execSync("ps -eo rss,comm | grep -i chrome | awk '{s+=$1} END {print s}'", { timeout: 3000 }).toString().trim();
      return Math.round(Number(out || 0) / 1024);
    } catch {
      return null;
    }
  }

  /** Memory used by all Chrome processes, to see whether a hang is the container running out of RAM. */
  chromeMb() {
    try {
      const out = execSync("ps -eo rss,comm | grep -i chrome | awk '{s+=$1} END {print s}'", { timeout: 3000 }).toString().trim();
      return Math.round(Number(out || 0) / 1024);
    } catch {
      return null;
    }
  }

  /** Is the page alive and running at full speed? Logged once a minute during a hold. */
  async probe() {
    try {
      await this.#ensure();
      const drift = await withTimeout(
        this.page.evaluate(() => new Promise((res) => { const s = Date.now(); setTimeout(() => res({ drift: Date.now() - s - 100, vis: document.visibilityState, focus: document.hasFocus() }), 100); })),
        30000, 'probe');
      return { ...drift, mb: this.chromeMb() };
    } catch (e) {
      await this.#recover(e); // a page that does not answer is dropped; the next call starts a fresh Chrome
      return { error: e.message };
    }
  }

  async #ensure() {
    if (!this.browser || !this.browser.isConnected() || !this.page || this.page.isClosed()) await this.start();
  }

  async #onResponse(r) {
    const url = r.url();
    if (!/railspaapi\.shohoz\.com/.test(url) || !/reserve-seat|release-seat|seat-layout/.test(url)) return;
    if (!this.onNet) return;
    let body = '';
    let seat = '';
    try {
      body = (await r.text()).slice(0, 400);
      const post = r.request().postData();
      if (post) seat = String(JSON.parse(post).extras.seat_number || '');
    } catch {}
    this.onNet({ status: r.status(), body, seat, url: url.split('?')[0].split('/').slice(-1)[0] });
  }

  async readPage() {
    try {
      await this.#ensure();
      return await withTimeout(this.page.evaluate(page_js.readPage), 20000, 'readPage');
    } catch {
      return null;
    }
  }

  /** Gets to the seat grid of the held train. */
  async openGrid({ trainName, seatClass, bogieName }) {
    try {
      await this.#ensure();
      const h = this.hold;
      const url = `https://${SITE}/booking/train/search?fromcity=${encodeURIComponent(h.fromCity)}&tocity=${encodeURIComponent(h.toCity)}&doj=${isoToSite(h.journeyDate)}&class=${encodeURIComponent(seatClass)}`;
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try {
        await this.page.waitForFunction(() => document.querySelectorAll('app-single-trip').length > 0 || document.querySelectorAll('.btn-seat').length > 0, null, { timeout: 45000 });
      } catch {
        const p = await this.readPage();
        if (p && p.login) return { ok: false, loggedOut: true, reason: 'The site shows its login page.' };
        return { ok: false, reason: 'The trip list never appeared (slow site, or a Cloudflare check).' };
      }
      const m = /\((\d+)\)/.exec(trainName);
      const trainKey = (m ? m[1] : trainName.trim()).toUpperCase();
      const opened = await this.page.evaluate(page_js.openSeatLayout, { trainKey, wantedClass: seatClass.trim().toUpperCase() });
      if (!opened.ok) return { ok: false, reason: opened.reason, noSeats: opened.noSeats };
      try {
        await this.page.waitForSelector('.btn-seat', { timeout: 30000 });
      } catch {
        const p = await this.readPage();
        if (p && p.login) return { ok: false, loggedOut: true, reason: 'The site shows its login page.' };
        return { ok: false, reason: 'The seat grid never appeared.' };
      }
      if (bogieName && bogieName.trim()) {
        const c = await this.page.evaluate(page_js.selectCoach, { wanted: bogieName.trim().toUpperCase() });
        if (!c.ok) return { ok: false, reason: c.reason };
        await sleep(1000);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `Browser error: ${e.message}` };
    }
  }

  async selectSeats(args) {
    try {
      await this.#ensure();
      return await withTimeout(this.page.evaluate(page_js.selectSeats, args), 180000, 'selectSeats');
    } catch (e) {
      await this.#recover(e);
      return { seats: [], wanted: 0, failed: [], unavailable: [], error: e.message };
    }
  }

  async unselectSeats({ timeoutMs = 60000 } = {}) {
    try {
      await this.#ensure();
      return await withTimeout(this.page.evaluate(page_js.unselectSeats), timeoutMs, 'unselectSeats');
    } catch (e) {
      await this.#recover(e);
      return { seats: [], wanted: -1, failed: [], error: e.message };
    }
  }
}

module.exports = { ChromeDriver, isoToSite };
