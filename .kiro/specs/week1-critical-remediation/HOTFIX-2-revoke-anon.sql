-- HOTFIX-2-revoke-anon.sql
--
-- Run after HOTFIX-revoke-service-only-rpcs.sql. Closes the rest of the anonymous surface.
--
-- The first hotfix took 25 functions away from clients entirely. 44 remain reachable, and
-- the ones the app genuinely calls are still reachable by `anon`, which is the same defect
-- in a quieter form. They take p_user_id as a parameter and guard with
--
--   IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE
--
-- so an anonymous caller skips the check and names any victim. Without logging in:
--   create_loan             open a loan against any account
--   withdraw_vault_atomic   move a victim's vault balance into their spendable wallet
--   save_to_vault           move it back, repeatedly
--   lock_savings            lock a victim's balance for a chosen duration
--   record_lock_forfeiture  record an arbitrary interest forfeiture
--   place_equity_order      spend a victim's balance on stock
--   contribute_to_goal      move a victim's money between buckets
--
-- Group A loses client access completely. Group B keeps `authenticated`, because the app
-- calls it from a signed-in browser or a user-session route, and loses `anon`.
--
-- Checked before writing this:
--   the join page redirects to auth before calling join_esusu_group, so it is never anon
--   get_apy_settings falls back to hardcoded defaults, so losing anon degrades gracefully
--   is_group_member is deliberately untouched. It looks like an RLS helper, and a policy
--   that calls it needs the caller to hold EXECUTE. Section 4 reports where it is used so
--   it can be handled with evidence rather than assumption.
--
-- PUBLIC is revoked too, and `authenticated` is then granted back explicitly. Without that
-- second step Group B would lose access, because these functions were reachable through the
-- default PUBLIC grant rather than a role-specific one.
--
-- Idempotent. Verification at the bottom.

-- ── Group A: no client access at all ─────────────────────────────────────────
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = any (array[
        -- internal helpers, only ever called from other functions, which are DEFINER and
        -- so do not need the caller to hold EXECUTE
        '_loan_equity_value', '_loan_setting', 'calculate_lock_interest',
        'get_fixed_savings_rate',
        -- trigger functions. PostgreSQL does not check EXECUTE when firing a trigger
        'handle_new_user', 'protect_transaction_pin', 'rls_auto_enable',
        -- no call site anywhere in the app
        'readd_esusu_member', 'set_transaction_deposit_address',
        -- platform revenue and user counts. The admin dashboard route reads these through
        -- the service role, the browser calls are the dead ones task 20 deletes
        'admin_fee_summary', 'admin_recent_fees', 'admin_tx_volume', 'admin_user_stats'
      ])
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('revoke all on function %s from anon', r.sig);
    execute format('revoke all on function %s from authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    n := n + 1;
  end loop;
  raise notice 'group A, no client access: % function(s)', n;
end
$$;

-- ── Group B: signed-in users only ────────────────────────────────────────────
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = any (array[
        -- savings and goals
        'save_to_vault', 'withdraw_vault_atomic', 'lock_savings', 'withdraw_lock',
        'break_savings_goal', 'complete_savings_goal', 'contribute_to_goal',
        'set_goal_auto_contribute', 'record_lock_forfeiture', 'record_goal_forfeiture',
        -- esusu and ajo
        'esusu_contribute', 'esusu_contribute_crypto', 'join_esusu_group',
        'process_esusu_payout', 'cast_emergency_vote', 'request_emergency_payout',
        'create_ajo_invite',
        -- proxy and pool
        'proxy_transfer', 'register_proxy_member', 'get_proxy_transfers',
        'get_proxy_member_for_user', 'allocate_cngn_pool',
        -- loans
        'create_loan', 'repay_loan', 'loan_borrow_limit',
        -- equity
        'place_equity_order', 'place_equity_sell', 'place_getequity_order',
        -- read-only settings
        'get_apy_settings'
      ])
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('revoke all on function %s from anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    n := n + 1;
  end loop;
  raise notice 'group B, signed-in only: % function(s)', n;
end
$$;

-- ─────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────

-- 1. Nothing in either group may still be callable without logging in.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'anon still reachable in either group' as check_name,
  coalesce(string_agg(distinct p.proname, ', '), 'none') as detail
from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public'
  and has_function_privilege('anon', p.oid, 'execute')
  and p.proname <> 'is_group_member';

-- 2. Group B must still work for a signed-in user, or savings, loans and equity break.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'group B lost authenticated' as check_name,
  coalesce(string_agg(p.proname, ', ' order by p.proname), 'none') as detail
from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public'
  and p.proname = any (array[
    'save_to_vault', 'withdraw_vault_atomic', 'lock_savings', 'withdraw_lock',
    'break_savings_goal', 'complete_savings_goal', 'contribute_to_goal',
    'set_goal_auto_contribute', 'esusu_contribute', 'join_esusu_group',
    'create_loan', 'repay_loan', 'loan_borrow_limit',
    'place_equity_order', 'place_equity_sell', 'place_getequity_order', 'get_apy_settings'
  ])
  and not has_function_privilege('authenticated', p.oid, 'execute');

-- 3. service_role must not have lost anything.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'service_role lost access' as check_name,
  coalesce(string_agg(p.proname, ', ' order by p.proname), 'none') as detail
from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public' and p.prokind = 'f'
  and p.proname not like 'pg_%'
  and not has_function_privilege('service_role', p.oid, 'execute');

-- 4. Where is_group_member is actually used, so it can be decided on evidence.
select 'is_group_member usage' as section,
       pol.schemaname, pol.tablename, pol.policyname, pol.roles::text,
       coalesce(pol.qual, pol.with_check) as expression
from pg_policies pol
where coalesce(pol.qual, '') || coalesce(pol.with_check, '') like '%is_group_member%';

select 'is_group_member grants' as section,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public' and p.proname = 'is_group_member';

-- 5. Final exposure count.
select
  count(*)                                                                          as total_functions,
  count(*) filter (where has_function_privilege('anon', p.oid, 'execute'))          as reachable_by_anon,
  count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) as reachable_by_users
from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public' and p.prokind = 'f';

-- 6. The full remaining client surface, for the record.
select p.proname as reachable_by_signed_in_users,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public' and p.prokind = 'f'
  and has_function_privilege('authenticated', p.oid, 'execute')
order by p.proname;
