// Fallback when the phone cannot complete the login itself: push the session that
// `npm run relogin` saved in the watcher's .env to YOUR backend (admin token required).
//   BACKEND_URL=https://... ADMIN_TOKEN=... node scripts/push-local-session.js [path/to/.env]
const fs = require("fs");
const path = require("path");

async function main() {
  const base = (process.env.BACKEND_URL || "").replace(/\/$/, "");
  const admin = process.env.ADMIN_TOKEN;
  if (!base || !admin) throw new Error("Set BACKEND_URL and ADMIN_TOKEN");

  const envPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", ".env"));
  const line = fs.readFileSync(envPath, "utf8").match(/^RAILWAY_SESSION_COOKIES=(.*)$/m);
  if (!line || !line[1].trim()) throw new Error(`No RAILWAY_SESSION_COOKIES in ${envPath}. Run \`npm run relogin\` first.`);
  const session = JSON.parse(Buffer.from(line[1].trim(), "base64").toString("utf8"));

  const response = await fetch(`${base}/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": admin },
    body: JSON.stringify(session),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Backend refused the session (HTTP ${response.status}): ${(body.error && body.error.message) || "unknown"}`);
  console.log(`Session accepted. Status: ${body.status}, expires ${body.expiresAt}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
