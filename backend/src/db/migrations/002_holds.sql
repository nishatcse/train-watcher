-- Server-side seat holding. The `holder-worker` service (a real Chrome, because the booking site signs
-- every reserve/release with Cloudflare Turnstile) picks up the single active row and keeps the seats held
-- until stop_at, or until it is stopped. The API only writes intent here; the worker owns everything else.

create table holds (
  id             uuid primary key default gen_random_uuid(),
  from_city      text not null,
  to_city        text not null,
  journey_date   date not null,
  train_name     text not null,
  seat_class     text not null default 'S_CHAIR',
  bogie_name     text not null default '',
  seat_numbers   text not null default '',      -- "KA-1,KA-2"; empty means: first free seats
  seat_count     int  not null default 2 check (seat_count between 1 and 4),
  -- Shorter cycles get the account blocked by the site for an hour ("repeated attempts"), so this is a hard floor.
  hold_seconds   int  not null default 375 check (hold_seconds >= 60),
  stop_at        timestamptz,
  status         text not null default 'queued'
                 check (status in ('queued', 'running', 'stopping', 'finished', 'stopped', 'failed')),
  phase          text,                           -- what the worker is doing right now
  cycle_count    int  not null default 0,
  held_seats     text[] not null default '{}',
  blocked_until  timestamptz,                    -- the site's "try again after ..." block, remembered across restarts
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

-- One account, one active hold.
create unique index holds_single_active on holds ((true)) where status in ('queued', 'running', 'stopping');

create table hold_events (
  id       bigserial primary key,
  hold_id  uuid not null references holds(id) on delete cascade,
  at       timestamptz not null default now(),
  message  text not null
);
create index hold_events_by_hold on hold_events (hold_id, id desc);
