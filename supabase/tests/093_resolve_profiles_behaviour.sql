-- Proves 093_resolve_profiles.sql behaves, against a throwaway postgres.
--
-- Run: bash supabase/tests/093_resolve_profiles_run.sh
--
-- Two things are under test. The projection, because the column list in that function IS the
-- security boundary: `profiles` holds a phone number, KYC state, a BVN hash and a PIN hash, and a
-- careless `SELECT p.*` there would hand all of it to any signed-in user. And the search_path pins
-- that 093 attaches to 092's three functions, since a signature typo in an ALTER only shows up when
-- the migration is pasted into production by hand.
--
-- auth.uid() is a settable GUC so both callers can be simulated: anonymous, and a signed-in user.

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

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

-- `profiles` as production has it: the safe columns 093 exposes, plus the sensitive ones it must
-- never return. 084 added `tag`.
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  phone                text,
  display_name         text not null default '',
  tag                  text,
  kyc_status           text,
  kyc_tier             text,
  bvn_hash             text,
  transaction_pin_hash text,
  created_at           timestamptz not null default now()
);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'alice@example.test'),
  ('00000000-0000-4000-8000-000000000002', 'bob@example.test'),
  ('00000000-0000-4000-8000-000000000003', 'carol@example.test')
on conflict (id) do nothing;

insert into public.profiles (id, phone, display_name, tag, kyc_status, kyc_tier, bvn_hash, transaction_pin_hash)
values
  ('00000000-0000-4000-8000-000000000001', '+2348030000001', 'Alice A', 'alice', 'verified', 'full', 'BVNHASH-A', 'PINHASH-A'),
  ('00000000-0000-4000-8000-000000000002', '+2348030000002', 'Bob B',   'bob',   'verified', 'lite', 'BVNHASH-B', 'PINHASH-B'),
  ('00000000-0000-4000-8000-000000000003', '+2348030000003', 'Carol C', null,    'none',     'none', null,        null)
on conflict (id) do nothing;

-- 092 is applied first because 093 ALTERs the functions it creates.
\i supabase/migrations/092_push_devices.sql
\i supabase/migrations/093_resolve_profiles.sql

-- ── assertions ───────────────────────────────────────────────────────────────
create temp table results (ord int, name text, ok boolean, detail text);

-- 1. A signed-in user can resolve a counterparty they are not.
do $$
declare v_tag text; v_name text; v_rows int;
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  select count(*) into v_rows
  from public.resolve_profiles(array['00000000-0000-4000-8000-000000000002']::uuid[]);
  select tag, display_name into v_tag, v_name
  from public.resolve_profiles(array['00000000-0000-4000-8000-000000000002']::uuid[]);
  insert into results values (1, 'resolves a counterparty who is not the caller',
    v_rows = 1 and v_tag = 'bob' and v_name = 'Bob B', format('rows=%s tag=%s name=%s', v_rows, v_tag, v_name));
end $$;

-- 2. The projection is exactly three columns. This is the security boundary.
do $$
declare v_cols text;
begin
  select string_agg(a.attname, ',' order by a.attnum) into v_cols
  from pg_proc p
  join pg_type t on t.oid = p.prorettype
  join pg_class c on c.reltype = t.oid
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
  where p.proname = 'resolve_profiles' and p.pronamespace = 'public'::regnamespace;

  -- Fall back to the declared OUT parameter names when the return type is a record.
  if v_cols is null then
    select string_agg(unnest, ',') into v_cols from unnest(
      (select proargnames from pg_proc where proname = 'resolve_profiles' and pronamespace = 'public'::regnamespace)
    ) as unnest where unnest <> 'p_ids';
  end if;

  insert into results values (2, 'projection is exactly id, tag, display_name',
    v_cols = 'id,tag,display_name', format('cols=%s', v_cols));
end $$;

-- 3. No sensitive value is reachable through it, whatever the caller asks for.
do $$
declare v_leak text;
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  -- Serialise every returned row and look for anything that must never appear.
  select string_agg(r::text, ' ') into v_leak
  from public.resolve_profiles(array[
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002'
  ]::uuid[]) r;

  insert into results values (3, 'no phone, kyc, bvn or pin hash in the output',
    v_leak not like '%+234%' and v_leak not like '%BVNHASH%'
      and v_leak not like '%PINHASH%' and v_leak not like '%verified%',
    coalesce(v_leak, '(null)'));
end $$;

-- 4. Anonymous callers are refused. Without this it is a public directory.
do $$
begin
  set local test.uid = '';
  begin
    perform * from public.resolve_profiles(array['00000000-0000-4000-8000-000000000002']::uuid[]);
    insert into results values (4, 'anonymous caller is refused', false, 'no exception raised');
  exception when others then
    insert into results values (4, 'anonymous caller is refused', true, sqlerrm);
  end;
end $$;

-- 5. A batch resolves in one call, which is the whole point for a feed.
do $$
declare v_rows int;
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  select count(*) into v_rows from public.resolve_profiles(array[
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003'
  ]::uuid[]);
  insert into results values (5, 'resolves a batch in one call', v_rows = 3, format('rows=%s', v_rows));
end $$;

-- 6. A null tag comes back as null rather than breaking the call. Carol has no tag yet, which is the
--    state of anyone who has not claimed one.
do $$
declare v_tag text; v_name text;
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  select tag, display_name into v_tag, v_name
  from public.resolve_profiles(array['00000000-0000-4000-8000-000000000003']::uuid[]);
  insert into results values (6, 'a profile with no tag still resolves',
    v_tag is null and v_name = 'Carol C', format('tag=%s name=%s', coalesce(v_tag,'(null)'), v_name));
end $$;

-- 7. Unknown and empty inputs are quiet, not errors.
do $$
declare v_unknown int; v_empty int; v_null int;
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  select count(*) into v_unknown from public.resolve_profiles(array['00000000-0000-4000-8000-0000000000ff']::uuid[]);
  select count(*) into v_empty   from public.resolve_profiles(array[]::uuid[]);
  select count(*) into v_null    from public.resolve_profiles(null::uuid[]);
  insert into results values (7, 'unknown, empty and null inputs return no rows',
    v_unknown = 0 and v_empty = 0 and v_null = 0,
    format('unknown=%s empty=%s null=%s', v_unknown, v_empty, v_null));
end $$;

-- 8. The cap blocks bulk enumeration.
do $$
declare v_ids uuid[];
begin
  set local test.uid = '00000000-0000-4000-8000-000000000001';
  select array_agg(('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid)
    into v_ids from generate_series(1, 201) g;
  begin
    perform * from public.resolve_profiles(v_ids);
    insert into results values (8, 'more than 200 ids is refused', false, 'no exception raised');
  exception when others then
    insert into results values (8, 'more than 200 ids is refused', true, sqlerrm);
  end;
end $$;

-- 9. Grants: anon and PUBLIC hold no EXECUTE, authenticated does.
do $$
declare v_anon boolean; v_public boolean; v_auth boolean; v_svc boolean;
begin
  v_anon   := has_function_privilege('anon', 'public.resolve_profiles(uuid[])', 'EXECUTE');
  v_public := has_function_privilege('public', 'public.resolve_profiles(uuid[])', 'EXECUTE');
  v_auth   := has_function_privilege('authenticated', 'public.resolve_profiles(uuid[])', 'EXECUTE');
  v_svc    := has_function_privilege('service_role', 'public.resolve_profiles(uuid[])', 'EXECUTE');
  insert into results values (9, 'anon and PUBLIC cannot execute; authenticated and service_role can',
    v_anon = false and v_public = false and v_auth and v_svc,
    format('anon=%s public=%s auth=%s service=%s', v_anon, v_public, v_auth, v_svc));
end $$;

-- 10. search_path is pinned on 093's function AND on 092's three, which is what the ALTERs are for.
do $$
declare v_missing text;
begin
  select string_agg(p.proname, ', ') into v_missing
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('resolve_profiles', 'push_device_register', 'push_device_forget', 'push_device_mark_dead')
    and p.prosecdef
    and (p.proconfig is null or not exists (
      select 1 from unnest(p.proconfig) c where c like 'search\_path=%'
    ));
  insert into results values (10, 'search_path pinned on all four definer functions',
    v_missing is null, coalesce('unpinned: ' || v_missing, 'all pinned'));
end $$;

\echo
select case when ok then 'PASS' else 'FAIL' end as result, name, detail
from results order by ord;

\echo
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as summary
from results;

do $$
declare v_failed int;
begin
  select count(*) into v_failed from results where not ok;
  if v_failed > 0 then
    raise exception '% assertion(s) failed', v_failed;
  end if;
end $$;
