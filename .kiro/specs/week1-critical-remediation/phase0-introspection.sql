-- Phase 0 introspection. One block, one result set.
--
-- Run the whole file in the Supabase SQL Editor and hand back the result. Read-only.
--
-- Uses has_*_privilege() rather than information_schema grant tables on purpose.
-- Postgres grants EXECUTE to PUBLIC by default and those implicit grants do not appear
-- as explicit rows, so the grant tables would report almost nothing and we would wrongly
-- conclude the functions are locked down. has_*_privilege() reports what a role can
-- actually do.
--
-- Deliberately EXCLUDES full function bodies. All 88 definitions are far too large to
-- move around, and the allow-list only needs signature, security mode, search_path and
-- effective grants. Export the bodies separately when building the baseline migration:
--
--   select p.proname, pg_get_functiondef(p.oid)
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' order by p.proname;

with

tbl as (
  select
    c.relname::text            as name,
    c.relrowsecurity           as rls,
    c.relforcerowsecurity      as forced,
    (select count(*) from pg_policies p
      where p.schemaname = 'public' and p.tablename = c.relname) as policies,
    has_table_privilege('anon',          'public.'||c.relname, 'SELECT') as anon_sel,
    has_table_privilege('anon',          'public.'||c.relname, 'UPDATE') as anon_upd,
    has_table_privilege('anon',          'public.'||c.relname, 'INSERT') as anon_ins,
    has_table_privilege('anon',          'public.'||c.relname, 'DELETE') as anon_del,
    has_table_privilege('authenticated', 'public.'||c.relname, 'UPDATE') as auth_upd
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),

fn as (
  select
    p.proname::text                                   as name,
    pg_get_function_identity_arguments(p.oid)         as args,
    p.prosecdef                                       as definer,
    (p.proconfig is not null and exists (
      select 1 from unnest(p.proconfig) c where c like 'search_path=%')) as has_sp,
    has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_x,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
    has_function_privilege('service_role',  p.oid, 'EXECUTE') as svc_x
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),

vw as (
  select
    c.relname::text as name,
    coalesce(array_to_string(c.reloptions, ',') like '%security_invoker=true%', false) as invoker,
    has_table_privilege('anon', 'public.'||c.relname, 'SELECT') as anon_sel
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v','m')
),

neg as (
  select 'wallets.usdc_balance_micro' as col, count(*) as n from public.wallets where usdc_balance_micro < 0
  union all select 'wallets.naira_balance_kobo', count(*) from public.wallets where naira_balance_kobo < 0
  union all select 'wallets.cngn_pool_micro',    count(*) from public.wallets where cngn_pool_micro < 0
  union all select 'esusu_groups.pot_balance_kobo', count(*) from public.esusu_groups where pot_balance_kobo < 0
),

dupe_ref as (
  select count(*) as n from (
    select reference from public.transactions
    where reference is not null group by reference having count(*) > 1
  ) d
),

report as (

  -- 1. Headline counts and anything that needs a decision
  select 1 as ord, '1. SUMMARY' as section, 'tables' as item,
    (select count(*)::text from tbl) || ' total, '
      || (select count(*)::text from tbl where rls) || ' with RLS, '
      || (select count(*)::text from tbl where not rls) || ' WITHOUT RLS' as value
  union all select 1, '1. SUMMARY', 'tables without RLS',
    coalesce((select string_agg(name, ', ' order by name) from tbl where not rls), 'none')
  union all select 1, '1. SUMMARY', 'client-writable balance tables',
    coalesce((select string_agg(name, ', ' order by name) from tbl
              where auth_upd and name in ('wallets','profiles','savings_locks')), 'none')
  union all select 1, '1. SUMMARY', 'functions',
    (select count(*)::text from fn) || ' total, '
      || (select count(*)::text from fn where definer) || ' SECURITY DEFINER, '
      || (select count(*)::text from fn where not has_sp) || ' without search_path'
  union all select 1, '1. SUMMARY', 'functions callable by a browser',
    (select count(*)::text from fn where anon_x or auth_x) || ' of '
      || (select count(*)::text from fn) || ' reachable by anon or authenticated'
  union all select 1, '1. SUMMARY', 'views bypassing RLS',
    (select count(*)::text from vw where not invoker) || ' of '
      || (select count(*)::text from vw) || ' lack security_invoker'
  union all select 1, '1. SUMMARY', 'negative balances',
    coalesce((select string_agg(col || '=' || n::text, ', ' order by col) from neg where n > 0),
             'none, non-negativity constraints will apply cleanly')
  union all select 1, '1. SUMMARY', 'duplicate transaction references',
    (select n::text from dupe_ref) || ' references appear more than once'

  -- 2. Tables: RLS state and what a client can actually do
  union all
  select 2, '2. Tables', name,
    'rls=' || case when rls then 'on' else 'OFF' end
      || case when forced then ' forced' else '' end
      || ', policies=' || policies::text
      || ', anon[' || case when anon_sel then 's' else '-' end
                   || case when anon_upd then 'u' else '-' end
                   || case when anon_ins then 'i' else '-' end
                   || case when anon_del then 'd' else '-' end || ']'
      || ', auth_update=' || case when auth_upd then 'yes' else 'no' end
  from tbl

  -- 3. Every policy verbatim. with_check null on UPDATE means it defaults to using.
  union all
  select 3, '3. Policies', tablename::text || ' :: ' || cmd || ' :: ' || policyname::text,
    'using=' || coalesce(qual, '(none)') || '  check=' || coalesce(with_check, '(none)')
  from pg_policies where schemaname = 'public'

  -- 4. Functions. This is the input to the allow-list.
  union all
  select 4, '4. Functions', name || '(' || args || ')',
    case when definer then 'DEFINER' else 'invoker' end
      || case when has_sp then ' +search_path' else ' NO-search_path' end
      || ' | anon=' || case when anon_x then 'Y' else 'n' end
      || ' auth='  || case when auth_x then 'Y' else 'n' end
      || ' svc='   || case when svc_x  then 'Y' else 'n' end
  from fn

  -- 5. Views
  union all
  select 5, '5. Views', name,
    case when invoker then 'security_invoker=true' else 'RUNS AS OWNER, bypasses RLS' end
      || ', anon_select=' || case when anon_sel then 'yes' else 'no' end
  from vw

  -- 6. Triggers, confirms the PIN guard is live and shows anything else
  union all
  select 6, '6. Triggers', c.relname::text || ' :: ' || t.tgname::text,
    pg_get_triggerdef(t.oid)
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal

  -- 7. Checks and uniques, so we know what already exists before adding more
  union all
  select 7, '7. Constraints', c.relname::text || ' :: ' || con.conname::text,
    pg_get_constraintdef(con.oid)
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and con.contype in ('c','u')

  -- 8. Anything in production the repo may never have seen
  union all
  select 8, '8. Environment', 'extension ' || extname::text, extversion::text
  from pg_extension
  union all
  select 8, '8. Environment', 'schema ' || n.nspname::text, count(*)::text || ' objects'
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog','information_schema','pg_toast')
  group by n.nspname
)

select section, item, value
from report
order by ord, item;
