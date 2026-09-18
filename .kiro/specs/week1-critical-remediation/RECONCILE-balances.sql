-- Was the open wallets table used to forge a balance?
--
-- wallets was readable and writable by anyone holding the public anon key for an
-- unknown period. A forged balance looks like an ordinary large number, so the only
-- way to find one is to check every balance against what the ledger can explain.
--
-- Conservation we expect per user:
--     credits - debits = currently held
--
-- A large POSITIVE variance means the wallet holds more than it was ever credited.
-- That is the forgery signal.
--
-- A NEGATIVE variance is usually benign. Some flows debit the wallet without writing
-- a transactions row until they settle, pending equity orders being the main one, so
-- the pending column below explains most of it.
--
-- Read-only. Single result set, one row per wallet, worst variance first.

with tx as (
  select
    user_id,
    sum(coalesce(amount_usdc_micro, 0)) filter (where direction = 'credit' and status = 'completed') as credits,
    sum(coalesce(amount_usdc_micro, 0)) filter (where direction = 'debit'  and status = 'completed') as debits,
    count(*)                                                                                        as tx_count,
    count(*) filter (where status = 'completed')                                                    as tx_completed,
    max(created_at)                                                                                 as last_tx
  from public.transactions
  group by user_id
),

-- On-chain deposits are already mirrored into transactions by credit_crypto_deposit.
-- Carried here only to show whether a balance has a real on-chain origin.
dep as (
  select user_id, sum(amount_cngn_micro) as onchain_in, count(*) as onchain_count
  from public.crypto_deposits
  group by user_id
),

-- Money the wallet was debited for but which has not settled, so it has no ledger row yet.
pending as (
  select user_id, sum(amount_cngn_micro) as pending_micro
  from public.equity_orders
  where status = 'pending'
  group by user_id
),

recon as (
  select
    u.email,
    w.user_id,
    w.updated_at                                            as wallet_updated,
    coalesce(t.last_tx, null)                               as last_tx,
    coalesce(t.tx_completed, 0)                             as tx_rows,
    coalesce(d.onchain_count, 0)                            as onchain_deposits,

    w.usdc_balance_micro                                    as spendable_micro,
    coalesce(w.cngn_pool_micro, 0)                          as pool_micro,
    w.usdc_balance_micro + coalesce(w.cngn_pool_micro, 0)   as held_micro,

    coalesce(t.credits, 0)                                  as credits_micro,
    coalesce(t.debits, 0)                                   as debits_micro,
    coalesce(t.credits, 0) - coalesce(t.debits, 0)           as expected_micro,
    coalesce(p.pending_micro, 0)                            as pending_micro,

    (w.usdc_balance_micro + coalesce(w.cngn_pool_micro, 0))
      - (coalesce(t.credits, 0) - coalesce(t.debits, 0))    as variance_micro
  from public.wallets w
  join auth.users u        on u.id = w.user_id
  left join tx t           on t.user_id = w.user_id
  left join dep d          on d.user_id = w.user_id
  left join pending p      on p.user_id = w.user_id
)

select
  email,
  round(held_micro     / 1e6, 2) as held_ngn,
  round(expected_micro / 1e6, 2) as ledger_explains_ngn,
  round(variance_micro / 1e6, 2) as variance_ngn,
  round(pending_micro  / 1e6, 2) as unsettled_ngn,
  tx_rows,
  onchain_deposits,
  case
    -- Holds money with nothing in the ledger at all. Strongest signal.
    when held_micro > 1000000 and tx_rows = 0
      then 'INVESTIGATE: balance with no ledger rows'

    -- Holds materially more than it was ever credited. Over 1000 naira of slack.
    when variance_micro > 1000000000
      then 'INVESTIGATE: holds far more than credited'
    when variance_micro > 1000000
      then 'REVIEW: holds more than credited'

    -- Debited without a ledger row, and not explained by an unsettled order.
    when variance_micro < -1000000 and (variance_micro + pending_micro) < -1000000
      then 'REVIEW: debited without a ledger row'

    -- Wallet changed well after its last ledger entry. A direct PATCH would not
    -- have written a transactions row, so this is a secondary signal.
    when last_tx is not null and wallet_updated > last_tx + interval '1 day' and variance_micro <> 0
      then 'REVIEW: wallet changed after last ledger entry'

    else 'ok'
  end as verdict
from recon
order by variance_micro desc, held_micro desc;
