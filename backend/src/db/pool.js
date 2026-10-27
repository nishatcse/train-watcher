const { Pool } = require("pg");

/**
 * Thin database interface shared by the app and the tests (which swap in PGlite):
 *   db.query(text, params) -> { rows }
 *   db.tx(async (client) => ...)  -> client.query(text, params), committed on return
 */
function createPgDb(connectionString) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  // Railway's public proxy needs TLS; the private network (*.railway.internal) does not.
  const needsSsl = /proxy\.rlwy\.net|sslmode=require/.test(connectionString);
  const pool = new Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  // A dropped idle connection must not crash the process.
  pool.on("error", (error) => console.error(`pg pool error: ${error.message}`));

  return {
    query: (text, params) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

module.exports = { createPgDb };
