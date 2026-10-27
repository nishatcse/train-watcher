# Train Watcher backend

Read-only seat-availability monitor for Bangladesh Railway. It polls the booking site's search
endpoint for the journeys you watch and alerts you (push + Telegram) when seats appear.
**It never reserves, holds or buys anything, and never solves a CAPTCHA/OTP for you.** You book by hand.

Runs as one always-on process (API + scheduler) with Postgres. Deployed on Railway.

## How it works

- **Scheduler** (`src/scheduler.js`): gap-based loop (never overlaps). Each cycle it scans every unique
  `(from, to, date, class)` once, because one search response lists every train. Watchers that differ only
  by train share a request. Default 15s between cycles, concurrency 2, jitter 120ms; **10s is a hard floor**
  (the booking site publishes no rate limit and enforces one silently, so faster risks a block).
  A 429 pauses *all* requests (shared gate) and honours `Retry-After`.
- **Alerts** (`src/lib/availability.js`): "available" is one number, `online + counter`, because every ticket is sold
  online and the counter has no separate tickets. It is never split in the UI or the messages.
  Edge-triggered on that total: alert on first sighting with seats, or when the total changes; never for an unchanged result.
  The decision and the state write happen in one DB transaction, so push and Telegram can never disagree.
- **Delivery** (`src/services/notifier.js`): each channel is independent, retried 3x (0s / 15s / 60s),
  and tracked per alert in `notifications_log`. A dead push token is cleared, not retried forever.
- **Session** (`src/services/sessions.js`): stored AES-256-GCM encrypted. The booking site signs you out about
  every 12h and requires a human check, so a login by you ~twice a day is **normal**. You are warned at
  30 and 5 minutes before expiry, and again if it lapses (monitoring pauses, never guesses).
  Headless refresh is attempted first only if the site ever supplies a refresh token (it currently does not).

## Deploy (Railway)

```bash
cd backend
railway init -n train-watcher && railway add -d postgres && railway add -s backend
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' -s backend
# set ADMIN_TOKEN, SESSION_ENCRYPTION_KEY, TELEGRAM_* (see .env.example), then:
railway up -s backend -d && railway domain -s backend
```

Keep **one replica** (`railway.json` pins it). Two would double the request rate against the booking site.
Migrations run automatically on start. `GET /health` is the liveness probe (no DB dependency).

## Operating it

| Task | How |
|---|---|
| Pair a phone | `curl -X POST $URL/admin/pairing-code -H "x-admin-token: $ADMIN_TOKEN"` → type the code in the app (single use, 10 min) |
| Lost/replaced phone | Pair again with a new code. Old phone: `DELETE /v1/device` from it, or `update devices set revoked_at=now()` |
| Log in (normal) | In the app: Home → Log in. You use your own password and pass the site's check yourself |
| Log in (fallback) | On a computer: `npm run relogin` in the repo root, then `BACKEND_URL=$URL ADMIN_TOKEN=... npm run push-local-session`. **Check `GET /v1/session/status` first**: this replaces whatever session the server holds |
| Change scan speed | App → Settings (server rejects < 10s and explains why) |
| Logs | `railway logs -s backend` (JWTs and bot tokens are redacted before printing) |

## Push notifications (Firebase)

1. Accept Firebase's terms once and create a project at console.firebase.google.com.
2. `scripts/setup-firebase.sh <gcp-project-id>` registers the Android app (`com.afridi.train_watcher`), writes
   `mobile/android/app/google-services.json`, creates the service-account key and sets `FIREBASE_SERVICE_ACCOUNT_B64`
   on Railway (the key never touches disk beyond the script's run).
3. Rebuild and reinstall the APK. The server logs `push on` at start-up.

This deployment uses Firebase project `train-watcher-c28c2`.

The server uses FCM **HTTP v1** with the service account; no Firebase secret ever ships in the APK.

## Tests

`npm test`: 48 tests (unit + integration on PGlite, which is real Postgres semantics, + the HTTP API end to end).

## API (device token = `Authorization: Bearer`)

`GET /health` · `POST /v1/pair` · `PUT /v1/device/fcm-token` · `DELETE /v1/device` · `GET /v1/catalog` ·
`GET /v1/trains/stations?train=&date=` (live stops, so only real journeys can be chosen) ·
`GET|POST /v1/watchers` · `GET|PATCH|DELETE /v1/watchers/:id` · `POST /v1/watchers/verify` (one live check) ·
`GET /v1/notifications` · `POST /v1/notifications/:alertId/ack` · `POST /v1/session` · `GET /v1/session/status` ·
`GET|PATCH /v1/settings` · `POST /v1/settings/test-alert` · `GET /v1/status` ·
admin (`x-admin-token`): `POST /admin/pairing-code`, `POST /admin/session`.
