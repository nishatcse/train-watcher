const { isValidIso, todayDhaka, daysBetween } = require("../lib/dates");
const { validateWatcher } = require("../lib/catalog");
const { badRequest, conflict, notFound } = require("../lib/errors");

const SELECT = `
  select w.id, w.from_city, w.to_city, to_char(w.journey_date, 'YYYY-MM-DD') as journey_date,
         w.train_name, w.seat_class, w.enabled, w.last_check_status, w.last_checked_at, w.last_error,
         w.validation_warnings, w.created_at, w.updated_at,
         s.available_count, s.online_count, s.offline_count, s.total_fare
  from watchers w left join availability_state s on s.watcher_id = w.id`;

const toApi = (r) => ({
  id: r.id,
  fromCity: r.from_city,
  toCity: r.to_city,
  journeyDate: r.journey_date,
  trainName: r.train_name,
  seatClass: r.seat_class,
  enabled: r.enabled,
  lastCheckStatus: r.last_check_status,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  warnings: r.validation_warnings || [],
  availableSeats: r.available_count ?? null,
  onlineSeats: r.online_count ?? null,
  counterSeats: r.offline_count ?? null,
  totalFare: r.total_fare === null || r.total_fare === undefined ? null : Number(r.total_fare),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const text = (v) => (typeof v === "string" ? v.trim() : "");

/** Structural validation (hard errors). Catalog mismatches are warnings, handled separately. */
function parseInput(body, { partial = false } = {}) {
  const out = {};
  const fields = { fromCity: "fromCity", toCity: "toCity", trainName: "trainName", seatClass: "seatClass" };
  for (const key of Object.keys(fields)) {
    if (body[key] === undefined && partial) continue;
    const v = text(body[key]);
    if (!v) throw badRequest(`${key} is required`, { field: key });
    out[key] = v;
  }
  if (body.journeyDate !== undefined || !partial) {
    if (!isValidIso(body.journeyDate)) throw badRequest("journeyDate must be a real date in YYYY-MM-DD form", { field: "journeyDate" });
    out.journeyDate = body.journeyDate;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw badRequest("enabled must be true or false", { field: "enabled" });
    out.enabled = body.enabled;
  }
  return out;
}

function assertNotPast(journeyDate) {
  if (daysBetween(todayDhaka(), journeyDate) < 0) {
    throw badRequest("That journey date is in the past.", { field: "journeyDate" });
  }
}

const isUniqueViolation = (e) => e && e.code === "23505";

function createWatchers({ db, getCatalog }) {
  async function one(id) {
    const r = await db.query(`${SELECT} where w.id = $1`, [id]);
    if (!r.rows[0]) throw notFound("Watcher");
    return r.rows[0];
  }

  return {
    async list() {
      return (await db.query(`${SELECT} order by w.journey_date, w.created_at`)).rows.map(toApi);
    },

    async get(id) {
      return toApi(await one(id));
    },

    async create(body) {
      const input = parseInput(body);
      if (input.fromCity === input.toCity) throw badRequest("From and To must be different stations.", { field: "toCity" });
      assertNotPast(input.journeyDate);
      const warnings = validateWatcher(await getCatalog(), input);
      try {
        const r = await db.query(
          `insert into watchers (from_city, to_city, journey_date, train_name, seat_class, enabled, validation_warnings)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [input.fromCity, input.toCity, input.journeyDate, input.trainName, input.seatClass, input.enabled ?? true, JSON.stringify(warnings)]
        );
        return { watcher: await this.get(r.rows[0].id), warnings };
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("You are already watching exactly this journey.");
        throw error;
      }
    },

    async update(id, body) {
      const current = toApi(await one(id));
      const patch = parseInput(body, { partial: true });
      const next = { ...current, ...patch };
      if (next.fromCity === next.toCity) throw badRequest("From and To must be different stations.", { field: "toCity" });
      if (patch.journeyDate) assertNotPast(patch.journeyDate);

      const identityChanged = ["fromCity", "toCity", "journeyDate", "trainName", "seatClass"].some((k) => next[k] !== current[k]);
      const warnings = validateWatcher(await getCatalog(), next);
      try {
        await db.tx(async (tx) => {
          await tx.query(
            `update watchers set from_city=$2, to_city=$3, journey_date=$4, train_name=$5, seat_class=$6, enabled=$7,
               validation_warnings=$8, updated_at=now(),
               last_check_status = case when $9 then null else last_check_status end,
               last_error = case when $9 then null else last_error end
             where id=$1`,
            [id, next.fromCity, next.toCity, next.journeyDate, next.trainName, next.seatClass, next.enabled, JSON.stringify(warnings), identityChanged]
          );
          // A different journey is a fresh observation: forget what the old one last showed.
          if (identityChanged) await tx.query("delete from availability_state where watcher_id = $1", [id]);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("You are already watching exactly this journey.");
        throw error;
      }
      return { watcher: await this.get(id), warnings };
    },

    async remove(id) {
      const r = await db.query("delete from watchers where id = $1 returning id", [id]);
      if (!r.rows[0]) throw notFound("Watcher");
    },

    async listEnabled() {
      return (await db.query(`${SELECT} where w.enabled order by w.created_at`)).rows.map(toApi);
    },

    parseInput,
    toApi,
  };
}

module.exports = { createWatchers, parseInput };
