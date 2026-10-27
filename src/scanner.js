const { fetchTrainRoute, RateLimitedError, SessionExpiredError } = require("./api-client");
const { sleep, log } = require("./helpers");

// "TURNA (742)" -> "742". The /train-routes endpoint wants the bare model.
function trainModel(trainName) {
  const match = /\((\d+)\)/.exec(trainName || "");
  return match ? match[1] : null;
}

/**
 * Every forward station pair of a route: 9 stations -> 36 pairs. Backward pairs
 * are skipped because a train only sells seats in its direction of travel.
 */
function forwardPairs(stations) {
  const pairs = [];
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      pairs.push({ from: stations[i], to: stations[j] });
    }
  }
  return pairs;
}

// Cached per train+date: the stoppage list does not change during a run, and
// re-fetching it on every tick would waste a request per route.
const routeCache = new Map();

async function stationsForRoute(route) {
  const model = trainModel(route.train);
  if (!model) {
    throw new Error(`Cannot expand ${route.train}: train name has no "(number)" to use as the model`);
  }

  const key = `${model}__${route.date}`;
  if (!routeCache.has(key)) {
    const info = await fetchTrainRoute(model, route.date);
    if (info.stations.length < 2) {
      throw new Error(`/train-routes returned no stoppages for ${route.train} on ${route.date}`);
    }
    log(`${route.train} has ${info.stations.length} stoppages: ${info.stations.join(" -> ")}`);
    routeCache.set(key, info.stations);
  }

  return routeCache.get(key);
}

/**
 * Expand a route with `scanAllPairs: true` into one route per station pair,
 * keeping the train/class/date. A 9-stoppage train becomes 36 routes, each of
 * which is a normal route object the existing checker understands.
 */
async function expandRoute(route) {
  if (!route.scanAllPairs) {
    return [route];
  }

  const stations = await stationsForRoute(route);
  return forwardPairs(stations).map((pair) => ({ ...route, from: pair.from, to: pair.to }));
}

async function expandRoutes(routes) {
  const expanded = [];
  for (const route of routes) {
    try {
      expanded.push(...(await expandRoute(route)));
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        throw error;
      }
      log(`Could not expand ${route.train}: ${error.message} — polling the single pair instead`);
      expanded.push({ ...route, scanAllPairs: false });
    }
  }
  return expanded;
}

/**
 * Run `task` over `items` with at most `concurrency` in flight. Node's fetch is
 * I/O bound, so this needs no child processes — ten extra Node runtimes would
 * cost ~400MB on a Pi and buy nothing.
 *
 * Every request carries the same x-device-id, so the server sees one device:
 * a `jitterMs` stagger keeps the burst from looking like a flood, and a 429
 * pauses the whole batch rather than just the unlucky request.
 */
async function runPool(items, { concurrency, jitterMs }, task) {
  const results = new Array(items.length);
  let next = 0;
  let pausedUntil = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;

      const wait = Math.max(pausedUntil - Date.now(), 0) + Math.floor(Math.random() * jitterMs);
      if (wait > 0) {
        await sleep(wait);
      }

      try {
        results[index] = { ok: true, value: await task(items[index]) };
      } catch (error) {
        if (error instanceof RateLimitedError) {
          // Hold every worker back, not just this one — the limit is per device.
          pausedUntil = Date.now() + error.retryAfterMs;
          log(`Rate limited; pausing all scanning for ${Math.round(error.retryAfterMs / 1000)}s`);
        }
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

module.exports = { expandRoutes, forwardPairs, trainModel, runPool };
