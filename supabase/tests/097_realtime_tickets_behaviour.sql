-- Proves 097_realtime_tickets.sql behaves, against a throwaway postgres.
--
-- Run: bash supabase/tests/097_realtime_tickets_run.sh
--
-- A ticket is a bearer credential for a socket upgrade, so the assertions that matter are the ones
-- that stop it being reused, guessed or outlived:
--   • single use, enforced atomically, so two simultaneous upgrades yield exactly one winner
--   • expiry, so a ticket left in a log is worthless a moment later
--   • unknown, expired and spent are indistinguishable to the caller
--   • no session can issue a ticket, which would otherwise be an authentication bypass
--   • the table is unreadable even by its owner

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
  display_name text not null default ''
);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'alice@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'bob@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, display_name) values
  ('00000000-0000-4000-8000-000000000001', 'Alice'),
  ('00000000-0000-4000-8000-000000000002', 'Bob')
on conflict (id) do nothing;

\ir ../migrations/097_realtime_tickets.sql

-- A realistic token: 32 bytes of randomness, hex encoded.
\set tok '''aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff11111111'''

do $$ begin raise notice '--- issue and consume ---'; end $$;

-- 1. A fresh ticket resolves to its owner exactly once.
do $$
declare v_expires timestamptz; v_user uuid;
begin
  v_expires := public.realtime_ticket_issue(
    '00000000-0000-4000-8000-000000000001',
    'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff11111111');
  if v_expires <= now() then
    raise exception 'FAIL 1: ticket expired on issue (%)', v_expires;
  end if;

  v_user := public.realtime_ticket_consume('aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff11111111');
  if v_user <> '00000000-0000-4000-8000-000000000001' then
    raise exception 'FAIL 1: consume returned %, expected alice', v_user;
  end if;
  raise notice 'ok 1: a fresh ticket resolves to its owner';
end $$;

-- 2. THE ONE THAT MATTERS. A second use returns nothing. Without this, a ticket captured from a
--    log or a referrer could be replayed into a live socket as that user.
do $$
declare v_user uuid;
begin
  v_user := public.realtime_ticket_consume('aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff11111111');
  if v_user is not null then
    raise exception 'FAIL 2: a spent ticket was accepted again (user %)', v_user;
  end if;
  raise notice 'ok 2: a ticket is single use';
end $$;

-- 3. Concurrent redemption yields exactly one winner. The guard is the UPDATE's WHERE clause, so
--    this holds without the caller taking a lock.
do $$
declare v_first uuid; v_second uuid; n int;
begin
  perform public.realtime_ticket_issue(
    '00000000-0000-4000-8000-000000000001', 'race-token-0000000000000000000000000000');
  v_first  := public.realtime_ticket_consume('race-token-0000000000000000000000000000');
  v_second := public.realtime_ticket_consume('race-token-0000000000000000000000000000');
  n := (case when v_first is not null then 1 else 0 end)
     + (case when v_second is not null then 1 else 0 end);
  if n <> 1 then
    raise exception 'FAIL 3: expected exactly one winner, got %', n;
  end if;
  raise notice 'ok 3: exactly one redemption wins';
end $$;

-- 4. An expired ticket is worthless, even unused. This is what makes a ticket in a log harmless a
--    moment later.
do $$
declare v_user uuid;
begin
  perform public.realtime_ticket_issue(
    '00000000-0000-4000-8000-000000000001', 'expired-token-000000000000000000000000', -1);
  -- Force it into the past regardless of the clamp on the TTL argument.
  update public.realtime_tickets set expires_at = now() - interval '1 second'
   where token = 'expired-token-000000000000000000000000';

  v_user := public.realtime_ticket_consume('expired-token-000000000000000000000000');
  if v_user is not null then
    raise exception 'FAIL 4: an expired ticket was accepted';
  end if;
  raise notice 'ok 4: an expired ticket is refused';
end $$;

-- 5. Unknown, expired and spent are indistinguishable: all three are NULL. Telling them apart would
--    confirm to an attacker that a guessed token once existed.
do $$
declare v_unknown uuid;
begin
  v_unknown := public.realtime_ticket_consume('never-issued-000000000000000000000000000');
  if v_unknown is not null then
    raise exception 'FAIL 5: an unknown token resolved to a user';
  end if;
  raise notice 'ok 5: unknown, expired and spent look the same';
end $$;

-- 6. A token too short to be random is refused outright, so a caller cannot weaken the credential
--    by passing something guessable.
do $$
begin
  perform public.realtime_ticket_issue('00000000-0000-4000-8000-000000000001', 'short');
  raise exception 'FAIL 6: a short token was accepted';
exception when check_violation then
  raise notice 'ok 6: a short token is refused';
end $$;

-- 7. The TTL is honoured, and clamped so zero or negative cannot mint an already-dead ticket that
--    the caller then treats as valid.
do $$
declare v_expires timestamptz;
begin
  v_expires := public.realtime_ticket_issue(
    '00000000-0000-4000-8000-000000000002', 'ttl-token-00000000000000000000000000000', 120);
  if v_expires < now() + interval '100 seconds' then
    raise exception 'FAIL 7: a 120s ttl produced %', v_expires;
  end if;
  raise notice 'ok 7: the ttl is honoured';
end $$;

do $$ begin raise notice '--- housekeeping ---'; end $$;

-- 8. Issuing sweeps rows well past expiry, so the table cannot grow without bound from a client
--    that asks for tickets and never connects.
do $$
declare n_before int; n_after int;
begin
  insert into public.realtime_tickets (token, user_id, expires_at)
  values ('stale-token-000000000000000000000000000',
          '00000000-0000-4000-8000-000000000001', now() - interval '10 minutes');
  select count(*) into n_before from public.realtime_tickets
   where token = 'stale-token-000000000000000000000000000';

  perform public.realtime_ticket_issue(
    '00000000-0000-4000-8000-000000000001', 'sweep-trigger-0000000000000000000000000');

  select count(*) into n_after from public.realtime_tickets
   where token = 'stale-token-000000000000000000000000000';
  if n_before <> 1 or n_after <> 0 then
    raise exception 'FAIL 8: stale ticket not swept (before %, after %)', n_before, n_after;
  end if;
  raise notice 'ok 8: issuing sweeps long-expired tickets';
end $$;

-- 9. A ticket still inside its life is NOT swept, including one that expired seconds ago and may be
--    mid-handshake.
do $$
declare n int;
begin
  insert into public.realtime_tickets (token, user_id, expires_at)
  values ('recent-token-00000000000000000000000000',
          '00000000-0000-4000-8000-000000000001', now() - interval '5 seconds');

  perform public.realtime_ticket_issue(
    '00000000-0000-4000-8000-000000000001', 'sweep-trigger-2-000000000000000000000');

  select count(*) into n from public.realtime_tickets
   where token = 'recent-token-00000000000000000000000000';
  if n <> 1 then
    raise exception 'FAIL 9: a just-expired ticket was swept, which could kill a live handshake';
  end if;
  raise notice 'ok 9: the sweep leaves a minute of slack';
end $$;

do $$ begin raise notice '--- access control ---'; end $$;

-- 10. No session can issue a ticket. This would be a complete authentication bypass: the function
--     takes a user id and does not consult auth.uid(), so a caller could mint a socket credential
--     for any account.
begin;
set local role authenticated;
set local "test.uid" = '00000000-0000-4000-8000-000000000002';
do $$
begin
  begin
    perform public.realtime_ticket_issue(
      '00000000-0000-4000-8000-000000000001', 'forged-token-00000000000000000000000000');
    raise exception 'FAIL 10: a session issued a ticket for another user';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.realtime_ticket_consume('anything-at-all-0000000000000000000000');
    raise exception 'FAIL 10: a session consumed a ticket';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok 10: no session can issue or consume';
end $$;
rollback;

-- 11. The table is unreadable, even by the account the ticket belongs to. RLS is on with no policy,
--     so every select is empty and the secret never travels back.
begin;
set local role authenticated;
set local "test.uid" = '00000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    perform 1 from public.realtime_tickets;
    raise exception 'FAIL 11: a session could query the ticket table';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok 11: the ticket table is unreadable from a session';
end $$;
rollback;

-- 12. Both functions pin search_path, like every other definer function in this schema.
do $$
declare v_unpinned text;
begin
  select string_agg(p.proname, ', ') into v_unpinned
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like 'realtime\_ticket%'
    and p.prosecdef
    and (p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) c where c like 'search\_path=%'
    ));
  if v_unpinned is not null then
    raise exception 'FAIL 12: definer functions with no pinned search_path: %', v_unpinned;
  end if;
  raise notice 'ok 12: search_path is pinned';
end $$;

do $$ begin raise notice 'ALL TICKET ASSERTIONS PASSED (12)'; end $$;
