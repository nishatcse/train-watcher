#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const LIVE_URL = "https://brex-live.suncrops.com/dotframe/v100/index4.php";
const UKEY = "2fdf1de5701d6709466a5e3cd41e7693";
const DEFAULT_APP_VERSION = "1.82.12.0";

function usage() {
  console.log(`Usage:
  npm run location -- "TURNA (741)"
  npm run location -- "741"
  npm run location -- "turna"

Required .env:
  BREX_PHONE=01xxxxxxxxx
  BREX_UID=123456
  BREX_UPASS=your_brex_password_or_api_password

Optional .env:
  BREX_DEVICE_ID=...
  BREX_HW_DEVICE_ID=...
  BREX_APP_VERSION=${DEFAULT_APP_VERSION}`);
}

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function parseHandshakeTrains() {
  const raw = process.env.RAILWAY_SESSION_COOKIES;
  if (!raw) {
    return [];
  }

  try {
    const session = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const handshake = JSON.parse(session.handshake_data || "{}");
    return (handshake.train_names || [])
      .map((train) => train.name)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

function trainIdFromText(input) {
  const text = String(input || "").trim();
  const parenthesized = /\((\d{2,5})\)/.exec(text);
  if (parenthesized) {
    return { id: parenthesized[1], label: text };
  }

  if (/^\d{2,5}$/.test(text)) {
    return { id: text, label: text };
  }

  const trains = parseHandshakeTrains();
  if (!trains.length) {
    throw new Error(`Could not find a train number in "${text}". Try exact form like "TURNA (741)".`);
  }

  const needle = normalize(text);
  const matches = trains.filter((name) => normalize(name).includes(needle));

  if (matches.length === 1) {
    return trainIdFromText(matches[0]);
  }

  if (matches.length > 1) {
    throw new Error(
      `Train name "${text}" matched more than one train:\n` +
        matches.slice(0, 20).map((name) => `  - ${name}`).join("\n") +
        "\nUse the exact train number in parentheses."
    );
  }

  throw new Error(`No train matched "${text}" in the saved handshake catalog.`);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|small)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function brexPayload(trainId) {
  return {
    action: "getTrainLocationByTrainID",
    deviceID: process.env.BREX_DEVICE_ID || `D${Date.now()}`,
    hwDeviceID: process.env.BREX_HW_DEVICE_ID || "unknown",
    deviceInfo: process.env.BREX_DEVICE_INFO || "Node.js train-watcher",
    appVersion: process.env.BREX_APP_VERSION || DEFAULT_APP_VERSION,
    phone: requiredEnv("BREX_PHONE"),
    uID: requiredEnv("BREX_UID"),
    os: process.env.BREX_OS || "android",
    txID: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    key: trainId,
    upass: requiredEnv("BREX_UPASS"),
    lat: process.env.BREX_LAT || "0",
    lon: process.env.BREX_LON || "0",
  };
}

async function fetchTrainLocation(trainId) {
  const data = brexPayload(trainId);
  const body = new URLSearchParams({ data: JSON.stringify(data) });

  const response = await fetch(LIVE_URL, {
    method: "POST",
    headers: {
      uKey: UKEY,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "okhttp/3.14.9",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`BR Explorer API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`BR Explorer API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const input = args.join(" ").trim() || process.env.BREX_TRAIN_NAME || process.env.TRAIN_NAME;
  if (!input) {
    usage();
    process.exitCode = 1;
    return;
  }

  const train = trainIdFromText(input);
  const payload = await fetchTrainLocation(train.id);

  if (payload.errorCode !== "0") {
    throw new Error(`BR Explorer error ${payload.errorCode || "unknown"}: ${payload.message || JSON.stringify(payload)}`);
  }

  const info = payload.info || {};
  console.log(`Train: ${train.label}`);
  console.log(`ID: ${train.id}`);
  if (info.timeStamp) {
    console.log(`Server time: ${info.timeStamp}`);
  }
  if (info.position && info.position.lat && info.position.lon) {
    console.log(`Position: ${info.position.lat}, ${info.position.lon}`);
  }
  if (info.locationURL) {
    console.log(`Map: ${info.locationURL}`);
  }
  if (info.message) {
    console.log("");
    console.log(htmlToText(info.message));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
