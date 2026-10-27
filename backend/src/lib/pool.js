const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task` over `items` with at most `concurrency` in flight. A random pre-request
 * stagger keeps a burst from looking like a flood. Every item yields {ok, value|error}
 * so one failing target never stops the rest. (A 429 pause is handled by the shared
 * gate inside the Shohoz client, so every worker waits, not just the unlucky one.)
 */
async function runPool(items, { concurrency, jitterMs }, task, sleepFn = sleep) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      if (jitterMs > 0) await sleepFn(Math.floor(Math.random() * jitterMs));
      try {
        results[index] = { ok: true, value: await task(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Collapse watchers into unique search targets. One search response lists every
 * train for a (from, to, date, class), so watchers that differ only by train share a request.
 */
function groupTargets(watchers) {
  const map = new Map();
  for (const w of watchers) {
    const key = [w.fromCity, w.toCity, w.journeyDate, w.seatClass].join("|");
    if (!map.has(key)) {
      map.set(key, { key, fromCity: w.fromCity, toCity: w.toCity, journeyDate: w.journeyDate, seatClass: w.seatClass, watchers: [] });
    }
    map.get(key).watchers.push(w);
  }
  return [...map.values()];
}

module.exports = { runPool, groupTargets };
