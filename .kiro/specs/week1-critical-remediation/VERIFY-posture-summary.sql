-- VERIFY-posture-summary.sql
--
-- Read-only. Run on BOTH production and staging and compare the two rows.
--
-- Every number must match. If staging is more locked down than production the adversarial
-- tests pass for the wrong reason, which is the failure mode that makes the whole staging
-- exercise worthless, so a difference in either direction is a problem.

select
  '5. posture summary' as section,
  (select count(*) from pg_tables where schemaname = 'public')                            as tables,
  (select count(*) from pg_tables where schemaname = 'public' and rowsecurity)            as tables_rls_on,
  (select count(*) from pg_policies where schemaname = 'public')                          as policies,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f')                                       as functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'execute'))                               as fn_anon,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and has_function_privilege('authenticated', p.oid, 'execute'))                      as fn_authenticated,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef)                                           as security_definer,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') not like '%search_path%')      as definer_no_search_path,
  (select count(*) from pg_views where schemaname = 'public')                             as views;
