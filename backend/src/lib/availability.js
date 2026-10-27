// Ported from the proven src/checker.js. The rules here are deliberate:
//  - "available" is ONE number: online quota + counter quota. The owner confirmed (2026-10-27) that
//    every ticket is sold online and the counter has no separate tickets, so the sum is the real
//    number of seats and all of them can be bought on the website. The two parts are therefore never
//    shown or alerted on separately;
//  - alerts are edge-triggered on that total, so an unchanged result never notifies twice.
const { isoToSite } = require("./dates");

const BOOKING_BASE = "https://eticket.railway.gov.bd/booking/train/search";

function buildSearchUrl({ fromCity, toCity, journeyDate, seatClass }) {
  const params = new URLSearchParams({
    fromcity: fromCity,
    tocity: toCity,
    doj: isoToSite(journeyDate),
    class: seatClass,
  });
  return `${BOOKING_BASE}?${params.toString()}`;
}

const NOTHING = { availableCount: 0, onlineCount: 0, offlineCount: 0, fare: null, vat: 0, totalFare: null };

/** `status` separates "sold out" from "this train/class is not on that search". */
function extractAvailability(trains, { trainName, seatClass }) {
  const wanted = String(trainName).trim().toLowerCase();
  const train = (trains || []).find((t) => String(t.trip_number || "").trim().toLowerCase() === wanted);
  if (!train) return { ...NOTHING, status: "train_not_listed" };

  const seatType = (train.seat_types || []).find((s) => s.type === seatClass);
  if (!seatType) return { ...NOTHING, status: "class_not_offered" };

  const online = Number(seatType.seat_counts && seatType.seat_counts.online) || 0;
  const offline = Number(seatType.seat_counts && seatType.seat_counts.offline) || 0;
  const fare = Number(seatType.fare) || 0;
  const vat = Number(seatType.vat_amount) || 0;

  return {
    status: "ok",
    availableCount: online + offline,
    onlineCount: online,
    offlineCount: offline,
    fare: fare || null,
    vat,
    totalFare: fare ? fare + vat : null,
  };
}

/** previous = { availableCount } | null. Notify on first sighting with seats, or when the count changes. */
function shouldNotify(previous, current) {
  if (current.availableCount <= 0) return false;
  if (!previous) return true;
  return previous.availableCount !== current.availableCount;
}

function describe(watcher, result) {
  const url = buildSearchUrl(watcher);
  const route = `${watcher.fromCity} → ${watcher.toCity}`;
  const date = isoToSite(watcher.journeyDate);
  const lines = [
    `Route: ${route}`,
    `Train: ${watcher.trainName}`,
    `Journey: ${date}`,
    `Class: ${watcher.seatClass}`,
    `Available seats: ${result.availableCount}`,
  ];
  if (result.totalFare) {
    lines.push(result.vat > 0 ? `Fare: ${result.totalFare} BDT (${result.fare} + ${result.vat} VAT)` : `Fare: ${result.totalFare} BDT`);
  }
  return { title: "Railway Seat Available", body: lines.join("\n"), url, route, date };
}

module.exports = { buildSearchUrl, extractAvailability, shouldNotify, describe };
