# Applying 094–097 (chat and realtime)

**What this adds:** rooms, membership, messages, the RPCs that write them, a backfill of existing
circle messages and payment history, and the ticket table the socket upgrade needs.

**Blast radius:** additive only. Four new tables and eight new functions. Nothing existing is altered
or dropped — `circle_messages` is read but not modified, and `p2p_transfers` is read but not modified.
The running app and web app do not touch any of this until the new routes are deployed, so these can
be applied ahead of a deploy with no user-visible effect.

**Run them in filename order.** Not number order: there are two `092` files on disk already
(`092_push_devices.sql` and `092_morpho_unwind_clear_error.sql`), so the number alone is not an
ordering.

---

## 0. Pre-flight

Confirm the prerequisites exist and none of this is already applied. Paste into the Supabase SQL
editor:

```sql
-- Prerequisites 094–096 depend on. All four must be true.
select
  to_regclass('public.profiles')        is not null as has_profiles,
  to_regclass('public.esusu_groups')    is not null as has_esusu_groups,
  to_regclass('public.esusu_members')   is not null as has_esusu_members,
  to_regclass('public.p2p_transfers')   is not null as has_p2p_transfers,
  to_regclass('public.circle_messages') is not null as has_circle_messages;

-- Already applied? All five should be false on a first run.
select
  to_regclass('public.chat_rooms')        is not null as chat_rooms,
  to_regclass('public.chat_room_members') is not null as chat_room_members,
  to_regclass('public.chat_messages')     is not null as chat_messages,
  to_regclass('public.realtime_tickets')  is not null as realtime_tickets,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'chat_post_message') as chat_rpcs;
```

Then see how much data 096 will move, so the numbers afterwards are checkable rather than a surprise:

```sql
-- Circle messages to copy, and how many circle rooms they imply.
select count(*) as circle_messages, count(distinct group_id) as circle_rooms
from public.circle_messages;

-- Settled transfers to derive payment bubbles from, and how many 1:1 rooms they imply.
select
  count(*) as payment_messages,
  count(distinct least(sender_id, recipient_id)::text || greatest(sender_id, recipient_id)::text)
    as direct_rooms
from public.p2p_transfers
where recipient_id is not null
  and sender_id <> recipient_id
  and status in ('completed', 'claimed');
```

**Write those four numbers down.** Step 3 checks against them.

---

## 1. `094_chat_rooms.sql` — tables

Paste the file whole. Expect `CREATE TABLE` ×3, some `CREATE INDEX`, `ALTER TABLE` ×3,
`CREATE POLICY` ×3, `GRANT` ×3, `REVOKE` ×3.

`DROP POLICY IF EXISTS` lines will emit `NOTICE: policy ... does not exist, skipping` on a first run.
That is expected and not an error.

Verify:

```sql
-- Three tables, RLS on, and NO write policy anywhere: every write goes through 095's functions.
select c.relname, c.relrowsecurity as rls_enabled,
       count(p.policyname) filter (where p.cmd = 'SELECT') as select_policies,
       count(p.policyname) filter (where p.cmd <> 'SELECT') as write_policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.tablename = c.relname and p.schemaname = 'public'
where n.nspname = 'public' and c.relname in ('chat_rooms','chat_room_members','chat_messages')
group by c.relname, c.relrowsecurity
order by c.relname;
```

Expect three rows, `rls_enabled = true`, `select_policies = 1`, **`write_policies = 0`** on each.
A non-zero write policy means a client could write messages directly, and that is the one result here
worth stopping for.

---

## 2. `095_chat_rpcs.sql` — the writers

Paste whole. Expect `CREATE FUNCTION` ×5, then `REVOKE` ×5 and `GRANT` ×5.

Verify:

```sql
-- Five functions, all SECURITY DEFINER, all with search_path pinned, and callable ONLY by
-- service_role. A row appearing here for anon or authenticated is a problem: these take a user id
-- as an argument and trust it, so a session reaching them would be an impersonation bypass.
select p.proname,
       p.prosecdef as security_definer,
       exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search\_path=%')
         as search_path_pinned,
       coalesce(string_agg(g.rolname, ',' order by g.rolname), 'none') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join lateral aclexplode(p.proacl) a on true
left join pg_roles g on g.oid = a.grantee and a.privilege_type = 'EXECUTE'
  and g.rolname in ('anon','authenticated','service_role')
where n.nspname = 'public' and p.proname like 'chat\_%'
group by p.proname, p.prosecdef, p.proconfig
order by p.proname;
```

Expect five rows: `chat_may_pair`, `chat_mark_read`, `chat_post_message`, `chat_room_for_circle`,
`chat_room_for_pair`. Each `security_definer = true`, `search_path_pinned = true`,
`can_execute = service_role`.

---

## 3. `096_chat_backfill.sql` — the data move

This is the only step that writes rows. It is **idempotent**: every insert is keyed on a derived
`client_id`, so running it twice adds nothing. If it fails part way, fix and re-run rather than trying
to undo.

Paste whole. On a small dataset it returns immediately.

Verify against the numbers from step 0:

```sql
-- Rooms and messages created.
select
  (select count(*) from public.chat_rooms where kind = 'circle') as circle_rooms,
  (select count(*) from public.chat_rooms where kind = 'direct') as direct_rooms,
  (select count(*) from public.chat_messages where kind = 'text' and client_id like 'legacy:%')
    as copied_circle_messages,
  (select count(*) from public.chat_messages where kind = 'payment') as payment_messages;
```

These should match the four numbers you wrote down.

```sql
-- Every room's high-water mark matches its contents. A mismatch means the next real message would
-- collide on (room_id, seq).
select r.id, r.kind, r.last_seq, max(m.seq) as actual_max
from public.chat_rooms r
join public.chat_messages m on m.room_id = r.id
group by r.id, r.kind, r.last_seq
having r.last_seq <> max(m.seq);
```

Expect **zero rows**.

```sql
-- History must arrive READ. A non-zero total here means every existing user opens the app to a wall
-- of unread badges for conversations they have already had.
select coalesce(sum(unread_count), 0) as total_unread,
       count(*) filter (where m.read_seq <> r.last_seq) as cursors_not_at_end
from public.chat_room_members m
join public.chat_rooms r on r.id = m.room_id;
```

Expect `total_unread = 0` and `cursors_not_at_end = 0`.

```sql
-- circle_messages is untouched, so a rollback cannot lose messages.
select count(*) from public.circle_messages;
```

Should equal the count from step 0.

---

## 4. `097_realtime_tickets.sql` — socket credentials

Independent of 094–096; it only needs `profiles`. Paste whole.

Verify:

```sql
-- RLS on with NO policy at all, so the table is unreadable even by the account a ticket belongs to,
-- and both functions are service_role only. realtime_ticket_issue takes a user id and never consults
-- auth.uid(), so a session reaching it would be a complete authentication bypass.
select
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'realtime_tickets') as rls_enabled,
  (select count(*) from pg_policies where schemaname = 'public'
    and tablename = 'realtime_tickets') as policies,
  (select coalesce(string_agg(distinct g.rolname, ','), 'none')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     left join lateral aclexplode(p.proacl) a on true
     left join pg_roles g on g.oid = a.grantee and a.privilege_type = 'EXECUTE'
       and g.rolname in ('anon','authenticated')
    where n.nspname = 'public' and p.proname like 'realtime\_ticket%') as session_can_execute;
```

Expect `rls_enabled = true`, `policies = 0`, `session_can_execute = none`.

---

## 5. Smoke test, without the app

Proves the write path works before any client depends on it. Replace the two ids with real
`profiles.id` values **that have a completed transfer between them** — the pair rule is enforced, so
two arbitrary accounts will be refused, which is itself the correct behaviour.

```sql
-- Find a pair that is allowed to chat.
select sender_id, recipient_id
from public.p2p_transfers
where recipient_id is not null and sender_id <> recipient_id
  and status in ('completed','claimed')
limit 1;
```

```sql
-- Then, with those two ids:
select public.chat_room_for_pair('<sender>', '<recipient>') as room_id;
-- Calling it again must return the SAME id. Two ids here means each person would see half the
-- conversation.
```

```sql
-- Post, then post again with the same client_id. The second must return the FIRST row, with the same
-- seq, and must not have consumed a sequence value. That idempotency is what makes a retry after a
-- timeout safe.
select seq, client_id, body from public.chat_post_message(
  '<room_id>', '<sender>', 'smoke-test-1', 'text', 'runbook smoke test');
select seq, client_id, body from public.chat_post_message(
  '<room_id>', '<sender>', 'smoke-test-1', 'text', 'different body, ignored');
```

Clean up:

```sql
delete from public.chat_messages where client_id = 'smoke-test-1';
-- Put the room's mark back so the next real message does not skip a number.
update public.chat_rooms r set last_seq = coalesce(
  (select max(seq) from public.chat_messages m where m.room_id = r.id), 0)
 where r.id = '<room_id>';
```

---

## If something goes wrong

**094 or 095 fails part way.** Nothing has moved. Fix and re-run; every statement is
`IF NOT EXISTS` or `CREATE OR REPLACE`.

**096 fails part way.** Re-run it. It is idempotent, and a partial run leaves valid rows plus a
possibly stale `last_seq`, which step 5 of the file itself corrects on the next run.

**You want it all gone.** Additive, so it reverses cleanly, and `circle_messages` still holds the
original data:

```sql
drop table if exists public.chat_messages, public.chat_room_members, public.chat_rooms cascade;
drop table if exists public.realtime_tickets cascade;
drop function if exists public.chat_post_message(uuid, uuid, text, text, text, jsonb);
drop function if exists public.chat_mark_read(uuid, uuid, bigint);
drop function if exists public.chat_room_for_pair(uuid, uuid);
drop function if exists public.chat_room_for_circle(uuid);
drop function if exists public.chat_may_pair(uuid, uuid);
drop function if exists public.realtime_ticket_issue(uuid, text, int);
drop function if exists public.realtime_ticket_consume(text);
```

---

## Local rehearsal

All four are covered by throwaway-Postgres harnesses, which is the cheapest way to see them run
before touching production. 33 assertions across the first three, 12 on the fourth:

```bash
bash supabase/tests/094_095_chat_run.sh       # 22 assertions
bash supabase/tests/096_chat_backfill_run.sh  # 11, and applies 096 twice to prove re-running is safe
bash supabase/tests/097_realtime_tickets_run.sh  # 12
```

Each spins a disposable container, applies the migrations and asserts behaviour rather than shape.
They need Docker and `psql`.
