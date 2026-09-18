-- 081_amount_integrity_constraints.sql  (run after 080)
--
-- Closes a bypass of the 3,000,000 naira daily withdrawal cap.
--
-- enforceWithdrawalKycCap sums amount_kobo from transactions for the last 24 hours and compares
-- it to the cap. transactions still carries "Users insert own txs" with
-- check (auth.uid() = user_id), because hooks/use-data.ts writes ledger rows from the browser,
-- and nothing constrained the sign of the amount. So a signed-in user could insert
--
--   type 'withdrawal', status 'completed', amount_kobo -500000000000
--
-- which makes the daily total -5,000,000,000 naira and lets them withdraw about 5 billion in a
-- single request without tripping the cap. Verified on staging: the insert succeeded and the sum
-- the app computes came back negative.
--
-- Two independent fixes here, because the client can still write the table until those six
-- browser inserts move server-side:
--   amounts cannot be negative, so the sum cannot be poisoned downward
--   references must be unique, so a replayed provider reference cannot double-credit
--
-- The application also gets a hard ceiling evaluated before any of this and reading only env,
-- so a cap bypass needs both layers to fail.
--
-- Pre-checked against production before writing: 0 negative wallet balances, 0 negative
-- transaction amounts, 0 duplicate references. Nothing here will fail on existing rows.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

-- ── transactions: amounts are magnitudes, direction carries the sign ────────
alter table public.transactions drop constraint if exists transactions_amount_kobo_nonneg;
alter table public.transactions add constraint transactions_amount_kobo_nonneg
  check (amount_kobo is null or amount_kobo >= 0);

alter table public.transactions drop constraint if exists transactions_amount_usdc_nonneg;
alter table public.transactions add constraint transactions_amount_usdc_nonneg
  check (amount_usdc_micro is null or amount_usdc_micro >= 0);

-- ── transactions.reference is the provider idempotency key ──────────────────
-- credit_strails_deposit and the off-ramp both look a reference up to decide whether they have
-- already processed it. Without uniqueness that check is advisory: two concurrent webhooks can
-- both miss and both credit. NULLs stay allowed, and a unique index permits many of them.
create unique index if not exists transactions_reference_uniq
  on public.transactions (reference)
  where reference is not null;

-- ── balances cannot go negative ─────────────────────────────────────────────
alter table public.wallets drop constraint if exists wallets_balances_nonneg;
alter table public.wallets add constraint wallets_balances_nonneg
  check (
    coalesce(usdc_balance_micro, 0) >= 0
    and coalesce(naira_balance_kobo, 0) >= 0
    and coalesce(cngn_pool_micro, 0) >= 0
  );

-- ── the same for the other value-bearing tables ─────────────────────────────
alter table public.savings_locks drop constraint if exists savings_locks_amounts_nonneg;
alter table public.savings_locks add constraint savings_locks_amounts_nonneg
  check (
    amount_usdc_micro >= 0
    and coalesce(projected_interest_micro, 0) >= 0
    and coalesce(accrued_yield_micro, 0) >= 0
    and coalesce(interest_forfeited_usdc_micro, 0) >= 0
  );

alter table public.savings_goals drop constraint if exists savings_goals_amounts_nonneg;
alter table public.savings_goals add constraint savings_goals_amounts_nonneg
  check (
    coalesce(saved_usdc_micro, 0) >= 0
    and coalesce(saved_naira_kobo, 0) >= 0
    and coalesce(interest_earned_micro, 0) >= 0
    and coalesce(interest_forfeited_usdc_micro, 0) >= 0
  );

alter table public.portfolio_holdings drop constraint if exists portfolio_holdings_nonneg;
alter table public.portfolio_holdings add constraint portfolio_holdings_nonneg
  check (coalesce(invested_cngn_micro, 0) >= 0 and coalesce(shares, 0) >= 0);

-- ── verification ────────────────────────────────────────────────────────────
select
  case when count(*) = 6 then 'PASS' else 'FAIL' end as result,
  'non-negativity constraints present' as check_name,
  count(*)::text || ' of 6' as detail
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and c.conname in ('transactions_amount_kobo_nonneg', 'transactions_amount_usdc_nonneg',
                    'wallets_balances_nonneg', 'savings_locks_amounts_nonneg',
                    'savings_goals_amounts_nonneg', 'portfolio_holdings_nonneg');

select
  case when count(*) = 1 then 'PASS' else 'FAIL' end as result,
  'unique index on transactions.reference' as check_name,
  coalesce(string_agg(indexname, ', '), 'missing') as detail
from pg_indexes
where schemaname = 'public' and indexname = 'transactions_reference_uniq';
