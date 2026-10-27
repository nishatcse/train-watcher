# Watcher App — Build Checklist
Plan: ~/.claude/plans/pasted-content-id-ebd2-project-keen-kahan.md
Boundary: read-only availability alerts only. No hold / auto-book / CAPTCHA / OTP bypass.

Legend: [x] done and verified · [~] built, NOT yet verified on a real device · [ ] not done (reason given)

## M0 — Hold removal
- [x] Deleted browser-hold / seat-holder / holder-login / push-session; stripped checker / index / config / relogin
- [x] package.json, .env.example, README cleaned; check-once verified live

## M1 — Backend  (backend/, 51 tests passing)
- [x] Self-contained Node project, Railway-deployable, migrations on start
- [x] Postgres schema (settings, session, catalog, devices, pairing, watchers, state, notifications, idempotency, engine)
- [x] Ported api-client / scanner / availability rules / catalog / telegram. Rule changed on the owner's instruction: available = online + counter, one number, never split; alerts are edge-triggered on that total
- [x] Fetch timeouts; shared 429 pause gate across scheduler + interactive calls
- [x] Scheduler: cycle model, one request per route/date/class, past journeys auto-off, not-open-yet skipped
- [x] REST API + device-token auth + /health; live station list + live "verify journey"
- [x] Tests: unit, PGlite integration, HTTP end-to-end, restart (no duplicate alert), DB-down fallback

## M2 — Session + pairing
- [x] State machine active / expiring_soon / expired_awaiting_relogin; 30-min and 5-min warnings; throttled expired alert
- [x] Session encrypted at rest (AES-256-GCM); never logged (JWT/bot-token redaction)
- [x] One-time pairing codes; device tokens stored hashed; revoke
- [x] /v1/session, /v1/session/status, /admin/session (CLI fallback)
- [x] Verified live: the live session has NO refresh token -> ~12h manual login is the normal case (headless refresh is only a bonus)

## M3 — Flutter app  (mobile/, Android, analyze clean, 10 tests)
- [x] Splash, pairing, dashboard, watcher list, create/edit, searchable picker, monitoring, history, session, Telegram, settings, error/recovery (14/14)
- [x] Watcher form uses the site's catalog + live stops of the chosen train; "Check this journey now"
- [x] Installed on the phone (2201116SG, Android 13), paired, dashboard shows live server state
- [x] Notification permission flow; 3 channels created (seat alerts = importance MAX)

## M4 — Login + push + alert UX
- [x] **Phone WebView login WORKS**: real Railway page + Cloudflare check loaded in the app; the session you logged in with was captured and accepted by the cloud (cloud log: `session saved (login)`)
- [x] Push (FCM) works end to end on the phone: server -> Firebase -> phone, delivery tracked in History ("Phone sent"), Dismiss acknowledged ("seen")
- [x] Ringtone notification: insistent, alarm stream, max importance (confirmed from Android's own notification record); heads-up with Book now / Dismiss shown
- [~] You still need to confirm by ear that the sound is loud/distinct (I can only read the flags, not hear it)
- [x] Lock-screen alert: with the phone locked and screen off the alert woke the screen and showed over the lock screen with "Unlock & book now" / "Dismiss"; it keeps ringing until acted on; Dismiss returns to the lock screen
- [x] Book now (from the notification) opens the official booking site inside the app
- [~] "Unlock & book now" itself (PIN prompt) not exercised: needs your PIN
- [x] Firebase: project train-watcher-c28c2, google-services.json in the build, service-account key on Railway (server logs `push on`)
- [!] Xiaomi/Redmi quirk: lock-screen takeover needs MIUI's "Show on lock screen" + "pop-up windows in background" ON for the app. MIUI RESETS them every time the app is reinstalled over adb; set them again (App settings in the app opens the page)

## M5 — Reliability
- [x] Retry/backoff 0s/15s/60s per channel, delivery tracked per alert, dead push token cleared
- [x] DB down: loop survives, Telegram alert straight from env creds (throttled)
- [x] Idempotency keys (watcher create); duplicate journeys rejected
- [x] Duplicate-push protection in the app (alertId seen-list), server-side single-decision transaction
- [~] Catalog staleness shown as "updated Xh ago" (no warning badge)

## M6 — Ship + verify
- [x] Railway project + Postgres + env vars; deployed; /health + DB ready
      https://backend-production-ff8f.up.railway.app
- [x] Cloud scans the real watcher against the live API (Mymensingh -> Dhaka, 31-Oct, S_CHAIR): ~0.7s/cycle, 0 failures
- [x] Real test alert -> Telegram: sent on first attempt
- [x] Real test alert -> phone push: delivered, shown, acknowledged
- [ ] A real seat appearing end to end (needs seats to actually open)
- [ ] 3-watcher acceptance scenario on the live site (covered by automated tests; not created live to avoid extra load)
- [~] Locked-screen delivery verified; killed-app and Doze (hours idle, unplugged) delivery not yet observed

## Follow-ups
- Railway deprecates railway.json on 2026-12-01 (`railway config migrate`); works until then.
- Stop the old local watcher (`pkill -f "node src/index.js"`) once you trust the cloud, or Telegram alerts arrive twice.
- Phone is Xiaomi/Redmi (MIUI): also enable Autostart and set battery to "No restrictions" for the app.
- Old GCP project `train-watcher-74f1bc` (created before the Firebase terms were accepted) is unused; delete it when convenient.
- Your session was replaced by an older one at 05:51Z (my mistake); it expires 15:42Z (21:42 BST). Log in again from the phone to get a fresh 12 hours.
