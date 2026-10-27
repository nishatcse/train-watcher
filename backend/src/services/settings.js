const MIN_CYCLE_SECONDS = 10;

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.status = 422;
    this.details = details;
  }
}

const toApi = (r) => ({
  scanCycleSeconds: r.scan_cycle_seconds,
  scanConcurrency: r.scan_concurrency,
  scanJitterMs: r.scan_jitter_ms,
  telegramEnabled: r.telegram_enabled,
  fcmEnabled: r.fcm_enabled,
  minScanCycleSeconds: MIN_CYCLE_SECONDS,
});

async function getRow(db) {
  return (await db.query("select * from app_settings where id = 1")).rows[0];
}

async function getSettings(db) {
  return toApi(await getRow(db));
}

async function updateSettings(db, patch) {
  const cur = await getRow(db);
  const next = {
    scan_cycle_seconds: patch.scanCycleSeconds ?? cur.scan_cycle_seconds,
    scan_concurrency: patch.scanConcurrency ?? cur.scan_concurrency,
    scan_jitter_ms: patch.scanJitterMs ?? cur.scan_jitter_ms,
    telegram_enabled: patch.telegramEnabled ?? cur.telegram_enabled,
    fcm_enabled: patch.fcmEnabled ?? cur.fcm_enabled,
  };

  if (!Number.isInteger(next.scan_cycle_seconds)) throw new ValidationError("scanCycleSeconds must be a whole number");
  if (next.scan_cycle_seconds < MIN_CYCLE_SECONDS) {
    // The brief asks for the limit to be explained with an alternative, not silently clamped.
    throw new ValidationError(
      `A ${next.scan_cycle_seconds}s cycle is below the ${MIN_CYCLE_SECONDS}s minimum. The booking site publishes no rate limit and enforces one silently; ` +
        `going faster risks a temporary block or a ban of the account. Use ${MIN_CYCLE_SECONDS}s or more (default 15s).`,
      { field: "scanCycleSeconds", min: MIN_CYCLE_SECONDS }
    );
  }
  if (!Number.isInteger(next.scan_concurrency) || next.scan_concurrency < 1 || next.scan_concurrency > 4) {
    throw new ValidationError("scanConcurrency must be between 1 and 4", { field: "scanConcurrency" });
  }
  if (!Number.isInteger(next.scan_jitter_ms) || next.scan_jitter_ms < 0 || next.scan_jitter_ms > 2000) {
    throw new ValidationError("scanJitterMs must be between 0 and 2000", { field: "scanJitterMs" });
  }
  if (typeof next.telegram_enabled !== "boolean" || typeof next.fcm_enabled !== "boolean") {
    throw new ValidationError("telegramEnabled and fcmEnabled must be booleans");
  }

  await db.query(
    `update app_settings set scan_cycle_seconds=$1, scan_concurrency=$2, scan_jitter_ms=$3,
       telegram_enabled=$4, fcm_enabled=$5, updated_at=now() where id=1`,
    [next.scan_cycle_seconds, next.scan_concurrency, next.scan_jitter_ms, next.telegram_enabled, next.fcm_enabled]
  );
  return getSettings(db);
}

module.exports = { getSettings, updateSettings, ValidationError, MIN_CYCLE_SECONDS };
