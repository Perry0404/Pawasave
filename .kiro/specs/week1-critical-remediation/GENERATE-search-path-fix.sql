-- GENERATE-search-path-fix.sql
--
-- Read-only. Emits the ALTER statements that pin search_path on every SECURITY DEFINER
-- function that lacks it. Run this, copy the single text cell, review it, then run that.
--
-- Why this matters. A SECURITY DEFINER function runs as its owner. Without a pinned
-- search_path it resolves unqualified names using the caller's search_path, so a caller who
-- can create objects in a schema earlier on that path can shadow a table or operator the
-- function relies on and have it run against theirs instead. 79 of production's definer
-- functions are in that state.
--
-- Why this is not the rewrite it looked like. Task 21.6 assumed pinning search_path meant
-- recreating each function from recovered source, which would have needed the eight functions
-- whose definitions are not in the repo. It does not. ALTER FUNCTION ... SET search_path
-- attaches the setting without touching the body, verified against Postgres 15: proconfig is
-- set and pg_get_functiondef comes back with the original body intact.
--
-- So this needs no schema dump and no recovered source, which takes the whole thing off the
-- staging critical path. It is still worth rehearsing on staging first.
--
-- public and pg_temp is the standard pairing. pg_temp goes last so a caller cannot shadow
-- anything with a temporary object.

select
  '-- pin search_path on SECURITY DEFINER functions missing it' || chr(10) ||
  '-- generated from production, ' || now()::date || chr(10) ||
  '-- ' || count(*) || ' function(s)' || chr(10) ||
  -- Schema-qualified explicitly. regprocedure omits the schema when it is already visible on
  -- search_path, which would make the output depend on the session running it.
  coalesce(string_agg(
    format('alter function %I.%I(%s) set search_path = public, pg_temp;',
           n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
    chr(10) order by p.proname, pg_get_function_identity_arguments(p.oid)),
    '-- nothing to do')
  as run_this
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and array_to_string(coalesce(p.proconfig, '{}'), ',') not like '%search_path%';

-- What is being changed, for review before running the above.
select
  p.proname                                  as function,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.prosecdef                                as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '(none)') as current_config,
  l.lanname                                  as language
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l  on l.oid = p.prolang
where n.nspname = 'public'
  and p.prosecdef
  and array_to_string(coalesce(p.proconfig, '{}'), ',') not like '%search_path%'
order by p.proname;

-- Run after applying. Should return zero rows.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'definer functions without a pinned search_path' as check_name,
  coalesce(string_agg(p.proname, ', ' order by p.proname), 'none') as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and array_to_string(coalesce(p.proconfig, '{}'), ',') not like '%search_path%';
