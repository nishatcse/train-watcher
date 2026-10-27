// discover3.js — redirect-login (OAuth) somvob kina + action-token wall.
// SHUDHU PORAR kaj. password grant e HAT DEI NA (3-attempt lockout).
require("dotenv").config({ quiet: true });
const IAM = "https://train-iam.shohoz.com";
const line = (t) => console.log("\n" + "=".repeat(72) + "\n  " + t + "\n" + "=".repeat(72));

async function discovery() {
  line("1. OIDC discovery — third-party redirect-login er jonno ja lage");
  const j = await (await fetch(`${IAM}/.well-known/openid-configuration`)).json();
  console.log("  authorization_endpoint     :", j.authorization_endpoint);
  console.log("  token_endpoint             :", j.token_endpoint);
  console.log("  registration_endpoint      :", j.registration_endpoint || "❌ NEI (third-party client register kora jabe na)");
  console.log("  response_types_supported   :", (j.response_types_supported || []).join(", "));
  console.log("  code_challenge_methods     :", (j.code_challenge_methods_supported || []).join(", ") || "(nei)");
  console.log("  grant_types_supported      :", (j.grant_types_supported || []).join(", "));
}

async function authorize() {
  line("2. /connect/authorize — amader nijer redirect_uri diye code paoya jay?");
  const p = new URLSearchParams({
    client_id: "train-ticket-user",
    response_type: "code",
    scope: "shohoz.iam.train offline_access",
    redirect_uri: "https://my-own-app.example.com/callback",
    state: "test123",
  });
  const r = await fetch(`${IAM}/connect/authorize?${p}`, { redirect: "manual" });
  console.log("  HTTP", r.status);
  console.log("  location:", r.headers.get("location") || "(nei)");
  const body = await r.text();
  console.log("  body:", body.replace(/\s+/g, " ").slice(0, 300));
  console.log("\n  'invalid redirect_uri' / 'unauthorized_client' => amader redirect_uri allow-list e nei;");
  console.log("  mane official OAuth redirect-login third-party hishebe kora jabe na.");
}

(async () => {
  for (const fn of [discovery, authorize]) {
    try { await fn(); } catch (e) { console.log("  byartho:", e.message); }
  }
  console.log("\n" + "=".repeat(72) + "\n");
})();
