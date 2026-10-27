# Train Watcher (standalone)

> **Cloud + phone version:** `backend/` (Node + Postgres, deployed on Railway) watches 24/7 and `mobile/`
> (Flutter, Android) lets you add watchers and rings your phone. See `backend/README.md`. Read-only:
> it never holds or buys a seat. The rest of this file documents the original single-machine watcher in `src/`.

BD Railway ticket **availability watcher**. `routes.json` er proti route API diye check kore,
seat pele Telegram e alert pathay. Eta **read-only** — seat hold/book kore na; ticket kena
official site e hate kore.

Eta `train ticket 2` project er watcher ongsho-tar **shopurno alada copy** — nijer `src/`,
nijer `node_modules/`, nijer `.env`, nijer `state/`. Oi project ta na thakleo eta cholbe.
Seat-hold / auto-book ekhane **nei** — ei tool shudhu availability dekhe alert dey.

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
Bhul nam ba mora tarikh dile watcher **shuru-tei** bole debe (handshake_data er
260 city / 148 train er talika theke milie dekhe).

### Puro train ek shathe dekha

`"scanAllPairs": true` dile watcher `/train-routes` API theke oi train er **shob
station** ene niye protita forward station-jora check kore — 9 stoppage mane 36 jora:

```json
[
  { "from": "Dhaka", "to": "Chattogram", "date": "07-Aug-2026",
    "train": "TURNA (742)", "class": "S_CHAIR", "scanAllPairs": true }
]
```

Kaje lage jokhon Dhaka->Chattogram faka nei kintu Dhaka->Cumilla ache.

## Chalano

| Command | Kaj |
|---|---|
| `npm run watch` | ononto watcher — proti `POLL_INTERVAL_SECONDS` e ek ta route check |
| `npm run logs` | running watcher-er live log dekha; Ctrl+C dile sudhu log view bondho hoy |
| `npm run check-once` | ek cycle cheek kore ber hoye jay (setup test korar jonno) |
| `npm run relogin` | watcher account abar login — Chrome khole, refresh token-o dhore rakhe |
| `npm run refresh` | refresh token diye token nobayon (Chrome chhara, ek second) |
| `npm run discover` | Sohoz API te ki ki ache ta ber kore (shudhu pora) |
| `npm run test-telegram` | Telegram bot/chat thik ache kina dekhe |
| `npm run location -- "TURNA (741)"` | BR Explorer API diye live train location dekhay |

Always-on:

```bash
sudo cp deploy/train-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now train-watcher
journalctl -u train-watcher -f
```

## Kivabe kaj kore

- Proti tick e **shob** route ek shathe (parallel) `search-trips-v2` API diye check kore —
  **browser lage na**, tai halka. `scanAllPairs` thakle station-jora gulo-o kholе ney.
- Ek hit e oi jora + tarikh er **shob train, shob class** ase — tai class-prati alada hit lage na.
- Seat 0 theke beshi hole ar sonkha bodlale Telegram notification jay
  (`state/availability-state.json` e ager obostha rakha thake).
- **Online bonam counter:** `seat_counts` e `is_divided: true` — Railway protita class ke
  online quota ar counter quota te bhag kore. Online-ta-i shudhu ei site theke kena jay,
  tai alert `online` dhore hoy (counter ta pashe tothyo hishebe dekhay).
- Token expire hobar 30 min age **age refresh token diye** nobayon korar cheshta kore
  (`POST train-iam.shohoz.com/connect/token`) — Chrome lage na. Refresh token na thakle ba
  fail korle tokhon browser re-login e fallback kore. Duitai fail hole Telegram e alert
  (6 ghontay ek bar er beshi na).

## Config

Sob option `.env.example` e comment soho ache. Beshi byabohrito:

| Var | Ki |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | alert kothay jabe |
| `POLL_INTERVAL_SECONDS` | duita cycle er majher biroti (default 15) |
| `SCAN_CONCURRENCY` | ek shathe koyta request (default 2 — **kom theke shuru koro**) |
| `SCAN_JITTER_MS` | proti request er age eloprithibi biroti (default 120) |
| `RAILWAY_USERNAME` / `RAILWAY_PASSWORD` | watcher account (A) |
| `BROWSER_EXECUTABLE_PATH` | Pi te `/usr/bin/chromium` |

## Ei folder e ja ache

```
src/index.js         watcher loop, session nobayon, parallel scan, Telegram alert
src/checker.js       ek route check + notification
src/api-client.js    search-trips-v2 + train-routes API call
src/scanner.js       route -> station-jora kholа, bounded parallel pool, 429 backoff
src/catalog.js       handshake_data theke city/train/class/tarikh jachai
src/token-refresh.js Chrome chhara token nobayon (/connect/token)
src/session.js       .env er session blob read/write, JWT expiry
src/relogin.js       watcher account (A) re-login CLI
src/browser.js       plain Chrome spawn + CDP attach (Turnstile er jonno)
src/login.js         shared login routine (Turnstile wait)
src/telegram.js      Bot API
src/helpers.js       sleep / log
src/config.js        .env + routes.json load
discover.js          Sohoz API reverse-engineering (shudhu pora)
```

## Rate limit — sabdhan

Prottekta request-e **ek-i** `x-device-id` / `x-device-key` jay, tai server er chokhe eta
ekta-i device. Asol limit ta amra mapte pari ni. Tai:

- `SCAN_CONCURRENCY=2` diye shuru koro, `journalctl -u train-watcher -f` e `429` dekho
- koyek ghonta 0 ta 429 dekhle dhape dhape 4 -> 6 e barao
- ঝুঁki-r kром: 429 (samoyik) -> device key ban (re-login lagbe) -> account block (shobcheye kharap)

429 pele scanner **puro batch** thamiye `Retry-After` mene opekkha kore.

## Live train location

BR Explorer/SUNCROPS app-er live tracking API diye train-er current location dekha jay:

```bash
npm run location -- "TURNA (741)"
npm run location -- "741"
npm run location -- "turna"   # saved handshake catalog thakle match korbe
```

`.env` e BR Explorer account info lagbe:

```bash
BREX_PHONE=01xxxxxxxxx
BREX_UID=your_brex_user_id
BREX_UPASS=your_brex_password_or_api_password
```

Output-e readable status, lat/lon, Google Maps link, speed/delay/last update thakbe.
