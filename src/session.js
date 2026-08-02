const fs = require("fs");
const path = require("path");

const envPath = path.resolve(__dirname, "..", ".env");

function loadSession() {
  const raw = process.env.RAILWAY_SESSION_COOKIES;
  if (!raw) {
    throw new Error("RAILWAY_SESSION_COOKIES is missing from .env. Run `npm run relogin` first.");
  }

  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error("RAILWAY_SESSION_COOKIES could not be decoded. Run `npm run relogin` to recreate it.");
  }
}

function saveSession(session) {
  const encoded = Buffer.from(JSON.stringify(session)).toString("base64");
  const envText = fs.readFileSync(envPath, "utf8");

  const updated = envText.match(/^RAILWAY_SESSION_COOKIES=.*$/m)
    ? envText.replace(/^RAILWAY_SESSION_COOKIES=.*$/m, `RAILWAY_SESSION_COOKIES=${encoded}`)
    : `${envText.trimEnd()}\nRAILWAY_SESSION_COOKIES=${encoded}\n`;

  fs.writeFileSync(envPath, updated, "utf8");
  process.env.RAILWAY_SESSION_COOKIES = encoded;
}

function reloadSessionFromDisk() {
  const envText = fs.readFileSync(envPath, "utf8");
  const match = envText.match(/^RAILWAY_SESSION_COOKIES=(.*)$/m);
  if (!match) {
    throw new Error("RAILWAY_SESSION_COOKIES not found in .env");
  }
  process.env.RAILWAY_SESSION_COOKIES = match[1].trim();
  return loadSession();
}

function tokenExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

module.exports = { loadSession, saveSession, reloadSessionFromDisk, tokenExpiresAt };
