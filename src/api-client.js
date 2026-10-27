const { loadSession } = require("./session");

const API_BASE = "https://railspaapi.shohoz.com/v1.0/web";
const SEARCH_URL = `${API_BASE}/bookings/search-trips-v2`;
const TRAIN_ROUTES_URL = `${API_BASE}/train-routes`;

class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

// Thrown on HTTP 429 so callers can back off for the whole device instead of
// retrying the one request that happened to get unlucky.
class RateLimitedError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.token}`,
    "x-device-key": session.ssdk,
    "x-device-id": session.uudid,
  };
}

async function readApiResponse(response, label) {
  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError(`Railway API rejected the session (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (response.status === 429) {
    // Honour Retry-After when the server sends one; otherwise back off a minute.
    const header = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : 60000;
    throw new RateLimitedError(`Railway API rate limited ${label} (HTTP 429)`, retryAfterMs);
  }

  if (!response.ok) {
    throw new Error(`Railway API error HTTP ${response.status} on ${label}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Railway API returned non-JSON response on ${label}: ${text.slice(0, 200)}`);
  }
}

async function searchTrips(route) {
  const session = loadSession();
  const params = new URLSearchParams({
    from_city: route.from,
    to_city: route.to,
    date_of_journey: route.date,
    seat_class: route.class,
  });

  const response = await fetch(`${SEARCH_URL}?${params.toString()}`, { headers: authHeaders(session) });
  const payload = await readApiResponse(response, `${route.from}->${route.to}`);

  return (payload.data && payload.data.trains) || [];
}

/**
 * Every stoppage of a train, in order. `model` is the bare number from a train
 * name — "TURNA (742)" -> "742". Only POST is allowed here; GET returns 405.
 * Lets the scanner build the station pairs itself instead of hand-maintaining
 * a list in routes.json.
 */
async function fetchTrainRoute(trainModel, date) {
  const session = loadSession();

  const response = await fetch(TRAIN_ROUTES_URL, {
    method: "POST",
    headers: { ...authHeaders(session), "Content-Type": "application/json" },
    body: JSON.stringify({ model: trainModel, departure_date_time: date }),
  });

  const payload = await readApiResponse(response, `train-routes ${trainModel}`);
  const data = payload.data || {};

  return {
    trainName: data.train_name || "",
    totalDuration: data.total_duration || "",
    days: data.days || [],
    stations: (data.routes || []).map((stop) => stop.city).filter(Boolean),
  };
}

module.exports = { searchTrips, fetchTrainRoute, SessionExpiredError, RateLimitedError };
