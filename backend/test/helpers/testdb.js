// Real Postgres semantics (FOR UPDATE, jsonb, constraints) with no external service.
// node-postgres runs a parameterless multi-statement string as one simple query;
// PGlite needs exec() for that, so the adapter routes by whether params were given.
async function createTestDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  const { migrate } = require("../../src/db/migrate");

  const run = (target) => async (text, params) => {
    if (params === undefined) {
      const results = await target.exec(text);
      return results[results.length - 1] || { rows: [] };
    }
    return target.query(text, params);
  };

  const db = {
    query: run(pg),
    tx: (fn) => pg.transaction(async (tx) => fn({ query: run(tx) })),
    close: () => pg.close(),
  };
  await migrate(db, () => {});
  return db;
}

module.exports = { createTestDb };
