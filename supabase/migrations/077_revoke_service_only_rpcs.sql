-- 077_revoke_service_only_rpcs.sql  (run after 076)
--
-- Closes remote, unauthenticated write access to customer balances.
--
-- Applied to production out of band on 09 Sep 2026 as
-- HOTFIX-revoke-service-only-rpcs.sql, which carries the verification queries.
--
-- What the probe found. 69 of 97 public functions are executable by `anon` as well as
-- `authenticated`. The anon key is published in the client bundle by design, so `anon` means
-- anybody on the internet. The functions authorize like this:
--
--   IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE
--
-- For an anonymous caller auth.uid() is NULL, so the condition is false and the check never
-- fires. The parameter is then trusted. Consequences with no login at all:
--   credit_wallet          credit any wallet any amount
--   debit_wallet           zero out any customer's balance
--   withdraw_cngn_pool     move any customer's pool balance
--   credit_crypto_deposit  fabricate a deposit against any account
--   credit_strails_deposit fabricate a deposit against any account
--   process_proxy_deposit  fabricate a deposit against any account
--   distribute_vault_yield mint yield across every vault position
--   finalize_kyc           mark any account KYC verified, which is the AML control and the
--                          gate on the 3,000,000 withdrawal tier
--   set_deposit_address    repoint a customer's deposit address and capture their deposits
--   settle_equity_sell     settle sales at chosen amounts
--
-- No evidence it has been used: unexplained credits returned zero rows, and no wallet holds
-- more than its ledger explains.
--
-- Why this is safe to apply immediately. Every function here is called only through a
-- service-role client, proven by scanning all 74 call sites in the app
-- (derive-rpc-allowlist.py). The five that were still on a user session, credit_wallet,
-- debit_wallet, withdraw_cngn_pool, record_platform_fee and set_deposit_address, moved to
-- the service role in commit aaddcde, which is already deployed. service_role bypasses
-- these grants, so nothing legitimate loses access.
--
-- NOT in scope here, deliberately:
--   allocate_cngn_pool  still called from the browser in hooks/use-data.ts. It needs the
--                       server route from task 17 first, so revoking it now breaks a feature.
--   the remaining exposed functions and the client-callable allow-list, which belong to the
--   full authorization migration and want staging first.
--
-- Uses regprocedure so overloads are handled and no signature is typed by hand.
-- Idempotent. Run in the Supabase SQL editor.

do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = any (array[
        -- balances and deposits
        'credit_wallet', 'debit_wallet', 'withdraw_cngn_pool',
        'credit_crypto_deposit', 'credit_strails_deposit', 'process_proxy_deposit',
        'distribute_vault_yield', 'record_platform_fee', 'set_deposit_address',
        -- identity and compliance
        'finalize_kyc', 'set_strails_onboarding',
        -- equity settlement
        'settle_equity_order', 'settle_equity_sell', 'settle_getequity_order',
        'mark_equity_sell_settling', 'mark_equity_buy_settling',
        'bump_equity_sell_attempt', 'bump_equity_buy_attempt',
        -- yield, loans, cron internals
        'accrue_daily_yield', 'accrue_loan_interest', 'auto_contribute_goals',
        'liquidate_overdue_loans', 'reconcile_stale_transactions', 'set_yield_state',
        'get_pending_lend_supplies', 'mark_lend_supply_done', 'mark_lend_supply_failed',
        -- esusu and ajo internals
        'esusu_autodebit', 'esusu_claim_mm_position', 'esusu_record_mm_deposit',
        'claim_ajo_invite',
        -- proxy
        'get_user_for_proxy_member',
        -- admin session and pin lockout
        'admin_login_locked', 'admin_login_record',
        'pin_lock_status', 'record_pin_attempt',
        -- custody lease and divergence
        'try_acquire_lease', 'refresh_lease', 'release_lease', 'lease_status',
        'record_custody_divergence', 'resolve_custody_divergence'
      ])
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('revoke all on function %s from anon', r.sig);
    execute format('revoke all on function %s from authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    n := n + 1;
  end loop;
  raise notice 'locked down % function(s)', n;
end
$$;
