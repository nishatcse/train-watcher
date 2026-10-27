-- Single-owner schema. Singleton tables (id = 1) hold global state.

create table app_settings (
  id                 int primary key default 1 check (id = 1),
  -- Gap between scan cycles. 10s is a server-enforced floor: Shohoz publishes no
  -- rate limit and enforces one silently, so the floor protects the account.
  scan_cycle_seconds int not null default 15 check (scan_cycle_seconds >= 10),
  scan_concurrency   int not null default 2  check (scan_concurrency between 1 and 4),
  scan_jitter_ms     int not null default 120 check (scan_jitter_ms between 0 and 2000),
  telegram_enabled   boolean not null default true,
  fcm_enabled        boolean not null default true,
  updated_at         timestamptz not null default now()
);
insert into app_settings (id) values (1);

create table session (
  id                      int primary key default 1 check (id = 1),
  blob_enc                text,            -- AES-256-GCM of {token, ssdk, uudid, user, refresh_token}
  has_refresh             boolean not null default false,
  token_expires_at        timestamptz,
  status                  text not null default 'expired_awaiting_relogin'
                          check (status in ('active', 'expiring_soon', 'expired_awaiting_relogin')),
  last_relogin_at         timestamptz,
  last_refresh_attempt_at timestamptz,
  warned_30_at            timestamptz,
  warned_5_at             timestamptz,
  expired_alert_at        timestamptz,
  updated_at              timestamptz not null default now()
);
insert into session (id) values (1);

create table catalog_cache (
  id                   int primary key default 1 check (id = 1),
  cities               jsonb not null default '[]',
  trains               jsonb not null default '[]',
  classes              jsonb not null default '[]',
  search_day_limit     int,
  max_ticket_per_order int,
  maintenance          boolean not null default false,
  cached_at            timestamptz
);
insert into catalog_cache (id) values (1);

create table devices (
  id                uuid primary key default gen_random_uuid(),
  name              text,
  device_token_hash text not null unique,   -- sha256 of the bearer token; the raw token is never stored
  fcm_token         text,
  platform          text not null default 'android',
  paired_at         timestamptz not null default now(),
  last_seen_at      timestamptz,
  revoked_at        timestamptz
);

create table pairing_codes (
  code        text primary key,
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create table watchers (
  id                  uuid primary key default gen_random_uuid(),
  from_city           text not null,
  to_city             text not null,
  journey_date        date not null,
  train_name          text not null,
  seat_class          text not null,
  enabled             boolean not null default true,
  last_check_status   text,
  last_checked_at     timestamptz,
  last_error          text,
  validation_warnings jsonb not null default '[]',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (from_city <> to_city)
);
-- The same journey twice is a duplicate monitoring request.
create unique index watchers_unique_journey
  on watchers (from_city, to_city, journey_date, train_name, seat_class);

-- One row per watcher: the last observation, used for edge-triggered alerts.
create table availability_state (
  watcher_id      uuid primary key references watchers(id) on delete cascade,
  available_count int not null,
  online_count    int not null,
  offline_count   int not null,
  fare            numeric,
  total_fare      numeric,
  checked_at      timestamptz not null
);

-- Kept after a watcher is deleted so history survives; the route is snapshotted in payload.
create table notifications_log (
  id              uuid primary key default gen_random_uuid(),
  watcher_id      uuid references watchers(id) on delete set null,
  kind            text not null,   -- seat_available | session_expiring | session_expired | test
  channel         text not null,   -- fcm | telegram
  title           text not null,
  body            text not null,
  payload         jsonb not null default '{}',
  delivery_status text not null default 'pending'
                  check (delivery_status in ('pending', 'sent', 'failed', 'skipped')),
  attempts        int not null default 0,
  last_error      text,
  sent_at         timestamptz,
  acknowledged_at timestamptz,
  created_at      timestamptz not null default now()
);
create index notifications_log_created on notifications_log (created_at desc);

create table idempotency_keys (
  device_id  uuid not null references devices(id) on delete cascade,
  key        text not null,
  status     int not null,
  response   jsonb not null,
  created_at timestamptz not null default now(),
  primary key (device_id, key)
);

create table engine_state (
  id                      int primary key default 1 check (id = 1),
  last_cycle_started_at   timestamptz,
  last_cycle_finished_at  timestamptz,
  last_cycle_ms           int,
  last_cycle_targets      int,
  last_cycle_failed       int,
  last_error              text,
  updated_at              timestamptz not null default now()
);
insert into engine_state (id) values (1);
