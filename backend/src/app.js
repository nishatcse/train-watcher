const express = require("express");
const { createApiRouter } = require("./routes/api");
const { redact } = require("./lib/log");

function createApp(deps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Railway's proxy: req.ip is the real client
  app.use(express.json({ limit: "1mb" }));

  // Process-alive only (no DB dependency) so a database blip never makes the host restart us.
  app.get("/health", (_req, res) => res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await deps.db.query("select 1");
      res.json({ ok: true, db: "up" });
    } catch {
      res.status(503).json({ ok: false, db: "down" });
    }
  });

  app.use(createApiRouter(deps));

  app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "No such endpoint" } }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "bad_json", message: "Request body is not valid JSON" } });
    }
    const status = error.status && error.status >= 400 && error.status < 600 ? error.status : null;
    if (status) {
      // Booking-site errors surface as 502/503 so the app can say "the railway site is the problem".
      return res.status(status).json({ error: { code: error.code || "error", message: error.message, details: error.details } });
    }
    if (error.name === "RateLimitedError") {
      return res.status(503).json({ error: { code: "rate_limited", message: error.message, retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) } });
    }
    if (error.name === "SessionExpiredError") {
      return res.status(409).json({ error: { code: "session_required", message: "Railway login required. Open Session Status and log in." } });
    }
    if (/^(Network error|Request timed out|Booking site)/.test(error.message)) {
      return res.status(502).json({ error: { code: "upstream_error", message: error.message } });
    }
    deps.log(`unhandled error: ${redact(error.stack || error.message)}`);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong on the server" } });
  });

  return app;
}

module.exports = { createApp };
