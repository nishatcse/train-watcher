const { isValidIso, todayDhaka, daysBetween } = require("../lib/dates");
const { badRequest, conflict, notFound } = require("../lib/errors");

const MIN_HOLD_SECONDS = 60;
const MAX_HOLD_SECONDS = 3600;
const ACTIVE = ["queued", "running", "stopping"];

const text = (v) => (typeof v === "string" ? v.trim() : "");

const toApi = (r) => ({
  id: r.id,
  fromCity: r.from_city,
  toCity: r.to_city,
  journeyDate: r.journey_date,
  trainName: r.train_name,
  seatClass: r.seat_class,
  bogieName: r.bogie_name,
  seatNumbers: r.seat_numbers,
  seatCount: r.seat_count,
  holdSeconds: r.hold_seconds,
  stopAt: r.stop_at,
  status: r.status,
  phase: r.phase,
  cycleCount: r.cycle_count,
  heldSeats: r.held_seats || [],
  blockedUntil: r.blocked_until,
  lastError: r.last_error,
  active: ACTIVE.includes(r.status),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const SELECT = `select id, from_city, to_city, to_char(journey_date, 'YYYY-MM-DD') as journey_date, train_name, seat_class,
  bogie_name, seat_numbers, seat_count, hold_seconds, stop_at, status, phase, cycle_count, held_seats, blocked_until,
  last_error, created_at, updated_at, started_at, finished_at from holds`;

/** Structural validation. Throws a 422 naming the field. */
function parseInput(body, now = Date.now()) {
  const out = {};
  for (const key of ["fromCity", "toCity", "trainName"]) {
    const v = text(body[key]);
    if (!v) throw badRequest(`${key} is required`, { field: key });
    out[key] = v;
  }
  if (out.fromCity.toLowerCase() === out.toCity.toLowerCase()) throw badRequest("From and To must differ", { field: "toCity" });
  if (!isValidIso(body.journeyDate)) throw badRequest("journeyDate must be a real date in YYYY-MM-DD form", { field: "journeyDate" });
  if (daysBetween(todayDhaka(new Date(now)), body.journeyDate) < 0) throw badRequest("That journey date is in the past.", { field: "journeyDate" });
  out.journeyDate = body.journeyDate;
  out.seatClass = text(body.seatClass).toUpperCase() || "S_CHAIR";
  out.bogieName = text(body.bogieName);

  const seats = text(body.seatNumbers)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (seats.some((s) => !/^[A-Z0-9]{1,6}-\d{1,3}$/.test(s))) throw badRequest("Seat numbers look like KA-1,KA-2", { field: "seatNumbers" });
  if (seats.length > 4) throw badRequest("At most 4 seats can be held at a time", { field: "seatNumbers" });
  if (new Set(seats).size !== seats.length) throw badRequest("A seat number is repeated", { field: "seatNumbers" });
  out.seatNumbers = seats.join(",");

  const count = body.seatCount === undefined ? seats.length || 2 : Number(body.seatCount);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw badRequest("seatCount must be 1 to 4", { field: "seatCount" });
  out.seatCount = seats.length ? seats.length : count;

  const hold = body.holdSeconds === undefined ? 375 : Number(body.holdSeconds);
  if (!Number.isFinite(hold) || hold < MIN_HOLD_SECONDS || hold > MAX_HOLD_SECONDS) {
    throw badRequest(`holdSeconds must be ${MIN_HOLD_SECONDS} to ${MAX_HOLD_SECONDS} (shorter cycles get the account blocked by the site)`, { field: "holdSeconds" });
  }
  out.holdSeconds = Math.round(hold);

  if (body.stopAt !== undefined && body.stopAt !== null && body.stopAt !== "") {
    const t = Date.parse(body.stopAt);
    if (Number.isNaN(t)) throw badRequest("stopAt must be a date and time", { field: "stopAt" });
    if (t <= now) throw badRequest("stopAt is already in the past", { field: "stopAt" });
    out.stopAt = new Date(t).toISOString();
  } else {
    out.stopAt = null;
  }
  return out;
}

function createHolds({ db, now = Date.now }) {
  async function event(holdId, message) {
    await db.query("insert into hold_events (hold_id, message) values ($1, $2)", [holdId, String(message).slice(0, 500)]);
  }

  return {
    parseInput: (body) => parseInput(body, now()),

    async create(body) {
      const v = parseInput(body, now());
      let row;
      try {
        row = (
          await db.query(
            `insert into holds (from_city, to_city, journey_date, train_name, seat_class, bogie_name, seat_numbers,
                                seat_count, hold_seconds, stop_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
            [v.fromCity, v.toCity, v.journeyDate, v.trainName, v.seatClass, v.bogieName, v.seatNumbers, v.seatCount, v.holdSeconds, v.stopAt],
          )
        ).rows[0];
      } catch (e) {
        if (/holds_single_active|duplicate key/.test(String(e.message))) throw conflict("A hold is already running. Stop it first.");
        throw e;
      }
      await event(row.id, "Queued by the app");
      return this.get(row.id);
    },

    /** The active hold if there is one, otherwise the most recent. */
    async current() {
      const r = (await db.query(`${SELECT} order by (status in ('queued','running','stopping')) desc, created_at desc limit 1`)).rows[0];
      return r ? this.get(r.id) : null;
    },

    async get(id) {
      const r = (await db.query(`${SELECT} where id::text = $1`, [String(id)])).rows[0];
      if (!r) throw notFound("Hold");
      const events = (await db.query("select at, message from hold_events where hold_id = $1 order by id desc limit 100", [r.id])).rows;
      return { hold: toApi(r), events: events.map((e) => ({ at: e.at, message: e.message })) };
    },

    async list(limit = 20) {
      return (await db.query(`${SELECT} order by created_at desc limit $1`, [limit])).rows.map(toApi);
    },

    // ------------------------------------------------------------------------------------------------ worker side
    // Used only through /admin/worker/* by the holder-worker, which has no database access of its own.

    /** The worker renews this every few seconds; a second worker is refused until the first one has been silent. */
    async lease(workerId, ttlSeconds = 45) {
      const r = await db.query(
        `update worker_lease set worker_id = $1, seen_at = now()
         where id = 1 and (worker_id is null or worker_id = $1 or seen_at < now() - ($2 || ' seconds')::interval)
         returning worker_id`,
        [workerId, String(ttlSeconds)],
      );
      return { ok: r.rows.length === 1 };
    },

    /** Picks up the single active hold: queued -> running, or a running one left behind by a restarted worker. */
    async claim() {
      const r = (await db.query(`${SELECT} where status in ('running','queued') order by (status='running') desc, created_at limit 1`)).rows[0];
      if (!r) return { hold: null };
      const resumed = r.status === 'running';
      if (!resumed) await db.query("update holds set status='running', started_at=now(), updated_at=now() where id=$1", [r.id]);
      await event(r.id, resumed ? "Worker resumed this hold" : "Worker picked it up");
      return { hold: toApi({ ...r, status: "running" }), resumed };
    },

    async workerEvent(id, message) {
      if (!message) throw badRequest("message is required");
      await event(id, message);
    },

    /** Progress fields only; the status itself changes through finish() / stop requests. */
    async workerUpdate(id, fields) {
      const allowed = { phase: "text", held_seats: "array", cycle_count: "int", blocked_until: "date", last_error: "text" };
      const keys = Object.keys(fields || {}).filter((k) => allowed[k]);
      if (!keys.length) return;
      const values = keys.map((k) => {
        const v = fields[k];
        if (allowed[k] === "array") return Array.isArray(v) ? v.map((x) => String(x).slice(0, 12)).slice(0, 8) : [];
        if (allowed[k] === "int") return Number.isInteger(v) ? v : 0;
        if (allowed[k] === "date") return v ? new Date(v).toISOString() : null;
        return v === null || v === undefined ? null : String(v).slice(0, 300);
      });
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      await db.query(`update holds set ${sets}, updated_at = now() where id::text = $1`, [String(id), ...values]);
    },

    async workerStatus(id) {
      const r = (await db.query("select status from holds where id::text = $1", [String(id)])).rows[0];
      return { status: r ? r.status : null };
    },

    /** `interrupted`: the worker is being redeployed; the hold stays 'running' so the next worker resumes it. */
    async workerFinish(id, { status, error, interrupted }) {
      if (interrupted) {
        await db.query("update holds set phase=null, held_seats='{}', updated_at=now() where id::text=$1", [String(id)]);
        return;
      }
      if (!["finished", "stopped", "failed"].includes(status)) throw badRequest("status must be finished, stopped or failed");
      await db.query(
        "update holds set status=$2, last_error=$3, phase=null, held_seats='{}', finished_at=now(), updated_at=now() where id::text=$1",
        [String(id), status, error ? String(error).slice(0, 300) : null],
      );
    },

    /** Asks the worker to release the seats and stop. A hold that never started is simply cancelled. */
    async requestStop(id) {
      const r = (await db.query("select id, status from holds where id::text = $1", [String(id)])).rows[0];
      if (!r) throw notFound("Hold");
      if (r.status === "queued") {
        await db.query("update holds set status='stopped', phase=null, finished_at=now(), updated_at=now() where id=$1", [r.id]);
        await event(r.id, "Cancelled before it started");
      } else if (r.status === "running") {
        await db.query("update holds set status='stopping', updated_at=now() where id=$1", [r.id]);
        await event(r.id, "Stop requested by the app");
      }
      return this.get(r.id);
    },
  };
}

module.exports = { createHolds, parseInput, toApi, ACTIVE, MIN_HOLD_SECONDS };
