-- Task 15, database side. Pair this with the on-chain balances.
--
-- On-chain custody holdings read from Base at 07 Sep 2026, wallet
-- 0xaBc8c660F6d217812D57c22db10c765fC63F4B5d:
--
--   AAPL   0.00765322        MSFT   0
--   NVDA   0.00004920        MSTR   0
--   META   0                 SNDK   0
--   GOOGL  0.00404309        SPCX   0.00428209
--   AMZN   0                 TSLA   0
--
--   USDC   0.368272          cNGN   0 raw, 2516.95 held as psNGN pool shares
--   ETH    0.000608
--
-- Any symbol where the database claims shares and the chain holds none is a
-- P3-H-04 instance: the ledger asserts a position no token backs.
--
-- Read-only.

with holdings as (
  select
    upper(symbol)                     as symbol,
    sum(shares)                       as db_shares,
    sum(invested_cngn_micro)          as db_invested_micro,
    count(distinct user_id)            as holders
  from public.portfolio_holdings
  where shares > 0
  group by upper(symbol)
),

onchain(symbol, chain_shares) as (
  values
    ('AAPL',  0.00765322::numeric),
    ('NVDA',  0.00004920),
    ('META',  0),
    ('GOOGL', 0.00404309),
    ('AMZN',  0),
    ('MSFT',  0),
    ('MSTR',  0),
    ('SNDK',  0),
    ('SPCX',  0.00428209),
    ('TSLA',  0)
)

select
  coalesce(h.symbol, o.symbol)                            as symbol,
  coalesce(h.db_shares, 0)                                as db_shares,
  coalesce(o.chain_shares, 0)                             as chain_shares,
  coalesce(o.chain_shares, 0) - coalesce(h.db_shares, 0)  as chain_minus_db,
  round(coalesce(h.db_invested_micro, 0) / 1e6, 2)        as db_invested_ngn,
  coalesce(h.holders, 0)                                  as holders,
  case
    when coalesce(h.db_shares, 0) > 0 and coalesce(o.chain_shares, 0) = 0
      then 'UNBACKED: db claims shares, chain holds none'
    when coalesce(o.chain_shares, 0) < coalesce(h.db_shares, 0) * 0.99
      then 'SHORT: chain holds less than the db claims'
    when coalesce(h.db_shares, 0) = 0 and coalesce(o.chain_shares, 0) > 0
      then 'ORPHAN: chain holds tokens no db holding claims'
    else 'ok'
  end as verdict
from holdings h
full outer join onchain o on o.symbol = h.symbol
order by
  case
    when coalesce(h.db_shares, 0) > 0 and coalesce(o.chain_shares, 0) = 0 then 0
    when coalesce(o.chain_shares, 0) < coalesce(h.db_shares, 0) * 0.99 then 1
    when coalesce(h.db_shares, 0) = 0 and coalesce(o.chain_shares, 0) > 0 then 2
    else 3
  end,
  symbol;
