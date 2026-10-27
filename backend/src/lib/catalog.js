const { isoToSite, todayDhaka, daysBetween } = require("./dates");

/** handshake_data (the JSON the booking site hands the browser at login) -> app catalog. */
function buildCatalog(handshakeJson) {
  const data = typeof handshakeJson === "string" ? JSON.parse(handshakeJson) : handshakeJson;
  const cities = (data.cities || [])
    .map((c) => ({ id: c.city_id, name: c.city_name, canDepart: c.is_enable_for_from === 1, top: c.is_top_city === true }))
    .sort((a, b) => Number(b.top) - Number(a.top) || a.name.localeCompare(b.name));
  const trains = (data.train_names || []).map((t) => ({ model: String(t.model), name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
  const classes = ((data.seat_types || {}).en || []).map((s) => s.seat_class);
  return {
    cities,
    trains,
    classes,
    searchDayLimit: Number(data.trip_search_day_limit) || null,
    maxTicketsPerOrder: Number(data.max_ticket_per_order) || null,
    maintenance: data.maintenance === true,
  };
}

/**
 * Non-blocking problems with a watcher. The catalog can itself be stale, so these
 * are warnings the owner sees, never a reason to refuse to save.
 */
function validateWatcher(catalog, w, today = todayDhaka()) {
  if (!catalog || !catalog.cities.length) return [];
  const warnings = [];
  const city = (name) => catalog.cities.find((c) => c.name === name);

  for (const [label, name] of [["from", w.fromCity], ["to", w.toCity]]) {
    const c = city(name);
    if (!c) warnings.push(`"${name}" is not a station the site lists (${label}). Check the spelling.`);
    else if (label === "from" && !c.canDepart) warnings.push(`"${name}" cannot be used as a departure station.`);
  }
  if (!catalog.trains.some((t) => t.name === w.trainName)) warnings.push(`"${w.trainName}" is not a train the site lists.`);
  if (!catalog.classes.includes(w.seatClass)) warnings.push(`"${w.seatClass}" is not a seat class the site lists.`);

  const days = daysBetween(today, w.journeyDate);
  if (days < 0) warnings.push(`The journey date (${isoToSite(w.journeyDate)}) is in the past.`);
  else if (catalog.searchDayLimit && days > catalog.searchDayLimit) {
    warnings.push(`Booking opens ${catalog.searchDayLimit} days ahead; this journey is ${days} days away, so nothing will show until then.`);
  }
  return warnings;
}

module.exports = { buildCatalog, validateWatcher };
