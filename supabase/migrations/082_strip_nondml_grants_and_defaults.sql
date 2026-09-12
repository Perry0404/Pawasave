-- 082_strip_nondml_grants_and_defaults.sql  (run after 081)
--
-- Two problems, both from Supabase's default grants.
--
-- 1. anon and authenticated hold TRUNCATE on all 40 public tables, including wallets,
--    transactions and profiles. RLS does not filter TRUNCATE, so nothing in 077-080 protects
--    against it. anon cannot log in and PostgREST offers no way to issue a TRUNCATE, so this is
--    latent rather than reachable today. It is also free to remove.
--
-- 2. Every newly created function is executable by anon, because CREATE FUNCTION grants EXECUTE
--    to PUBLIC. So the 077/078 result, one anon-callable function down from 69, regresses the
--    moment anyone adds an RPC. This is the part that actually matters.
--
-- ALTER DEFAULT PRIVILEGES does not fix (2). Revoking EXECUTE from PUBLIC and from anon there
-- both apply cleanly and change nothing: new functions still come out with =X/postgres. Verified
-- on staging. PUBLIC's EXECUTE on functions is re-applied at creation regardless. So functions
-- are handled with an event trigger instead, which is enforcement rather than a default.
--
-- DML is deliberately left alone. transactions, savings_goals and the esusu tables still take
-- browser writes, and revoking INSERT here would break the app. Those move server-side in F1-F5.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

-- ── existing tables ─────────────────────────────────────────────────────────
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- MAINTAIN is Postgres 17 only. Skip cleanly on older servers.
do $$
begin
  execute 'revoke maintain on all tables in schema public from anon, authenticated';
exception
  when syntax_error or feature_not_supported then
    raise notice 'MAINTAIN not supported here, skipped';
end $$;

-- ── future tables ───────────────────────────────────────────────────────────
-- Only the postgres default ACL is reachable from this role, and that is the one that counts:
-- migrations run as postgres, so new objects inherit it. The supabase_admin entry governs objects
-- Supabase's own tooling creates and stays as-is.
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;

-- ── future functions ────────────────────────────────────────────────────────
-- anon keeps EXECUTE only where someone granted it deliberately.
create or replace function public.strip_anon_execute_on_new_functions()
returns event_trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
  r record;
  -- anon needs this one: it backs five RLS policies with roles={public}, and the public
  -- /join/[groupId] page reads those tables unauthenticated. Without EXECUTE those reads error
  -- instead of returning nothing.
  keep_for_anon text[] := array['is_group_member'];
begin
  for r in
    select objid, schema_name
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
      and schema_name = 'public'
  loop
    execute format('revoke execute on function %s from public', r.objid::regprocedure);

    if not (select proname from pg_proc where oid = r.objid) = any (keep_for_anon) then
      execute format('revoke execute on function %s from anon', r.objid::regprocedure);
    end if;
  end loop;
end $fn$;

-- This one has to revoke itself. It is created before the trigger exists, so it picks up the very
-- PUBLIC EXECUTE grant it was written to remove.
revoke execute on function public.strip_anon_execute_on_new_functions() from public, anon, authenticated;

drop event trigger if exists strip_anon_execute;
create event trigger strip_anon_execute
  on ddl_command_end
  when tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
  execute function public.strip_anon_execute_on_new_functions();

-- ── verification ────────────────────────────────────────────────────────────
-- aclexplode rather than string matching. A LIKE over the whole ACL text matches privileges
-- belonging to a different role further along the string.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no TRUNCATE/TRIGGER/REFERENCES for anon or authenticated' as check_name,
  coalesce(string_agg(distinct table_name, ', '), 'none') as detail
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');

select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'postgres default ACL no longer grants anon TRUNCATE on new tables' as check_name,
  coalesce(string_agg(a.privilege_type, ', '), 'none') as detail
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace,
     aclexplode(d.defaclacl) a
where n.nspname = 'public'
  and d.defaclobjtype = 'r'
  and pg_get_userbyid(d.defaclrole) = 'postgres'
  and a.grantee = 'anon'::regrole
  and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');

select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as result,
  'event trigger installed' as check_name,
  coalesce(string_agg(evtname || ' (' || case when evtenabled = 'D' then 'disabled' else 'enabled' end || ')', ', '), 'missing') as detail
from pg_event_trigger
where evtname = 'strip_anon_execute';

select
  case when count(*) >= 30 then 'PASS' else 'FAIL' end as result,
  'authenticated still holds SELECT, DML left alone' as check_name,
  count(*)::text || ' tables' as detail
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'SELECT';

select
  case when has_function_privilege('anon', 'public.is_group_member(uuid)', 'EXECUTE')
       then 'PASS' else 'FAIL' end as result,
  'is_group_member still callable by anon' as check_name,
  'required by five RLS policies' as detail;

-- is_group_member should be the only one left.
select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as result,
  'exactly one anon-callable function' as check_name,
  string_agg(p.proname, ', ' order by p.proname) as detail
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and has_function_privilege('anon', p.oid, 'EXECUTE');
