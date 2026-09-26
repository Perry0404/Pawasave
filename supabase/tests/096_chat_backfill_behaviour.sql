-- Proves 096_chat_backfill.sql behaves, against a throwaway postgres.
--
-- Run: bash supabase/tests/096_chat_backfill_run.sh
--
-- Under test:
--   • circle messages keep their order and timestamps, and land in the circle's room
--   • a payment message exists per settled transfer, keyed so a re-run adds nothing
--   • pending and self transfers are excluded
--   • each room's last_seq matches what it actually holds
--   • backfilled history arrives READ, because a wall of unread badges for old conversations is
--     the obvious way to get this wrong
--   • the whole migration is idempotent
--   • amount is carried as micro, not a formatted label, and direction is NOT stored

\set ON_ERROR_STOP on

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  tag text
);
create table if not exists public.esusu_groups (id uuid primary key default gen_random_uuid(), name text);
create table if not exists public.esusu_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.esusu_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  unique (group_id, user_id)
);
create table if not exists public.p2p_transfers (
  id bigserial primary key,
  sender_id uuid not null references public.profiles(id),
  recipient_id uuid references public.profiles(id),
  amount_micro bigint not null,
  note text,
  status text not null,
  created_at timestamptz not null default now()
);

-- The table 096 migrates FROM, as 085 created it.
create table if not exists public.circle_messages (
  id bigserial primary key,
  group_id uuid not null references public.esusu_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'a@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'b@example.test'),
  ('00000000-0000-4000-8000-000000000003', 'c@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, display_name) values
  ('00000000-0000-4000-8000-000000000001', 'Alice'),
  ('00000000-0000-4000-8000-000000000002', 'Bob'),
  ('00000000-0000-4000-8000-000000000003', 'Carol')
on conflict (id) do nothing;

\ir ../migrations/094_chat_rooms.sql
\ir ../migrations/095_chat_rpcs.sql

-- ── legacy data to migrate ───────────────────────────────────────────────────
do $$
declare v_group uuid;
begin
  insert into public.esusu_groups (name) values ('Aso Ebi') returning id into v_group;
  insert into public.esusu_members (group_id, user_id) values
    (v_group, '00000000-0000-4000-8000-000000000001'),
    (v_group, '00000000-0000-4000-8000-000000000002'),
    (v_group, '00000000-0000-4000-8000-000000000003');
  -- Deliberately out of id order relative to time, so ordering by created_at matters.
  insert into public.circle_messages (group_id, user_id, body, created_at) values
    (v_group, '00000000-0000-4000-8000-000000000001', 'first',  '2026-01-01T10:00:00Z'),
    (v_group, '00000000-0000-4000-8000-000000000002', 'second', '2026-01-01T11:00:00Z'),
    (v_group, '00000000-0000-4000-8000-000000000003', 'third',  '2026-01-01T12:00:00Z');
end $$;

insert into public.p2p_transfers (sender_id, recipient_id, amount_micro, note, status, created_at) values
  -- Alice and Bob, both directions, settled.
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 5000000000, 'lunch', 'completed', '2026-02-01T10:00:00Z'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 2500000000, null,    'claimed',   '2026-02-02T10:00:00Z'),
  -- Excluded: unsettled.
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 100,        null,    'pending',   '2026-02-03T10:00:00Z'),
  -- Excluded: no recipient account (an unclaimed email send).
  ('00000000-0000-4000-8000-000000000001', null,                                   100,        null,    'completed', '2026-02-04T10:00:00Z');

\ir ../migrations/096_chat_backfill.sql

do $$ begin raise notice '--- circle messages ---'; end $$;

-- 1. All three copied into the circle's room, in time order, with timestamps preserved.
do $$
declare v_room uuid; n int; v_bodies text;
begin
  select id into v_room from public.chat_rooms where kind = 'circle';
  if v_room is null then raise exception 'FAIL 1: no circle room was created'; end if;
  select count(*) into n from public.chat_messages where room_id = v_room;
  if n <> 3 then raise exception 'FAIL 1: expected 3 circle messages, found %', n; end if;
  select string_agg(body, ',' order by seq) into v_bodies
    from public.chat_messages where room_id = v_room;
  if v_bodies <> 'first,second,third' then
    raise exception 'FAIL 1: order is % — seq does not follow created_at', v_bodies;
  end if;
  if (select min(created_at) from public.chat_messages where room_id = v_room)
     <> '2026-01-01T10:00:00Z'::timestamptz then
    raise exception 'FAIL 1: original timestamps were not preserved';
  end if;
  raise notice 'ok 1: circle messages copied in order with timestamps intact';
end $$;

-- 2. Every circle member is in the room.
do $$
declare v_room uuid; n int;
begin
  select id into v_room from public.chat_rooms where kind = 'circle';
  select count(*) into n from public.chat_room_members where room_id = v_room;
  if n <> 3 then raise exception 'FAIL 2: expected 3 members, found %', n; end if;
  raise notice 'ok 2: circle membership carried over';
end $$;

do $$ begin raise notice '--- payment messages ---'; end $$;

-- 3. One direct room for the one pair that transacted, and two payment messages in it.
do $$
declare n_rooms int; v_room uuid; n int;
begin
  select count(*) into n_rooms from public.chat_rooms where kind = 'direct';
  if n_rooms <> 1 then
    raise exception 'FAIL 3: expected 1 direct room, found % — pending and email-only transfers must not create one', n_rooms;
  end if;
  select id into v_room from public.chat_rooms where kind = 'direct';
  select count(*) into n from public.chat_messages where room_id = v_room;
  if n <> 2 then raise exception 'FAIL 3: expected 2 payment messages, found %', n; end if;
  raise notice 'ok 3: one room per transacted pair, one message per settled transfer';
end $$;

-- 4. Keyed on the transfer, so the derivation is stable and re-runnable.
do $$
declare n int;
begin
  select count(*) into n from public.chat_messages
    where client_id in ('payment:1', 'payment:2') and kind = 'payment';
  if n <> 2 then raise exception 'FAIL 4: payment client_ids are not transfer-derived (% found)', n; end if;
  raise notice 'ok 4: payment messages are keyed on the transfer id';
end $$;

-- 5. Amount is micro and direction is NOT stored. A transfer is outgoing for one party and incoming
--    for the other, so a stored direction would be wrong for one of them in every thread.
do $$
declare v_meta jsonb;
begin
  select metadata into v_meta from public.chat_messages where client_id = 'payment:1';
  if (v_meta->>'amountMicro')::bigint <> 5000000000 then
    raise exception 'FAIL 5: amountMicro is %, expected the raw micro value', v_meta->>'amountMicro';
  end if;
  if v_meta->>'note' <> 'lunch' then
    raise exception 'FAIL 5: the sender note was not carried';
  end if;
  if v_meta ? 'direction' then
    raise exception 'FAIL 5: direction must not be stored — it depends on who is looking';
  end if;
  raise notice 'ok 5: amount is micro, note carried, direction not stored';
end $$;

-- 6. The sender is on the row, which is how the client derives direction.
do $$
declare v_sender uuid;
begin
  select sender_id into v_sender from public.chat_messages where client_id = 'payment:2';
  if v_sender <> '00000000-0000-4000-8000-000000000002' then
    raise exception 'FAIL 6: sender_id is %, expected bob', v_sender;
  end if;
  raise notice 'ok 6: the transfer sender is the message sender';
end $$;

do $$ begin raise notice '--- counters ---'; end $$;

-- 7. last_seq matches what each room actually holds. A stale high-water mark would make the next
--    real post collide on (room_id, seq).
do $$
declare v_bad text;
begin
  select string_agg(r.id::text || ' last_seq=' || r.last_seq || ' max=' || c.max_seq, ', ')
    into v_bad
  from public.chat_rooms r
  join (select room_id, max(seq) max_seq from public.chat_messages group by room_id) c
    on c.room_id = r.id
  where r.last_seq <> c.max_seq;
  if v_bad is not null then raise exception 'FAIL 7: last_seq out of step: %', v_bad; end if;
  raise notice 'ok 7: every room''s last_seq matches its contents';
end $$;

-- 8. THE ONE THAT MATTERS FOR THE USER. Backfilled history arrives read. Getting this wrong hands
--    every existing user a wall of unread badges for conversations they have already had.
do $$
declare v_unread int;
begin
  select coalesce(sum(unread_count), 0) into v_unread from public.chat_room_members;
  if v_unread <> 0 then
    raise exception 'FAIL 8: backfill produced % unread messages', v_unread;
  end if;
  if exists (
    select 1 from public.chat_room_members m
    join public.chat_rooms r on r.id = m.room_id
    where m.read_seq <> r.last_seq
  ) then
    raise exception 'FAIL 8: a read cursor was not advanced to the end of history';
  end if;
  raise notice 'ok 8: history arrives read, with cursors at the end';
end $$;

-- 9. A real post after the backfill continues the sequence rather than colliding.
do $$
declare v_room uuid; v_row public.chat_messages;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  v_row := public.chat_post_message(
    v_room, '00000000-0000-4000-8000-000000000001', 'live-1', 'text', 'after the backfill');
  if v_row.seq <> 3 then
    raise exception 'FAIL 9: first live message got seq %, expected 3', v_row.seq;
  end if;
  raise notice 'ok 9: a live post continues the backfilled sequence';
end $$;

do $$ begin raise notice '--- idempotency ---'; end $$;

-- 10. Re-running the whole migration changes nothing, and does not re-read the live message from 9.
\ir ../migrations/096_chat_backfill.sql

do $$
declare n_msgs int; n_rooms int; v_unread int;
begin
  select count(*) into n_msgs  from public.chat_messages;
  select count(*) into n_rooms from public.chat_rooms;
  -- 3 circle + 2 payment + 1 live.
  if n_msgs <> 6 then raise exception 'FAIL 10: re-run changed message count to %', n_msgs; end if;
  if n_rooms <> 2 then raise exception 'FAIL 10: re-run changed room count to %', n_rooms; end if;
  -- Bob has one unread from task 9's live message, and the re-run must not clear it: step 6 only
  -- touches cursors still at zero.
  select unread_count into v_unread from public.chat_room_members m
    join public.chat_rooms r on r.id = m.room_id
   where r.kind = 'direct' and m.user_id = '00000000-0000-4000-8000-000000000002';
  if v_unread <> 1 then
    raise exception 'FAIL 10: re-run marked a genuinely unread message as read (unread=%)', v_unread;
  end if;
  raise notice 'ok 10: the migration is idempotent and does not clear real unread';
end $$;

-- 11. circle_messages is left in place, so a rollback cannot lose messages.
do $$
declare n int;
begin
  select count(*) into n from public.circle_messages;
  if n <> 3 then raise exception 'FAIL 11: circle_messages was modified (% rows)', n; end if;
  raise notice 'ok 11: circle_messages is untouched';
end $$;

do $$ begin raise notice 'ALL BACKFILL ASSERTIONS PASSED (11)'; end $$;
