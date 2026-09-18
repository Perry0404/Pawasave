-- Explain the negative variance on the one flagged wallet.
--
-- Negative variance means the wallet holds less than its recorded credits, so it is
-- not a forgery signal. Two candidate causes:
--   1. Value left the wallet into locks, goals, holdings or loans without a matching
--      debit row in transactions, which the reconciliation query does not model.
--   2. Migration 027 multiplied historical transactions.amount_usdc_micro by 1600
--      during the cNGN redenomination, so pre-migration credits are overstated.
--
-- Change the email below to re-point this at any account.
--
-- Read-only, single result set.

with target as (
  select id, email from auth.users
  where email = 'supportatcasewinai@gmail.com'
),

-- Credits per month. A 1600x redenomination artefact shows up as one or two months
-- with sums wildly out of line with the rest. Kept as a CTE so the month is a named
-- column rather than a GROUP BY ordinal inside a UNION branch.
credits_by_month as (
  select
    to_char(date_trunc('month', t.created_at), 'YYYY-MM') as era,
    sum(coalesce(t.amount_usdc_micro, 0))                 as credit_micro,
    count(*)                                              as credit_rows
  from public.transactions t
  join target g on g.id = t.user_id
  where t.direction = 'credit' and t.status = 'completed'
  group by era
),

report as (

  -- Ledger movement grouped by type and direction. A single type dominating the
  -- credit side points at cause 2. Spread across many types points at cause 1.
  select 1 as ord,
    'ledger by type' as section,
    t.type || ' / ' || t.direction as item,
    count(*)::text || ' rows, '
      || round(sum(coalesce(t.amount_usdc_micro, 0)) / 1e6, 2)::text || ' ngn' as value,
    to_char(min(t.created_at), 'DD Mon YY') || ' to ' || to_char(max(t.created_at), 'DD Mon YY') as span
  from public.transactions t
  join target g on g.id = t.user_id
  group by t.type, t.direction

  -- Credits per month, to expose a redenomination artefact without guessing when
  -- migration 027 was actually applied.
  union all
  select 2, 'credits by month', era,
    round(credit_micro / 1e6, 2)::text || ' ngn across ' || credit_rows::text || ' credit rows',
    ''
  from credits_by_month

  -- Value sitting outside the wallet. If these roughly cover the variance, cause 1.
  union all
  select 3, 'value held elsewhere', 'savings_locks (' || status || ')',
    round(sum(coalesce(amount_usdc_micro, 0)) / 1e6, 2)::text || ' ngn across '
      || count(*)::text || ' locks', ''
  from public.savings_locks l join target g on g.id = l.user_id
  group by status

  union all
  select 3, 'value held elsewhere', 'savings_goals (' || status || ')',
    round(sum(coalesce(saved_usdc_micro, 0)) / 1e6, 2)::text || ' ngn across '
      || count(*)::text || ' goals', ''
  from public.savings_goals s join target g on g.id = s.user_id
  group by status

  union all
  select 3, 'value held elsewhere', 'portfolio_holdings ' || symbol,
    round(sum(coalesce(invested_cngn_micro, 0)) / 1e6, 2)::text || ' ngn invested', ''
  from public.portfolio_holdings h join target g on g.id = h.user_id
  group by symbol

  union all
  select 3, 'value held elsewhere', 'loans (' || status || ')',
    count(*)::text || ' loans', ''
  from public.loans ln join target g on g.id = ln.user_id
  group by status

  -- Real on-chain inflow, the only unambiguous source of truth for money arriving.
  union all
  select 4, 'on-chain deposits', 'crypto_deposits',
    round(coalesce(sum(amount_cngn_micro), 0) / 1e6, 2)::text || ' ngn across '
      || count(*)::text || ' deposits', ''
  from public.crypto_deposits d join target g on g.id = d.user_id

  -- Withdrawals, since a real payout is the one way money legitimately leaves.
  union all
  select 5, 'withdrawals', status,
    count(*)::text || ' rows, '
      || round(sum(coalesce(amount_kobo, 0)) / 100, 2)::text || ' ngn', ''
  from public.transactions t
  join target g on g.id = t.user_id
  where t.type = 'withdrawal'
  group by status
)

select section, item, value, span
from report
order by ord, item;
