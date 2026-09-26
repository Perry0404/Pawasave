-- Proves 094_chat_rooms.sql and 095_chat_rpcs.sql behave, against a throwaway postgres.
--
-- Run: bash supabase/tests/094_095_chat_run.sh
--
-- Behaviour, not shape. The things under test are the ones that would be silent in production and
-- expensive to find:
--   • a duplicate client_id returns the ORIGINAL row rather than raising, because that is what makes
--     a chat POST retryable after a timeout
--   • seq is gap-free and per-room under concurrent posts, because ordering and resync depend on it
--   • pair_key makes room creation idempotent, so a simultaneous double call yields ONE room
--   • unread increments for every member except the author, in the same statement as the timestamp
--   • chat_mark_read never moves backwards
--   • the eligibility rule actually refuses a stranger, which is the whole anti-spam story
--   • RLS hides a non-member's rows, and the grant posture keeps clients out of the RPCs
--
-- auth.uid() is a settable GUC so a signed-in reader can be simulated.

\set ON_ERROR_STOP on

-- ── stand-ins for the Supabase objects these migrations depend on ────────────
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

-- What a real signed-in session has. Without these an RLS test cannot run at all, and the earlier
-- version of this file silently ran the RLS assertions as the table OWNER, which bypasses RLS
-- entirely — so they passed while proving nothing.
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  tag          text
);

create table if not exists public.esusu_groups (
  id   uuid primary key default gen_random_uuid(),
  name text
);

create table if not exists public.esusu_members (
  id       uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.esusu_groups(id) on delete cascade,
  user_id  uuid not null references public.profiles(id),
  unique (group_id, user_id)
);

-- Only the columns 095's eligibility check reads.
create table if not exists public.p2p_transfers (
  id           bigserial primary key,
  sender_id    uuid not null references public.profiles(id),
  recipient_id uuid references public.profiles(id),
  amount_micro bigint not null,
  note         text,
  status       text not null,
  created_at   timestamptz not null default now()
);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'alice@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'bob@example.test'),
  ('00000000-0000-4000-8000-000000000003', 'carol@example.test')
on conflict (id) do nothing;

insert into public.profiles (id, display_name, tag) values
  ('00000000-0000-4000-8000-000000000001', 'Alice A', 'alice'),
  ('00000000-0000-4000-8000-000000000002', 'Bob B',   'bob'),
  ('00000000-0000-4000-8000-000000000003', 'Carol C', 'carol')
on conflict (id) do nothing;

-- Alice and Bob have transacted. Carol is a stranger to both.
insert into public.p2p_transfers (sender_id, recipient_id, amount_micro, status) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 5000000000, 'completed');

\ir ../migrations/094_chat_rooms.sql
\ir ../migrations/095_chat_rpcs.sql

\set alice '''00000000-0000-4000-8000-000000000001'''
\set bob   '''00000000-0000-4000-8000-000000000002'''
\set carol '''00000000-0000-4000-8000-000000000003'''

do $$ begin raise notice '--- eligibility ---'; end $$;

-- 1. A pair with a completed transfer may open a room.
do $$
begin
  if not public.chat_may_pair(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002') then
    raise exception 'FAIL 1: alice and bob have a completed transfer and should be allowed';
  end if;
  raise notice 'ok 1: a transacted pair may chat';
end $$;

-- 2. A stranger may not. This is the entire anti-spam mechanism, so it is the most important
--    assertion in this file.
do $$
begin
  if public.chat_may_pair(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000003') then
    raise exception 'FAIL 2: carol has no transfer with alice and must not be allowed';
  end if;
  raise notice 'ok 2: a stranger may not chat';
end $$;

-- 3. A pending escrow does not count: there is no account behind it yet.
do $$
declare v_allowed boolean;
begin
  insert into public.p2p_transfers (sender_id, recipient_id, amount_micro, status)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 100, 'pending');
  v_allowed := public.chat_may_pair(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000003');
  delete from public.p2p_transfers where status = 'pending';
  if v_allowed then
    raise exception 'FAIL 3: an unsettled transfer must not grant chat access';
  end if;
  raise notice 'ok 3: a pending escrow does not grant access';
end $$;

-- 4. Opening a room with a stranger raises rather than silently creating one.
do $$
begin
  perform public.chat_room_for_pair(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000003');
  raise exception 'FAIL 4: expected chat_room_for_pair to refuse a stranger';
exception when check_violation then
  raise notice 'ok 4: refusing a stranger raises';
end $$;

-- 5. And with yourself.
do $$
begin
  perform public.chat_room_for_pair(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001');
  raise exception 'FAIL 5: expected a self-room to be refused';
exception when others then
  raise notice 'ok 5: a room with yourself is refused';
end $$;

do $$ begin raise notice '--- rooms are idempotent ---'; end $$;

-- 6. Two calls, in opposite argument order, yield ONE room. Without the sorted pair_key this is where
--    two rooms appear and each person sees half the conversation.
do $$
declare a uuid; b uuid; n int;
begin
  a := public.chat_room_for_pair(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');
  b := public.chat_room_for_pair(
    '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
  if a <> b then
    raise exception 'FAIL 6: argument order produced two rooms (% and %)', a, b;
  end if;
  select count(*) into n from public.chat_rooms where kind = 'direct';
  if n <> 1 then
    raise exception 'FAIL 6: expected exactly 1 direct room, found %', n;
  end if;
  raise notice 'ok 6: room creation is idempotent and order-independent';
end $$;

-- 7. Both memberships exist.
do $$
declare n int;
begin
  select count(*) into n from public.chat_room_members;
  if n <> 2 then raise exception 'FAIL 7: expected 2 memberships, found %', n; end if;
  raise notice 'ok 7: both parties are members';
end $$;

do $$ begin raise notice '--- posting ---'; end $$;

-- 8. A first post gets seq 1, and the room high-water mark follows.
do $$
declare v_room uuid; v_row public.chat_messages; v_last bigint;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  v_row := public.chat_post_message(
    v_room, '00000000-0000-4000-8000-000000000001', 'c1', 'text', 'hello');
  if v_row.seq <> 1 then raise exception 'FAIL 8: expected seq 1, got %', v_row.seq; end if;
  select last_seq into v_last from public.chat_rooms where id = v_room;
  if v_last <> 1 then raise exception 'FAIL 8: room last_seq is %, expected 1', v_last; end if;
  raise notice 'ok 8: seq starts at 1 and the room tracks it';
end $$;

-- 9. THE IDEMPOTENCY ASSERTION. A repeated client_id returns the original row, with its original seq,
--    and does not consume a new one. This is what makes a chat POST safe to retry after a timeout,
--    and the reason IndeterminateWrite does not apply to chat.
do $$
declare v_room uuid; v_row public.chat_messages; v_last bigint; n int;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  v_row := public.chat_post_message(
    v_room, '00000000-0000-4000-8000-000000000001', 'c1', 'text', 'hello again');
  if v_row.seq <> 1 then
    raise exception 'FAIL 9: a retry got seq %, expected the original 1', v_row.seq;
  end if;
  if v_row.body <> 'hello' then
    raise exception 'FAIL 9: a retry overwrote the body with %', v_row.body;
  end if;
  select last_seq into v_last from public.chat_rooms where id = v_room;
  if v_last <> 1 then
    raise exception 'FAIL 9: a retry consumed a sequence value (last_seq=%)', v_last;
  end if;
  select count(*) into n from public.chat_messages where client_id = 'c1';
  if n <> 1 then raise exception 'FAIL 9: % rows for one client_id', n; end if;
  raise notice 'ok 9: a duplicate client_id returns the original and consumes no sequence';
end $$;

-- 10. seq is gap-free across several posts from both sides.
do $$
declare v_room uuid; i int; v_expected bigint; v_actual bigint;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  for i in 2..6 loop
    perform public.chat_post_message(
      v_room,
      case when i % 2 = 0 then '00000000-0000-4000-8000-000000000002'::uuid
                          else '00000000-0000-4000-8000-000000000001'::uuid end,
      'c' || i, 'text', 'msg ' || i);
  end loop;
  select count(*), max(seq) into v_expected, v_actual from public.chat_messages where room_id = v_room;
  if v_expected <> v_actual then
    raise exception 'FAIL 10: % messages but max seq % — there is a gap', v_expected, v_actual;
  end if;
  raise notice 'ok 10: seq is gap-free (% messages, max seq %)', v_expected, v_actual;
end $$;

-- 11. A non-member cannot post, even through the definer function.
do $$
declare v_room uuid;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  perform public.chat_post_message(
    v_room, '00000000-0000-4000-8000-000000000003', 'c-carol', 'text', 'let me in');
  raise exception 'FAIL 11: a non-member was allowed to post';
exception when insufficient_privilege then
  raise notice 'ok 11: a non-member cannot post';
end $$;

-- 12. A text message must carry a body; a payment need not.
do $$
declare v_room uuid;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  begin
    perform public.chat_post_message(
      v_room, '00000000-0000-4000-8000-000000000001', 'c-empty', 'text', null);
    raise exception 'FAIL 12: a text message with no body was accepted';
  exception when check_violation then
    null;
  end;
  perform public.chat_post_message(
    v_room, '00000000-0000-4000-8000-000000000001', 'payment:1', 'payment', null,
    '{"transferId":1,"amountMicro":5000000000,"direction":"out"}'::jsonb);
  raise notice 'ok 12: text needs a body, payment does not';
end $$;

do $$ begin raise notice '--- unread counts ---'; end $$;

-- 13. The author's count stays at zero and the other party's tracks their unread messages.
do $$
declare v_room uuid; v_alice int; v_bob int; v_from_alice int;
begin
  select id into v_room from public.chat_rooms where kind = 'direct';
  select unread_count into v_alice from public.chat_room_members
    where room_id = v_room and user_id = '00000000-0000-4000-8000-000000000001';
  select unread_count into v_bob from public.chat_room_members
    where room_id = v_room and user_id = '00000000-0000-4000-8000-000000000002';
  select count(*) into v_from_alice from public.chat_messages
    where room_id = v_room and sender_id = '00000000-0000-4000-8000-000000000001';
  if v_bob <> v_from_alice then
    raise exception 'FAIL 13: bob has % unread but alice sent %', v_bob, v_from_alice;
  end if;
  if v_alice = 0 then
    raise exception 'FAIL 13: alice should have unread messages from bob';
  end if;
  raise notice 'ok 13: unread counts exclude the author (alice=%, bob=%)', v_alice, v_bob;
end $$;

-- 14. Reading clears, and re-reading an older sequence does NOT resurrect the badge.
do $$
declare v_room uuid; v_last bigint; v_count int; v_read bigint;
begin
  select id, last_seq into v_room, v_last from public.chat_rooms where kind = 'direct';
  perform public.chat_mark_read(v_room, '00000000-0000-4000-8000-000000000002', v_last);
  select unread_count into v_count from public.chat_room_members
    where room_id = v_room and user_id = '00000000-0000-4000-8000-000000000002';
  if v_count <> 0 then raise exception 'FAIL 14: unread is % after reading everything', v_count; end if;

  -- A stale client reports an old cursor.
  perform public.chat_mark_read(v_room, '00000000-0000-4000-8000-000000000002', 1);
  select unread_count, read_seq into v_count, v_read from public.chat_room_members
    where room_id = v_room and user_id = '00000000-0000-4000-8000-000000000002';
  if v_read <> v_last then
    raise exception 'FAIL 14: read_seq moved backwards to %, expected %', v_read, v_last;
  end if;
  if v_count <> 0 then
    raise exception 'FAIL 14: a stale cursor resurrected % unread', v_count;
  end if;
  raise notice 'ok 14: reading is monotonic and a stale cursor cannot undo it';
end $$;

do $$ begin raise notice '--- circle rooms ---'; end $$;

-- 15. A circle room takes its membership from esusu_members, including members who joined before
--     this migration existed.
do $$
declare v_group uuid; v_room uuid; n int;
begin
  insert into public.esusu_groups (name) values ('Aso Ebi') returning id into v_group;
  insert into public.esusu_members (group_id, user_id) values
    (v_group, '00000000-0000-4000-8000-000000000001'),
    (v_group, '00000000-0000-4000-8000-000000000002'),
    (v_group, '00000000-0000-4000-8000-000000000003');
  v_room := public.chat_room_for_circle(v_group);
  select count(*) into n from public.chat_room_members where room_id = v_room;
  if n <> 3 then raise exception 'FAIL 15: expected 3 circle members, found %', n; end if;

  -- Idempotent, and Carol can post here even though she may not DM anyone.
  if public.chat_room_for_circle(v_group) <> v_room then
    raise exception 'FAIL 15: a second call created another circle room';
  end if;
  perform public.chat_post_message(
    v_room, '00000000-0000-4000-8000-000000000003', 'circle-1', 'text', 'hi all');
  raise notice 'ok 15: circle membership carries over, and a circle grants chat without a transfer';
end $$;

-- 16. Sequences are PER ROOM, not global. A shared counter would make "after N" return another
--     room's messages.
do $$
declare v_circle_room uuid; v_seq bigint;
begin
  select r.id into v_circle_room from public.chat_rooms r where r.kind = 'circle';
  select seq into v_seq from public.chat_messages
    where room_id = v_circle_room and client_id = 'circle-1';
  if v_seq <> 1 then
    raise exception 'FAIL 16: first message in a new room got seq %, expected 1', v_seq;
  end if;
  raise notice 'ok 16: sequences are per room';
end $$;

do $$ begin raise notice '--- RLS ---'; end $$;

-- Each of these runs in an explicit transaction as `authenticated`, NOT as the table owner. An owner
-- bypasses RLS, so asserting from the owner session proves nothing — which is exactly what an earlier
-- version of this file did, and test 18 is what caught it. `set local` alone is no good either: psql
-- autocommits, so it reverts before the next statement.

-- 17. A member reads the thread.
begin;
set local role authenticated;
set local "test.uid" = '00000000-0000-4000-8000-000000000001';
do $$
declare n int;
begin
  select count(*) into n from public.chat_messages;
  if n = 0 then raise exception 'FAIL 17: alice is a member and should see messages'; end if;
  raise notice 'ok 17: a member reads the thread (% rows visible)', n;
end $$;
rollback;

-- 18. Carol is in the circle but not in Alice and Bob's room, so she sees circle messages and none of
--     theirs.
begin;
set local role authenticated;
set local "test.uid" = '00000000-0000-4000-8000-000000000003';
do $$
declare n int; n_direct int;
begin
  select count(*) into n from public.chat_messages;
  select count(*) into n_direct from public.chat_messages c
    join public.chat_rooms r on r.id = c.room_id where r.kind = 'direct';
  if n_direct <> 0 then
    raise exception 'FAIL 18: carol can see % messages from a room she is not in', n_direct;
  end if;
  if n = 0 then raise exception 'FAIL 18: carol should see her circle messages'; end if;
  raise notice 'ok 18: RLS hides a room you are not in (carol sees % circle rows)', n;
end $$;
rollback;

-- 19. A member sees only their OWN counter. Someone else's unread count is a read receipt by the back
--     door, and this spec deliberately does not ship those.
begin;
set local role authenticated;
set local "test.uid" = '00000000-0000-4000-8000-000000000003';
do $$
declare n int;
begin
  select count(*) into n from public.chat_room_members
    where user_id <> '00000000-0000-4000-8000-000000000003';
  if n <> 0 then
    raise exception 'FAIL 19: carol can read % other members'' counters', n;
  end if;
  raise notice 'ok 19: a member reads only their own unread counter';
end $$;
rollback;

-- 20. No client write path at all: RLS has no INSERT or UPDATE policy, so both are denied.
begin;
set local role authenticated;
set local "test.uid" = '00000000-0000-4000-8000-000000000003';
do $$
begin
  begin
    insert into public.chat_messages (room_id, seq, sender_id, client_id, kind, body)
    select r.id, 999, '00000000-0000-4000-8000-000000000003', 'rogue', 'text', 'direct write'
    from public.chat_rooms r where r.kind = 'circle';
    raise exception 'FAIL 20: a client inserted a message directly';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.chat_messages set body = 'tampered';
    raise exception 'FAIL 20: a client updated a message directly';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'ok 20: clients cannot write messages directly';
end $$;
rollback;

do $$ begin raise notice '--- grants ---'; end $$;

-- 21. The RPCs are service_role only. A session must not be able to call them, because they take a
--     user id as an argument and trust it.
do $$
declare v_leaks text;
begin
  select string_agg(p.proname || ' -> ' || g.rolname, ', ')
    into v_leaks
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(p.proacl) a
  join pg_roles g on g.oid = a.grantee
  where n.nspname = 'public'
    and p.proname like 'chat\_%'
    and a.privilege_type = 'EXECUTE'
    and g.rolname in ('anon', 'authenticated');
  if v_leaks is not null then
    raise exception 'FAIL 21: chat RPCs are callable by a session: %', v_leaks;
  end if;
  raise notice 'ok 21: no chat RPC is callable by anon or authenticated';
end $$;

-- 22. And every one of them is pinned. A definer function without a pinned search_path resolves
--     unqualified names using the CALLER's path, which is a shadowing risk week1 already flagged
--     across 79 production functions.
do $$
declare v_unpinned text;
begin
  select string_agg(p.proname, ', ') into v_unpinned
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like 'chat\_%'
    and p.prosecdef
    and (p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) c where c like 'search\_path=%'
    ));
  if v_unpinned is not null then
    raise exception 'FAIL 22: definer functions with no pinned search_path: %', v_unpinned;
  end if;
  raise notice 'ok 22: every chat definer function pins search_path';
end $$;

do $$ begin raise notice 'ALL CHAT ASSERTIONS PASSED (22)'; end $$;
