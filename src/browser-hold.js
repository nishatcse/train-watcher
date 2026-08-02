const path = require("path");
const { config } = require("./config");
const { withChromePage } = require("./browser");
const { performLogin, readSession } = require("./login");
const { tokenExpiresAt } = require("./session");
const { sleep, log } = require("./helpers");

const HOLD_CDP_PORT = 9224;
// The holder account (B) has its OWN Chrome profile, separate from the watcher's
// login-profile, so holding never disturbs the watcher account's session.
const PROFILE_DIR = path.resolve(__dirname, "..", "state", "holder-profile");
// reserve/release round-trip incl. the booking-page Turnstile. The Pi is slow
// (weak CPU + ~5s DNS), so give it plenty of time. Overridable via env.
const SEAT_ACTION_TIMEOUT_MS = (Number(process.env.SEAT_ACTION_TIMEOUT_SECONDS) || 60) * 1000;

function searchUrl({ from, to, date, seatClass }) {
  const params = new URLSearchParams({ fromcity: from, tocity: to, doj: date, class: seatClass });
  return `https://eticket.railway.gov.bd/booking/train/search?${params.toString()}`;
}

// Make sure the given holder account is logged in on this profile. If the profile
// already has a valid token we skip straight to holding (fast); otherwise we log
// in with those credentials (Turnstile solves in this plain CDP Chrome).
// `credentials` defaults to the single holder account (B) used by `holdSeats`;
// the rotation passes one of its five accounts instead.
async function ensureLoggedIn(page, credentials = config.holder, { verifyWith = null } = {}) {
  const who = credentials.label || "Holder account";
  await page.goto("https://eticket.railway.gov.bd/", { waitUntil: "domcontentloaded", timeout: 90000 });
  const session = await readSession(page).catch(() => null);
  const expiresAt = session && session.token ? tokenExpiresAt(session.token) : null;

  if (expiresAt && expiresAt - Date.now() > 60 * 1000) {
    // The JWT's own expiry is not proof the server still honours it — a session
    // can be invalidated early (logged in elsewhere, device key rotated, or the
    // profile lost its last writes to an unclean Chrome kill). Without this
    // check the account looks "logged in" while every request comes back 401 and
    // the booking page just spins forever.
    if (!verifyWith) {
      log(`${who} already logged in`);
      return;
    }
    const alive = await verifyWith(page).catch(() => null);
    if (alive !== false) {
      log(`${who} already logged in`);
      return;
    }
    log(`${who} has a token but the server rejects it — logging in again...`);
  } else {
    log(`${who} not logged in — logging in now...`);
  }

  await performLogin(page, credentials);
  log(`${who} login successful`);
}

// "TURNA (742)" -> "742" so we can match the train card even if the label spacing
// or casing differs. Falls back to the whole string when there is no number.
function trainMatchKey(train) {
  const m = train.match(/\((\d+)\)/);
  return m ? m[1] : train.trim().toUpperCase();
}

async function screenshot(page, tag) {
  const file = path.join(__dirname, "..", "state", `hold-debug-${tag}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  log(`Saved debug screenshot: ${file}`);
  return file;
}

/**
 * Open the seat-layout for the wanted train + class by clicking its Book Now.
 *
 * Returns true once the seat grid is up. When the class shows 0 tickets the
 * Book Now button is disabled and the grid cannot be reached at all — which is
 * exactly what happens while one of OUR accounts is holding the last seats of
 * the class. Callers that are waiting for a handover pass
 * `requireEnabled: false` to get "disabled" back instead of an exception, so
 * they can sit on the search page until the button lights up again.
 */
async function openSeatLayout(page, train, seatClass, { requireEnabled = true } = {}) {
  await page.waitForSelector("app-single-trip", { timeout: 60000 });

  const key = trainMatchKey(train);
  const cards = page.locator("app-single-trip");
  const count = await cards.count();

  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const text = (await card.innerText().catch(() => "")).toUpperCase();
    if (!text.includes(key)) {
      continue;
    }

    // Expand the card if its seat classes are collapsed (cards are usually
    // expanded already, so only click the collapse toggle when none are shown).
    const seatClasses = card.locator(".single-seat-class");
    if ((await seatClasses.count()) === 0) {
      await card.locator(".trip-collapse-btn").first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    const classCount = await seatClasses.count();
    for (let c = 0; c < classCount; c += 1) {
      const cls = seatClasses.nth(c);
      const name = (await cls.locator(".seat-class-name").first().innerText().catch(() => "")).trim().toUpperCase();
      if (name !== seatClass.trim().toUpperCase()) {
        continue;
      }
      const bookBtn = cls.locator(".book-now-btn").first();
      if ((await bookBtn.count()) === 0 || (await bookBtn.isDisabled().catch(() => true))) {
        if (!requireEnabled) {
          return "disabled";
        }
        throw new Error(`Book Now for ${seatClass} on ${train} is disabled (no seats?)`);
      }
      log(`Clicking Book Now for ${train} / ${seatClass}`);
      await bookBtn.click();
      // Seat grid appears after Turnstile solves + seat-layout loads.
      await page.waitForSelector(".btn-seat", { timeout: 60000 });
      await page.waitForTimeout(1500);
      return true;
    }
    throw new Error(`Seat class ${seatClass} not found on ${train}`);
  }
  throw new Error(`Train ${train} not found in search results`);
}

// The coach dropdown is a native <select id="select-bogie"> (the "coachSelection"
// in the source is only an Angular template-ref, not a DOM id). Its option
// values are the coach/floor indices (0,1,2,...).
const COACH_SELECT = "#select-bogie";

// Every coach as {value, label}: `value` drives the <select>, `label` is the
// human coach name ("UMA", "THA", ...) used to target one specific coach.
// A trip with no dropdown yields a single nameless coach.
async function coachOptions(page) {
  return page.evaluate((sel) => {
    const s = document.querySelector(sel);
    if (!s) {
      return [{ value: null, label: "" }];
    }
    return [...s.options].map((o) => ({ value: o.value, label: (o.textContent || "").trim() }));
  }, COACH_SELECT);
}

async function selectCoach(page, value) {
  if (value === null) {
    return;
  }
  // Set the value + fire a change event via JS so it works even when the native
  // select is hidden behind a styled "selectpicker" widget.
  await page.evaluate(
    ({ sel, value }) => {
      const s = document.querySelector(sel);
      if (!s) {
        return;
      }
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { sel: COACH_SELECT, value }
  );
  await page.waitForTimeout(1000);
}

// Rows of the currently-visible coach: each row is an ordered list of seat cells.
async function readRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".seat-row")].map((row) =>
      [...row.querySelectorAll(".btn-seat")].map((b) => ({
        title: (b.getAttribute("title") || "").trim(),
        available: b.classList.contains("seat-available"),
        selected: b.classList.contains("seat-selected"),
      }))
    )
  );
}

// Longest run of `count` consecutive available seats within a single row.
function adjacentInRows(rows, count) {
  for (const row of rows) {
    let run = [];
    for (const cell of row) {
      if (cell.available && cell.title) {
        run.push(cell.title);
        if (run.length === count) {
          return run;
        }
      } else {
        run = [];
      }
    }
  }
  return null;
}

function availableTitles(rows) {
  const titles = [];
  for (const row of rows) {
    for (const cell of row) {
      if (cell.available && cell.title) {
        titles.push(cell.title);
      }
    }
  }
  return titles;
}

async function seatHasClass(page, title, className) {
  return page.evaluate(
    ({ title, className }) => {
      const el = [...document.querySelectorAll(".btn-seat")].find(
        (b) => (b.getAttribute("title") || "").trim() === title
      );
      return el ? el.classList.contains(className) : false;
    },
    { title, className }
  );
}

async function waitForSeatClass(page, title, className, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await seatHasClass(page, title, className)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

// A seat keeps its "seat-available" class even while WE have it selected, so a
// release can only be confirmed by "seat-selected" going away — never by
// "seat-available" appearing.
async function waitForSeatClassGone(page, title, className, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await seatHasClass(page, title, className))) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function clickSeat(page, title) {
  await page.locator(`.btn-seat[title="${title}"]`).first().click();
}

// Reserve one seat: click it and wait for it to turn "seat-selected".
async function selectSeat(page, title) {
  await clickSeat(page, title);
  const ok = await waitForSeatClass(page, title, "seat-selected", SEAT_ACTION_TIMEOUT_MS);
  if (!ok) {
    throw new Error(`Seat ${title} did not become selected (reserve failed / Turnstile blocked)`);
  }
  log(`Reserved seat ${title}`);
}

// Reserve a seat and record it in `held` in the SAME step, so a caller's `held`
// list always reflects exactly what is reserved even if a later seat throws.
async function reserveInto(page, coach, title, held) {
  await selectSeat(page, title);
  held.push({ coach, title });
}

/**
 * Release one seat and CONFIRM it. Returns:
 *   "released"     - it was selected, we clicked, and "seat-selected" went away
 *   "not-selected" - this page has no selection for it. That does NOT mean the
 *                    seat is free: re-opening the layout wipes the client-side
 *                    selection while the server still holds the seat, and
 *                    clicking then RE-selects it. So never click in this case.
 *   "stuck"        - we clicked but it is still selected
 */
async function releaseSeat(page, title) {
  if (!(await seatHasClass(page, title, "seat-selected"))) {
    log(`Cannot release ${title}: this page has no selection for it (layout was re-opened?)`);
    return "not-selected";
  }
  await clickSeat(page, title);
  const gone = await waitForSeatClassGone(page, title, "seat-selected", SEAT_ACTION_TIMEOUT_MS);
  if (!gone) {
    log(`Release NOT confirmed for ${title} — still selected`);
    return "stuck";
  }
  log(`Released seat ${title}`);
  return "released";
}

// Normalise a seat number so "tho 44", "THO-44", "tho44" all compare equal.
function normalizeSeat(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// The dropdown labels its coaches "JA - 14 Seat(s)", so the coach name is the
// part before the dash; the seat count changes as seats sell.
function coachName(label) {
  return normalizeSeat(String(label).split("-")[0]);
}

// Keep only the coach whose name matches `coach` ("JA", "ja", "JA - 14 Seat(s)").
// An unset/unmatched filter keeps every coach, so a wrong coach name degrades to
// the old scan-everything behaviour instead of holding nothing.
function filterCoaches(coaches, coach) {
  if (!coach) {
    return coaches;
  }
  const key = coachName(coach);
  const matches = coaches.filter((c) => coachName(c.label) === key);
  if (matches.length === 0) {
    log(`Coach "${coach}" not in the dropdown (${coaches.map((c) => c.label).join(", ")}) — scanning all coaches`);
    return coaches;
  }
  return matches;
}

// Reserve exactly the requested seats. Searched across all coaches, or only
// inside `coach` when one is given. Reserved seats are pushed into `held`;
// returns the requested seats that could not be held (booked or not found).
async function reserveNamedSeats(page, wantedTitles, held, { coach } = {}) {
  const remaining = new Map(wantedTitles.map((t) => [normalizeSeat(t), t]));
  const coaches = filterCoaches(await coachOptions(page), coach);

  for (const { value } of coaches) {
    if (remaining.size === 0) {
      break;
    }
    await selectCoach(page, value);
    const rows = await readRows(page);
    for (const row of rows) {
      for (const cell of row) {
        const key = normalizeSeat(cell.title);
        // "seat-available" survives our own selection, so a seat we already hold
        // still looks free here — clicking it would DESELECT it.
        if (cell.available && !cell.selected && cell.title && remaining.has(key)) {
          await reserveInto(page, value, cell.title, held);
          remaining.delete(key);
        }
      }
    }
  }

  return [...remaining.values()]; // requested but not held
}

/**
 * Reserve up to `count` MORE seats — whatever is free — on top of what is
 * already in `held`. Used when the exact wanted seats are gone and any seats
 * will do; the preference order keeps a party together where possible:
 * adjacent in one coach > any in one coach > spread across coaches.
 *
 * Unlike `pickAndReserve` this is incremental: `count` is how many to ADD, so it
 * can be called repeatedly as seats trickle back. Returns the titles it took.
 */
async function reserveAnyAvailable(page, count, held, { exclude = [] } = {}) {
  if (count <= 0) {
    return [];
  }
  const before = held.length;
  const skip = new Set([...exclude, ...held.map((s) => s.title)].map(normalizeSeat));
  const usable = (rows) =>
    rows.map((row) => row.map((cell) => ({ ...cell, available: cell.available && !cell.selected && !skip.has(normalizeSeat(cell.title)) })));

  const coaches = await coachOptions(page);
  const taken = () => held.slice(before).map((s) => s.title);

  // Pass 1: `count` adjacent seats in one coach — best case, they sit together.
  for (const { value, label } of coaches) {
    await selectCoach(page, value);
    const adjacent = adjacentInRows(usable(await readRows(page)), count);
    if (adjacent) {
      log(`Taking ${count} adjacent seat(s) in coach ${label || "(only)"}: ${adjacent.join(", ")}`);
      for (const title of adjacent) {
        await reserveInto(page, value, title, held).catch((error) => log(`Could not take ${title}: ${error.message}`));
      }
      if (held.length - before >= count) {
        return taken();
      }
    }
  }

  // Pass 2 / 3: anything free, same coach first, then across coaches.
  for (const { value } of coaches) {
    await selectCoach(page, value);
    for (const title of availableTitles(usable(await readRows(page)))) {
      if (held.length - before >= count) {
        return taken();
      }
      await reserveInto(page, value, title, held).catch((error) => log(`Could not take ${title}: ${error.message}`));
    }
  }
  return taken();
}

// Auto-pick seats honouring: adjacent-in-a-coach > any-in-one-coach > across
// coaches. Reserved seats are pushed into `held`.
async function pickAndReserve(page, count, held) {
  const coaches = await coachOptions(page);

  // Pass 1: adjacent seats in one coach.
  for (const { value, label } of coaches) {
    await selectCoach(page, value);
    const adjacent = adjacentInRows(await readRows(page), count);
    if (adjacent) {
      log(`Found ${count} adjacent seat(s) in coach ${label || "(only)"}: ${adjacent.join(", ")}`);
      for (const title of adjacent) {
        await reserveInto(page, value, title, held);
      }
      return;
    }
  }

  // Pass 2: any `count` seats in a single coach.
  for (const { value, label } of coaches) {
    await selectCoach(page, value);
    const titles = availableTitles(await readRows(page));
    if (titles.length >= count) {
      log(`Using ${count} seat(s) in coach ${label || "(only)"}: ${titles.slice(0, count).join(", ")}`);
      for (const title of titles.slice(0, count)) {
        await reserveInto(page, value, title, held);
      }
      return;
    }
  }

  // Pass 3: spread across coaches.
  for (const { value } of coaches) {
    await selectCoach(page, value);
    const titles = availableTitles(await readRows(page));
    for (const title of titles) {
      if (held.length >= count) {
        return;
      }
      await reserveInto(page, value, title, held);
    }
  }
}

/**
 * Release every held seat, retrying the ones that do not come free. Returns
 * { released, unconfirmed } so the caller can refuse to declare a clean handover
 * when a seat is still ours.
 */
async function releaseAll(page, held, attempts = 2) {
  const released = [];
  let pending = [...held];

  for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt += 1) {
    const stillPending = [];
    for (const seat of pending) {
      try {
        await selectCoach(page, seat.coach);
        const outcome = await releaseSeat(page, seat.title);
        if (outcome === "released") {
          released.push(seat.title);
        } else if (outcome === "stuck") {
          stillPending.push(seat);
        } else {
          // "not-selected": clicking would re-reserve it, so leave it alone and
          // report it — the railway frees it on its own within ~5 minutes.
          stillPending.push(seat);
        }
      } catch (error) {
        log(`Release error for ${seat.title}: ${error.message}`);
        stillPending.push(seat);
      }
    }
    pending = stillPending;
    if (pending.length > 0 && attempt < attempts) {
      await sleep(1500);
    }
  }

  return { released, unconfirmed: pending.map((s) => s.title) };
}

/**
 * Hold seats on the given trip by driving the real booking page, then re-hold
 * across `repeatCount` cycles (release + reselect refreshes the hold window),
 * and finally release. `onEvent(msg)` receives human-readable progress lines.
 */
async function holdSeats({
  from,
  to,
  date,
  train,
  seatClass,
  seats = [],
  seatCount,
  repeatCount,
  refreshSeconds,
  onEvent = () => {},
}) {
  return withChromePage(PROFILE_DIR, HOLD_CDP_PORT, async (page) => {
    try {
      await ensureLoggedIn(page);
    } catch (error) {
      await screenshot(page, "holderlogin");
      throw error;
    }

    const url = searchUrl({ from, to, date, seatClass });
    log(`Opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    try {
      await openSeatLayout(page, train, seatClass);
    } catch (error) {
      await screenshot(page, "openlayout");
      throw error;
    }

    // `held` is owned here and mutated in place by the reserve helpers, so the
    // finally block can always release everything that got reserved — even if a
    // later reserve throws mid-way.
    const held = [];
    try {
      let missing = [];
      if (seats.length > 0) {
        missing = await reserveNamedSeats(page, seats, held);
      } else {
        await pickAndReserve(page, seatCount, held);
      }

      if (held.length === 0) {
        await screenshot(page, "noseats");
        throw new Error(
          seats.length > 0
            ? `none of the requested seats could be held: ${seats.join(", ")}`
            : "no free seats could be reserved"
        );
      }

      const startLines = [
        `Auto-hold STARTED: ${train} (${seatClass})`,
        `${from} -> ${to} on ${date}`,
        `Held ${held.length} seat(s): ${held.map((s) => s.title).join(", ")}`,
        `Cycles: ${repeatCount}, refresh every ${refreshSeconds}s`,
      ];
      if (missing.length > 0) {
        startLines.push(`Could not hold (booked/not found): ${missing.join(", ")}`);
      }
      await onEvent(startLines.join("\n"));

      for (let cycle = 1; cycle <= repeatCount; cycle += 1) {
        log(`Hold cycle ${cycle}/${repeatCount}: holding ${held.length} seat(s) for ${refreshSeconds}s`);
        await sleep(refreshSeconds * 1000);

        if (cycle < repeatCount) {
          // Refresh each seat independently so one failure doesn't abort the rest.
          for (const seat of held) {
            try {
              await selectCoach(page, seat.coach);
              await releaseSeat(page, seat.title);
              await selectSeat(page, seat.title);
            } catch (error) {
              log(`Re-hold failed for ${seat.title}: ${error.message}`);
            }
          }
          await onEvent(`Auto-hold cycle ${cycle + 1}/${repeatCount}: re-held ${held.map((s) => s.title).join(", ")}`);
        }
      }

      return { held: held.map((s) => s.title), missing };
    } catch (error) {
      log(`Hold error: ${error.message}`);
      await screenshot(page, "holderror");
      await onEvent(`Auto-hold FAILED: ${train} ${from}->${to}\nReason: ${error.message}`);
      throw error;
    } finally {
      if (held.length > 0) {
        await releaseAll(page, held);
        await onEvent(`Auto-hold DONE: released ${held.map((s) => s.title).join(", ")} for ${train} ${from}->${to}.`);
      }
    }
  });
}

module.exports = {
  holdSeats,
  // Building blocks reused by the multi-account rotation (hold-session.js).
  searchUrl,
  ensureLoggedIn,
  openSeatLayout,
  coachOptions,
  filterCoaches,
  selectCoach,
  readRows,
  selectSeat,
  releaseSeat,
  releaseAll,
  reserveNamedSeats,
  reserveAnyAvailable,
  normalizeSeat,
  screenshot,
};
