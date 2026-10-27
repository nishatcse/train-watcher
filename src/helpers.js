function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${timestamp()}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`Could not write watcher log: ${error.message}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  sleep,
  log,
  escapeRegExp,
};
const fs = require("fs");
const path = require("path");

const logDir = path.resolve(__dirname, "..", "output");
const logPath = path.join(logDir, "watcher.log");
