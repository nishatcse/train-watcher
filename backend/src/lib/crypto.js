const crypto = require("crypto");

// AES-256-GCM. The key lives in an env var, never in the database, so a leaked
// database dump alone does not expose the railway session.
function loadKey(keyB64) {
  const key = Buffer.from(String(keyB64 || ""), "base64");
  if (key.length !== 32) {
    throw new Error("SESSION_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  return key;
}

function encrypt(plaintext, keyB64) {
  const key = loadKey(keyB64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

function decrypt(blob, keyB64) {
  const key = loadKey(keyB64);
  const [version, iv, tag, data] = String(blob).split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised encrypted blob");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

// No 0/O/1/I/L: the code is read off a screen and typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function pairingCode(length = 8) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { encrypt, decrypt, sha256, randomToken, pairingCode, safeEqual };
