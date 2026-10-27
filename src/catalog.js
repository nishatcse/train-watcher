const { loadSession } = require("./session");
const { log } = require("./helpers");

// The login handshake hands the browser a full catalogue — 260 cities, 148
// trains, every seat class, and the booking limits — and session.js already
// stores it in .env. Nothing used it, so a typo in routes.json used to show up
// as hours of "0 seats" instead of an error.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function loadCatalog() {
  const session = loadSession();
  if (!session.handshake_data) {
    return null;
  }

  try {
    const data = JSON.parse(session.handshake_data);
    return {
      cities: new Set((data.cities || []).map((c) => c.city_name)),
      trains: new Set((data.train_names || []).map((t) => t.name)),
      classes: new Set(((data.seat_types || {}).en || []).map((s) => s.seat_class)),
      searchDayLimit: Number(data.trip_search_day_limit) || null,
      maxTicketsPerOrder: Number(data.max_ticket_per_order) || null,
      counterUpdateTime: data.update_counter_on || null,
      maintenance: data.maintenance === true,
    };
  } catch (error) {
    log(`Could not parse handshake_data: ${error.message}`);
    return null;
  }
}

// routes.json uses the site's own "27-Jul-2026" format.
function parseRouteDate(text) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((text || "").trim());
  if (!match) {
    return null;
  }
  const month = MONTHS.findIndex((m) => m.toLowerCase() === match[2].toLowerCase());
  if (month < 0) {
    return null;
  }
  return new Date(Number(match[3]), month, Number(match[1]));
}

function daysFromToday(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date - today) / 86400000);
}

/**
 * Check every route against the catalogue and return the problems as strings.
 * City and train names must match the site exactly; the journey date has to sit
 * inside the booking window the server itself declares.
 *
 * Returns [] when there is no catalogue to check against — a missing handshake
 * blob should not stop the watcher from running.
 */
function validateRoutes(routes) {
  const catalog = loadCatalog();
  if (!catalog) {
    log("No handshake_data in the session; skipping route validation");
    return [];
  }

  const problems = [];

  for (const route of routes) {
    const where = `${route.from}->${route.to} ${route.date}`;

    // scanAllPairs routes reach stations that are not valid origins on their
    // own, so only check the endpoints the user actually typed.
    for (const [label, city] of [["from", route.from], ["to", route.to]]) {
      if (!catalog.cities.has(city)) {
        problems.push(`${where}: "${city}" is not a station name the site knows (check spelling/case in the ${label} field)`);
      }
    }

    if (!catalog.trains.has(route.train)) {
      problems.push(`${where}: "${route.train}" is not a train the site lists (expected e.g. "TURNA (742)")`);
    }

    if (!catalog.classes.has(route.class)) {
      problems.push(`${where}: "${route.class}" is not a seat class (valid: ${[...catalog.classes].join(", ")})`);
    }

    const date = parseRouteDate(route.date);
    if (!date) {
      problems.push(`${where}: date must look like "07-Aug-2026"`);
      continue;
    }

    const days = daysFromToday(date);
    if (days < 0) {
      problems.push(`${where}: the journey date is ${-days} day(s) in the past`);
    } else if (catalog.searchDayLimit && days > catalog.searchDayLimit) {
      problems.push(
        `${where}: ${days} days away, but the site only sells ${catalog.searchDayLimit} days ahead — nothing will show up yet`
      );
    }
  }

  return problems;
}

module.exports = { loadCatalog, validateRoutes, parseRouteDate, daysFromToday };
