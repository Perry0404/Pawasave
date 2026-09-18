-- PROBE-credit-wallet-grant.sql
--
-- Read-only. Confirms whether a logged-in user can call the value-creating functions
-- directly. Run this before anything else today.
--
-- Why it matters: credit_wallet's only authorization is
--   IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE
-- which blocks crediting someone else and permits crediting yourself. If the execute
-- grant to `authenticated` is present, any registered user can call it from the browser
-- with their own id and an arbitrary amount.

select
  p.proname                                                as function,
  has_function_privilege('anon',          p.oid, 'execute') as anon_can_call,
  has_function_privilege('authenticated', p.oid, 'execute') as user_can_call,
  case
    when has_function_privilege('authenticated', p.oid, 'execute')
      or has_function_privilege('anon', p.oid, 'execute')
    then 'EXPLOITABLE FROM THE BROWSER'
    else 'not client callable'
  end                                                      as verdict,
  pg_get_function_identity_arguments(p.oid)                as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'credit_wallet', 'debit_wallet', 'withdraw_cngn_pool',
    'credit_crypto_deposit', 'credit_strails_deposit', 'process_proxy_deposit',
    'distribute_vault_yield', 'allocate_cngn_pool', 'finalize_kyc',
    'settle_equity_order', 'settle_equity_sell', 'settle_getequity_order',
    'mark_equity_sell_settling', 'mark_equity_buy_settling',
    'record_custody_divergence', 'record_platform_fee', 'set_deposit_address'
  )
order by user_can_call desc, anon_can_call desc, p.proname;

-- How wide the problem is overall.
select
  count(*)                                                                          as total_functions,
  count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) as callable_by_users,
  count(*) filter (where has_function_privilege('anon', p.oid, 'execute'))          as callable_by_anon,
  count(*) filter (where p.prosecdef)                                               as security_definer,
  count(*) filter (where p.prosecdef
                     and array_to_string(coalesce(p.proconfig, '{}'), ',') not like '%search_path%')
                                                                                    as definer_without_search_path
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f';

-- Has it already been used? A credit with no matching provider reference is the signature.
-- Adjust the window if you want to look further back.
select
  'unexplained credits' as check,
  t.id, t.user_id, t.type, t.amount_kobo, t.reference, t.status, t.created_at
from public.transactions t
where t.direction = 'credit'
  and t.created_at > now() - interval '90 days'
  and t.type not in ('deposit', 'vault_withdraw', 'goal_claim', 'esusu_payout',
                     'equity_sell', 'emergency_payout', 'loan_disbursement')
order by t.created_at desc
limit 50;

-- Wallet balances that no ledger sum explains. A direct credit_wallet call moves the
-- balance without writing a transactions row at all, so this is the sharper test.
with ledger as (
  select user_id,
         sum(case when direction = 'credit' then amount_usdc_micro else -amount_usdc_micro end) as net_micro
  from public.transactions
  where status = 'completed'
  group by user_id
)
select
  'balance vs ledger' as check,
  w.user_id,
  w.usdc_balance_micro                             as wallet_micro,
  coalesce(l.net_micro, 0)                         as ledger_net_micro,
  w.usdc_balance_micro - coalesce(l.net_micro, 0)  as unexplained_micro
from public.wallets w
left join ledger l on l.user_id = w.user_id
where w.usdc_balance_micro <> 0
   or coalesce(l.net_micro, 0) <> 0
order by abs(w.usdc_balance_micro - coalesce(l.net_micro, 0)) desc
limit 30;
