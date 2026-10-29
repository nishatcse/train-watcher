// Everything that runs INSIDE the booking page (eticket.railway.gov.bd, an Angular app). The site signs every
// reserve-seat / release-seat request itself (Cloudflare Turnstile token + action token), so these functions only
// click what a person would click and read what the page shows. They are plain, self-contained functions because
// Playwright serialises them with toString(): they may not close over anything from this module.
//
// Ported from mobile/lib/features/holder/seat_automation_js.dart, which keeps the phone-side copy.

/** Init script, run before the site's own scripts on every document. Tracks the seat API calls. */
function installTracker() {
  if (!/eticket\.railway\.gov\.bd$/.test(location.hostname)) return; // not in the Cloudflare iframes
  if (window._sh) return;

  // Every reserve/release is recorded with its seat and final HTTP status and counted while in flight, so the
  // automation waits for the site's own answer instead of guessing from the seat colour. Only the seat number
  // is read from a request body (never the tokens).
  window._shNet = { inflight: 0, calls: [], count: 0 };
  const counted = /reserve-seat|release-seat/;
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._shUrl = String(url);
    return open.apply(this, arguments);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const url = xhr._shUrl || '';
    if (counted.test(url)) {
      let seat = '';
      try { seat = String(JSON.parse(body).extras.seat_number || '').toUpperCase(); } catch (e) {}
      const rec = { n: ++window._shNet.count, kind: /reserve/.test(url) ? 'reserve' : 'release', seat, status: null, ok: false };
      window._shNet.calls.push(rec);
      if (window._shNet.calls.length > 200) window._shNet.calls.shift();
      window._shNet.inflight++;
      xhr.addEventListener('loadend', function () {
        rec.status = xhr.status;
        // A release answered 422 means the site already dropped the hold: the seat is free either way.
        rec.ok = (xhr.status >= 200 && xhr.status < 300) || (rec.kind === 'release' && xhr.status === 422);
        window._shNet.inflight--;
      });
    }
    return send.apply(this, arguments);
  };

  window._sh = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    seatName: (el) => (el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText || '').trim().toUpperCase(),
    grid: () => Array.from(document.querySelectorAll('.btn-seat')),
    selected: () => window._sh.grid().filter((s) => s.classList.contains('seat-selected')),
    waitFor: async (pred, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (pred()) return true;
        await window._sh.sleep(100);
      }
      return pred();
    },
    // Clicks one seat and waits for the site's answer. The page ignores clicks while one of its own requests
    // is still running (a slow release can take 10 s), so a click that starts no request within 2.5 s is
    // repeated. Returns the finished call {ok, status}, 'already' when the seat was already in the wanted
    // state, or null when nothing happened.
    act: async (name, kind) => {
      const sh = window._sh;
      const net = window._shNet;
      for (let attempt = 0; attempt < 3; attempt++) {
        const el = sh.grid().find((s) => sh.seatName(s) === name);
        if (!el) return null;
        const isSelected = el.classList.contains('seat-selected');
        if ((kind === 'reserve') === isSelected) return 'already';
        const from = net.count;
        el.click();
        const started = await sh.waitFor(() => net.count > from, 2500);
        if (!started) continue;
        await sh.waitFor(() => net.inflight === 0, 40000);
        const done = net.calls.filter((c) => c.n > from && c.kind === kind);
        return done.length ? done[done.length - 1] : null;
      }
      return null;
    },
  };
}

/** Snapshot of the page. */
function readPage() {
  const grid = Array.from(document.querySelectorAll('.btn-seat'));
  const name = (s) => (s.getAttribute('title') || s.getAttribute('aria-label') || s.innerText || '').trim().toUpperCase();
  return {
    trips: document.querySelectorAll('app-single-trip').length,
    // The site's login page (session lapsed after ~12 h): a password field or a login/auth route.
    login: !!document.querySelector('input[type=password]') || /login|signin|auth/i.test(location.pathname),
    inGrid: grid.length > 0,
    available: grid.filter((s) => s.classList.contains('seat-available')).length,
    selected: grid.filter((s) => s.classList.contains('seat-selected')).map(name),
  };
}

/** Clicks "Book Now" for the wanted train and class on the trip list. */
function openSeatLayout({ trainKey, wantedClass }) {
  const cards = Array.from(document.querySelectorAll('app-single-trip'));
  if (cards.length === 0) return { ok: false, reason: 'No train cards on the page yet.' };
  const card = cards.find((c) => (c.innerText || '').toUpperCase().indexOf(trainKey) !== -1);
  if (!card) return { ok: false, reason: 'Train ' + trainKey + ' is not in the list (' + cards.length + ' trains shown).' };

  let btn = null;
  const rows = Array.from(card.querySelectorAll('.single-seat-class'));
  for (let i = 0; i < rows.length && !btn; i++) {
    const nameEl = rows[i].querySelector('.seat-class-name');
    const name = nameEl ? (nameEl.innerText || '').trim().toUpperCase() : (rows[i].innerText || '').toUpperCase();
    if (name.indexOf(wantedClass) === -1) continue;
    btn = rows[i].querySelector('.book-now-btn, button');
    if (!btn) {
      // The site drops the Book Now button entirely when a class has no seats left.
      const left = rows[i].querySelector('.all-seats');
      return { ok: false, noSeats: true, reason: wantedClass + ' on ' + trainKey + ' has ' + (left ? left.innerText.trim() : '0') + ' seats, so there is nothing to hold.' };
    }
  }
  if (!btn) return { ok: false, reason: 'No Book Now button for class ' + wantedClass + '.' };
  if (btn.disabled || btn.classList.contains('disabled')) return { ok: false, noSeats: true, reason: 'Book Now is disabled (no seats in ' + wantedClass + ').' };
  btn.click();
  return { ok: true };
}

/** Picks the wanted coach in the bogie dropdown. */
function selectCoach({ wanted }) {
  const select = document.querySelector('#select-bogie');
  if (!select) return { ok: true, coach: '(no coach dropdown on this page)' };
  for (let i = 0; i < select.options.length; i++) {
    const text = (select.options[i].text || select.options[i].label || '').toUpperCase();
    if (text.indexOf(wanted) !== -1) {
      select.value = select.options[i].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, coach: text.trim() };
    }
  }
  return { ok: false, reason: 'Coach ' + wanted + ' is not in the dropdown.' };
}

/**
 * Selects the wanted seats one at a time (click, wait for the site's answer, next). `targets` are seats the owner
 * named: only those are tried. Without them, `preferred` (held last cycle) come first if still free and the rest of
 * `maxCount` is filled with the first available seats, so a seat lost to someone else is replaced.
 */
async function selectSeats({ targets, preferred, maxCount }) {
  const sh = window._sh;
  const grid = sh.grid();
  if (grid.length === 0) return { seats: [], wanted: 0, failed: [], unavailable: [], error: 'Seat grid is not on the page.' };

  let picks = [];
  const unavailable = [];
  if (targets.length > 0) {
    targets.forEach((t) => {
      const el = grid.find((s) => sh.seatName(s) === t);
      // A seat the page shows as taken is not clicked (and not waited for): it is reported instead.
      if (el && (el.classList.contains('seat-available') || el.classList.contains('seat-selected'))) picks.push(el);
      else unavailable.push(t);
    });
  } else {
    picks = grid.filter((s) => s.classList.contains('seat-selected')); // already selected count toward the limit
    const free = (s) => s.classList.contains('seat-available') && picks.indexOf(s) === -1;
    preferred.forEach((name) => {
      const el = grid.find((s) => sh.seatName(s) === name);
      if (el && picks.length < maxCount && free(el)) picks.push(el);
    });
    grid.forEach((s) => { if (picks.length < maxCount && free(s)) picks.push(s); });
  }
  picks = picks.slice(0, 4);
  if (picks.length === 0) return { seats: [], wanted: 0, failed: [], unavailable };

  // Angular may re-render the buttons after a click, so everything below goes by seat name, not element.
  const names = picks.map(sh.seatName);
  const failed = [];
  const accepted = [];
  for (const n of names) {
    const r = await sh.act(n, 'reserve');
    if (r === 'already' || (r && r.ok)) accepted.push(n);
    else failed.push({ seat: n, status: r ? r.status : 'no-request' });
  }
  await sh.waitFor(() => { const now = sh.selected().map(sh.seatName); return accepted.every((n) => now.indexOf(n) !== -1); }, 3000);
  const now = sh.selected().map(sh.seatName);
  // Held = accepted by the server AND shown as selected on the page.
  return { seats: accepted.filter((n) => now.indexOf(n) !== -1), wanted: names.length, failed, unavailable };
}

/** Releases every selected seat, one at a time and as fast as the site answers; reports the seats confirmed free. */
async function unselectSeats() {
  const sh = window._sh;
  const names = sh.selected().map(sh.seatName);
  const failed = [];
  const accepted = [];
  for (const n of names) {
    const r = await sh.act(n, 'release');
    if (r === 'already' || (r && r.ok)) accepted.push(n);
    else failed.push({ seat: n, status: r ? r.status : 'no-request' });
  }
  await sh.waitFor(() => { const now = sh.selected().map(sh.seatName); return accepted.every((n) => now.indexOf(n) === -1); }, 3000);
  const now = sh.selected().map(sh.seatName);
  return { seats: accepted.filter((n) => now.indexOf(n) === -1), wanted: names.length, failed };
}

/**
 * How the page shows each named seat, for the independent "is it really held?" check: 'selected' (ours),
 * 'available' (free: NOT held), 'taken' (held by someone, or booked), 'missing' (not in this coach).
 */
function readSeatStates({ names }) {
  const grid = Array.from(document.querySelectorAll('.btn-seat'));
  const name = (s) => (s.getAttribute('title') || s.getAttribute('aria-label') || s.innerText || '').trim().toUpperCase();
  const out = {};
  names.forEach((n) => {
    const el = grid.find((s) => name(s) === n);
    out[n] = !el ? 'missing' : el.classList.contains('seat-selected') ? 'selected' : el.classList.contains('seat-available') ? 'available' : 'taken';
  });
  return out;
}

module.exports = { readSeatStates, installTracker, readPage, openSeatLayout, selectCoach, selectSeats, unselectSeats };
