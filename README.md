# Train Watcher (standalone)

BD Railway ticket **availability watcher**. `routes.json` er proti route API diye check kore,
seat pele Telegram e alert pathay. Ichche korle seat pele browser diye **auto-hold**-o korte
pare.

Eta `train ticket 2` project er watcher ongsho-tar **shopurno alada copy** — nijer `src/`,
nijer `node_modules/`, nijer `.env`, nijer `state/`. Oi project ta na thakleo eta cholbe.
Multi-account seat-hold **rotation** ta ekhane **nei** (seta oi project e-i ache).

## ⚠️ Duita ekshathe chalale account alada koro

`.env` er `RAILWAY_USERNAME` ekhon **oi project er sathe ek-i**. Ek-i railway account diye
duita watcher chalale duijon-i bar bar re-login korbe ar **eke oporer session token nosto
korbe** — duitai fail korte thakbe.

Duita ekshathe chalate chaile ekhane **alada railway account** dao:

```
RAILWAY_USERNAME=<onno ekta number>
RAILWAY_PASSWORD=<tar password>
```

## Setup

```bash
cd /home/afridi/Documents/train-watcher
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install     # ekbar (already kora)
```

`.env` e `RAILWAY_SESSION_COOKIES=` khali rakha ache — prothom bar chalale eta nijei browser
khule login kore niye `.env` e likhe debe. Ba hate kore ekbar:

```bash
npm run relogin
```

`routes.json` e ja ja dekhte chao:

```json
[
  { "from": "Dhaka", "to": "Chattogram", "date": "31-Jul-2026",
    "train": "TURNA (741)", "class": "SNIGDHA" }
]
```

City/train nam site er motoi likhbe (`Chattogram`, `TURNA (741)`), URL-encoded na.

## Chalano

| Command | Kaj |
|---|---|
| `npm run watch` | ononto watcher — proti `POLL_INTERVAL_SECONDS` e ek ta route check |
| `npm run check-once` | ek cycle cheek kore ber hoye jay (setup test korar jonno) |
| `npm run relogin` | watcher account abar login (token ~12 ghonta pore expire hoy) |
| `npm run test-telegram` | Telegram bot/chat thik ache kina dekhe |
| `npm run holder-login` | auto-hold er holder account login (sudhu auto-hold cholle) |
| `npm run hold-test` | ek bar hold kore dekhe (`HOLD_*` target e) |

Always-on:

```bash
sudo cp deploy/train-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now train-watcher
journalctl -u train-watcher -f
```

## Kivabe kaj kore

- Proti tick e ek ta route (round-robin) `search-trips-v2` API diye check kore — **browser lage
  na**, tai halka.
- Seat 0 theke beshi hole ar sonkha bodlale Telegram notification jay
  (`state/availability-state.json` e ager obostha rakha thake).
- Token expire hobar 30 min age nijei browser khule re-login kore `.env` update kore ney.
  Re-login fail hole Telegram e alert (6 ghontay ek bar er beshi na).
- `AUTO_HOLD_ENABLED=true` hole `HOLD_*` target e seat pele **holder account (B)** browser diye
  seat hold kore. Watcher account (A) er session ete kokhono venge na — duita account, duita
  Chrome profile.

## Config

Sob option `.env.example` e comment soho ache. Beshi byabohrito:

| Var | Ki |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | alert kothay jabe |
| `POLL_INTERVAL_SECONDS` | duita check er majher biroti (default 15) |
| `RAILWAY_USERNAME` / `RAILWAY_PASSWORD` | watcher account (A) |
| `AUTO_HOLD_ENABLED` | seat pele hold korbe kina |
| `HOLDER_USERNAME` / `HOLDER_PASSWORD` | holder account (B), auto-hold cholle lage |
| `BROWSER_EXECUTABLE_PATH` | Pi te `/usr/bin/chromium` |

## Ei folder e ja ache

```
src/index.js         watcher loop, token refresh, Telegram alert
src/checker.js       ek route check + notification + auto-hold trigger
src/api-client.js    search-trips-v2 API call
src/session.js       .env er session blob read/write, JWT expiry
src/relogin.js       watcher account (A) re-login CLI
src/holder-login.js  holder account (B) login CLI
src/browser.js       plain Chrome spawn + CDP attach (Turnstile er jonno)
src/login.js         shared login routine (Turnstile wait)
src/seat-holder.js   auto-hold entry + hold-test CLI
src/browser-hold.js  seat layout DOM driving (reserve/release)
src/telegram.js      Bot API
src/helpers.js       sleep / log
src/config.js        .env + routes.json load
```
