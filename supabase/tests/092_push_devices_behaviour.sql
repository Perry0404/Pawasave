-- Proves 092_push_devices.sql behaves, against a throwaway postgres.
--
-- Run: bash supabase/tests/092_push_devices_run.sh
--
-- The interesting cases are all about a token outliving the account that registered it. A device
-- token is a capability to reach a handset, and handsets get handed over, wiped and re-signed-in, so
-- "same token, different user" is the normal case rather than the edge one.
--
-- auth.uid() is stubbed as a settable GUC so both callers can be simulated: the service role (null,
-- which is how the routes call in) and a signed-in user acting as somebody else.

-- ── stand-ins for the Supabase objects the migration depends on ──────────────
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

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Settable stand-in for auth.uid(). Empty string means "no JWT", i.e. the service role.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'a@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'b@example.test')
on conflict (id) do nothing;

\set alice '00000000-0000-4000-8000-000000000001'
\set bob   '00000000-0000-4000-8000-000000000002'

-- ── the migration under test ─────────────────────────────────────────────────
\i supabase/migrations/092_push_devices.sql

-- ── assertions ───────────────────────────────────────────────────────────────
set test.uid = '';  -- service role context, which is how the route calls in

create temp table results (ord int, name text, ok boolean, detail text);

-- 1. A fresh registration inserts one live row.
do $$
declare v_id bigint; v_rows int;
begin
  v_id := public.push_device_register('00000000-0000-4000-8000-000000000001', 'tok-alice-1', 'android', '1.0.0');
  select count(*) into v_rows from public.push_devices where token = 'tok-alice-1' and dead_at is null;
  insert into results values (1, 'register inserts one live row', v_id is not null and v_rows = 1,
    format('id=%s rows=%s', v_id, v_rows));
end $$;

-- 2. Registering the same token again is idempotent: still one row, not two.
do $$
declare v_rows int; v_first bigint; v_second bigint;
begin
  select id into v_first from public.push_devices where token = 'tok-alice-1';
  v_second := public.push_device_register('00000000-0000-4000-8000-000000000001', 'tok-alice-1', 'android', '1.1.0');
  select count(*) into v_rows from public.push_devices where token = 'tok-alice-1';
  insert into results values (2, 're-register is idempotent, same row', v_rows = 1 and v_first = v_second,
    format('rows=%s first=%s second=%s', v_rows, v_first, v_second));
end $$;

-- 3. The same handset signing in as someone else REASSIGNS the row. This is the one that matters:
--    a second row would leave the previous owner able to push to a phone they no longer have.
do $$
declare v_rows int; v_owner uuid;
begin
  perform public.push_device_register('00000000-0000-4000-8000-000000000002', 'tok-alice-1', 'android', '1.1.0');
  select count(*) into v_rows from public.push_devices where token = 'tok-alice-1';
  select user_id into v_owner from public.push_devices where token = 'tok-alice-1';
  insert into results values (3, 'same token reassigns, never duplicates',
    v_rows = 1 and v_owner = '00000000-0000-4000-8000-000000000002',
    format('rows=%s owner=%s', v_rows, v_owner));
end $$;

-- 4. A permanent provider rejection marks the token dead, and it drops out of the live index.
do $$
declare v_marked boolean; v_dead timestamptz;
begin
  v_marked := public.push_device_mark_dead('tok-alice-1');
  select dead_at into v_dead from public.push_devices where token = 'tok-alice-1';
  insert into results values (4, 'mark_dead sets dead_at', v_marked and v_dead is not null,
    format('marked=%s dead_at=%s', v_marked, v_dead));
end $$;

-- 5. Marking an already-dead token again returns false rather than churning the timestamp.
do $$
declare v_again boolean;
begin
  v_again := public.push_device_mark_dead('tok-alice-1');
  insert into results values (5, 'mark_dead is idempotent', v_again = false, format('again=%s', v_again));
end $$;

-- 6. Re-registering revives a dead token. Without this a user who reinstalls is silently unreachable.
do $$
declare v_dead timestamptz;
begin
  perform public.push_device_register('00000000-0000-4000-8000-000000000002', 'tok-alice-1', 'ios', '1.2.0');
  select dead_at into v_dead from public.push_devices where token = 'tok-alice-1';
  insert into results values (6, 're-register revives a dead token', v_dead is null,
    format('dead_at=%s', v_dead));
end $$;

-- 7. forget removes only the caller's own row, even when the token is known.
do $$
declare v_wrong boolean; v_right boolean; v_left int;
begin
  -- Alice no longer owns tok-alice-1 (it was reassigned to Bob in case 3).
  v_wrong := public.push_device_forget('00000000-0000-4000-8000-000000000001', 'tok-alice-1');
  select count(*) into v_left from public.push_devices where token = 'tok-alice-1';
  v_right := public.push_device_forget('00000000-0000-4000-8000-000000000002', 'tok-alice-1');
  insert into results values (7, 'forget is scoped to the owner',
    v_wrong = false and v_left = 1 and v_right = true,
    format('wrong=%s survived=%s right=%s', v_wrong, v_left, v_right));
end $$;

-- 8. Forgetting an unknown token is a no-op, so a retried sign-out does not error.
do $$
declare v_unknown boolean;
begin
  v_unknown := public.push_device_forget('00000000-0000-4000-8000-000000000001', 'never-seen');
  insert into results values (8, 'forget an unknown token is a no-op', v_unknown = false,
    format('result=%s', v_unknown));
end $$;

-- 9. An empty token is refused rather than stored.
do $$
begin
  begin
    perform public.push_device_register('00000000-0000-4000-8000-000000000001', '   ', 'android', null);
    insert into results values (9, 'empty token is refused', false, 'no exception raised');
  exception when others then
    insert into results values (9, 'empty token is refused', true, sqlerrm);
  end;
end $$;

-- 10. An unknown platform is refused by the CHECK constraint.
do $$
begin
  begin
    perform public.push_device_register('00000000-0000-4000-8000-000000000001', 'tok-web', 'web', null);
    insert into results values (10, 'unknown platform is refused', false, 'no exception raised');
  exception when others then
    insert into results values (10, 'unknown platform is refused', true, 'rejected');
  end;
end $$;

-- 11. A signed-in user cannot register a device against somebody else's account. This guard only
--     matters if the service_role grant is ever widened, which is exactly when it would be missed.
do $$
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  begin
    perform public.push_device_register('00000000-0000-4000-8000-000000000002', 'tok-impersonate', 'ios', null);
    insert into results values (11, 'cannot register for another user', false, 'no exception raised');
  exception when others then
    insert into results values (11, 'cannot register for another user', true, sqlerrm);
  end;
end $$;

-- 12. Same guard on forget.
do $$
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  begin
    perform public.push_device_forget('00000000-0000-4000-8000-000000000002', 'anything');
    insert into results values (12, 'cannot forget another user''s device', false, 'no exception raised');
  exception when others then
    insert into results values (12, 'cannot forget another user''s device', true, sqlerrm);
  end;
end $$;

-- 13. The client roles hold no EXECUTE on any of the three functions.
do $$
declare v_leaks text;
begin
  select string_agg(format('%s->%s', p.proname, r.rolname), ', ')
    into v_leaks
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('public')) as r(rolname)
  where n.nspname = 'public'
    and p.proname in ('push_device_register', 'push_device_forget', 'push_device_mark_dead')
    and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  insert into results values (13, 'no EXECUTE for anon/authenticated/public', v_leaks is null,
    coalesce(v_leaks, 'none'));
end $$;

-- 14. service_role does hold EXECUTE on all three, or the routes cannot call them.
do $$
declare v_count int;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('push_device_register', 'push_device_forget', 'push_device_mark_dead')
    and has_function_privilege('service_role', p.oid, 'EXECUTE');
  insert into results values (14, 'service_role can execute all three', v_count = 3,
    format('count=%s', v_count));
end $$;

-- 15. The table itself is unreachable by anon, and read-only to authenticated.
do $$
declare v_anon_select boolean; v_auth_insert boolean; v_auth_select boolean;
begin
  v_anon_select := has_table_privilege('anon', 'public.push_devices', 'SELECT');
  v_auth_select := has_table_privilege('authenticated', 'public.push_devices', 'SELECT');
  v_auth_insert := has_table_privilege('authenticated', 'public.push_devices', 'INSERT');
  insert into results values (15, 'anon no read, authenticated read-only',
    v_anon_select = false and v_auth_select = true and v_auth_insert = false,
    format('anon_select=%s auth_select=%s auth_insert=%s', v_anon_select, v_auth_select, v_auth_insert));
end $$;

-- 16. RLS is on, and the read policy is the only policy.
do $$
declare v_rls boolean; v_policies int;
begin
  select relrowsecurity into v_rls from pg_class where oid = 'public.push_devices'::regclass;
  select count(*) into v_policies from pg_policies where tablename = 'push_devices';
  insert into results values (16, 'RLS enabled, one read-only policy', v_rls and v_policies = 1,
    format('rls=%s policies=%s', v_rls, v_policies));
end $$;

\echo
select case when ok then 'PASS' else 'FAIL' end as result, name, detail
from results order by ord;

\echo
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as summary
from results;

-- Non-zero exit when anything failed, so the runner can gate on it.
do $$
declare v_failed int;
begin
  select count(*) into v_failed from results where not ok;
  if v_failed > 0 then
    raise exception '% assertion(s) failed', v_failed;
  end if;
end $$;
