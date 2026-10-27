const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Applies every unapplied .sql file in order, each inside its own transaction. */
async function migrate(db, log = console.log) {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  const done = new Set((await db.query("select name from schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.tx(async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    log(`migration applied: ${file}`);
  }
}

module.exports = { migrate };

if (require.main === module) {
  const { createPgDb } = require("./pool");
  const db = createPgDb(process.env.DATABASE_URL);
  migrate(db)
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`migration failed: ${error.message}`);
      process.exit(1);
    });
}
