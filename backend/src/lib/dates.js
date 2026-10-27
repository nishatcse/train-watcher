// The app and database speak ISO (YYYY-MM-DD). Shohoz and its booking URLs speak
// "31-Oct-2026". This is the only place the two are converted.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isValidIso(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isoToSite(iso) {
  if (!isValidIso(iso)) throw new Error(`Invalid ISO date: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}-${MONTHS[m - 1]}-${y}`;
}

function siteToIso(site) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(site || "").trim());
  if (!match) return null;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === match[2].toLowerCase());
  if (month < 0) return null;
  const iso = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return isValidIso(iso) ? iso : null;
}

// Bangladesh has no DST, so a fixed zone name is enough. "Today" must follow BST,
// not the server's UTC clock, or journeys flip to "past" six hours early.
function todayDhaka(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function daysBetween(fromIso, toIso) {
  const a = Date.UTC(...fromIso.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const b = Date.UTC(...toIso.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((b - a) / 86400000);
}

module.exports = { isValidIso, isoToSite, siteToIso, todayDhaka, daysBetween, MONTHS };
