// Read-only client for the two booking-site endpoints we use. Ported from the
// proven src/api-client.js; additions: a request timeout, and ONE shared pause
// gate so the scheduler and interactive calls cannot add up to a flood.
const { isoToSite } = require("./dates");

const API_BASE = "https://railspaapi.shohoz.com/v1.0/web";
const TOKEN_URL = "https://train-iam.shohoz.com/connect/token";
const CLIENT_ID = "train-ticket-user";

class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

class RateLimitedError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createShohozClient({ getSession, fetchImpl = fetch, timeoutMs = 15000, now = Date.now, sleepFn = sleep, log = () => {} }) {
  const state = { pausedUntil: 0 };

  const authHeaders = (s) => ({ Authorization: `Bearer ${s.token}`, "x-device-key": s.ssdk, "x-device-id": s.uudid });

  async function gate(interactive) {
    const remaining = state.pausedUntil - now();
    if (remaining <= 0) return;
    // A person waiting on a button gets a clear error; the background loop just waits.
    if (interactive) throw new RateLimitedError("Rate limited by the booking site; try again shortly", remaining);
    await sleepFn(remaining);
  }

  async function request(url, init, label, { interactive = false } = {}) {
    await gate(interactive);
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new Error(timedOut ? `Request timed out after ${timeoutMs}ms (${label})` : `Network error (${label}): ${error.message}`);
    }
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new SessionExpiredError(`Booking site rejected the session (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      const header = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : 60000;
      // Every request shares one device identity, so the limit applies to all of them.
      state.pausedUntil = now() + retryAfterMs;
      log(`rate limited on ${label}; pausing all requests for ${Math.round(retryAfterMs / 1000)}s`);
      throw new RateLimitedError(`Rate limited (HTTP 429) on ${label}`, retryAfterMs);
    }
    if (!response.ok) throw new Error(`Booking site error HTTP ${response.status} on ${label}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Booking site returned non-JSON on ${label}`);
    }
  }

  return {
    state,

    /** All trains x all classes for one (from, to, date, class) in a single response. */
    async searchTrips({ fromCity, toCity, journeyDate, seatClass }, opts) {
      const session = await getSession();
      if (!session) throw new SessionExpiredError("No session stored");
      const params = new URLSearchParams({
        from_city: fromCity,
        to_city: toCity,
        date_of_journey: isoToSite(journeyDate),
        seat_class: seatClass,
      });
      const payload = await request(`${API_BASE}/bookings/search-trips-v2?${params}`, { headers: authHeaders(session) }, `${fromCity}->${toCity}`, opts);
      return (payload.data && payload.data.trains) || [];
    },

    /** Every stoppage of a train in order. POST only; GET returns 405. */
    async fetchTrainRoute(model, journeyDate, opts) {
      const session = await getSession();
      if (!session) throw new SessionExpiredError("No session stored");
      const payload = await request(
        `${API_BASE}/train-routes`,
        {
          method: "POST",
          headers: { ...authHeaders(session), "Content-Type": "application/json" },
          body: JSON.stringify({ model: String(model), departure_date_time: isoToSite(journeyDate) }),
        },
        `train-routes ${model}`,
        opts
      );
      const data = payload.data || {};
      return {
        trainName: data.train_name || "",
        days: data.days || [],
        stations: (data.routes || []).map((stop) => stop.city).filter(Boolean),
      };
    },

    /**
     * Swap a refresh token for a new access token. Returns {token, refresh_token} or null.
     * Never throws for an expected failure; the caller then asks the owner to log in.
     */
    async refreshToken(session) {
      if (!session || !session.refresh_token) return null;
      let response;
      try {
        response = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-device-key": session.ssdk, "x-device-id": session.uudid },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refresh_token, client_id: CLIENT_ID }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        log(`token refresh request failed: ${error.message}`);
        return null;
      }
      if (!response.ok) {
        log(`token refresh rejected (HTTP ${response.status})`);
        return null;
      }
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.access_token) return null;
      return { token: payload.access_token, refresh_token: payload.refresh_token || session.refresh_token };
    },
  };
}

module.exports = { createShohozClient, SessionExpiredError, RateLimitedError };
