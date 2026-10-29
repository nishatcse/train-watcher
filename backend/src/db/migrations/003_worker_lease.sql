-- Which holder-worker currently owns the holds. The worker runs in another Railway account and talks to the
-- backend over HTTPS (no database access), so "only one worker at a time" is a lease it renews every few seconds.
create table worker_lease (
  id         int primary key default 1 check (id = 1),
  worker_id  text,
  seen_at    timestamptz
);
insert into worker_lease (id) values (1);
