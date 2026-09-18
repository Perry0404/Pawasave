-- Follow-up. Two bugs in the earlier forensics hid real state.
--
--   1. RECONCILE-equity-onchain filtered `where shares > 0`, which hid a TSLA
--      holding that has cost basis but zero shares.
--   2. FORENSICS-equity looked for stranded sales with status = 'pending', but
--      sales are using 'settling', so it reported zero stranded when there are two.
--
-- 'settling' is not in the equity_sales status CHECK constraint as read earlier,
-- which only permitted pending, filled and failed. Section 4 below checks whether
-- the constraint changed or whether these rows predate it.
--
-- A sale that reserved shares and sold the tokens but never credited the customer is
-- the P3-H-04 case with real money impact. Read-only.

with

sales_all as (
  select
    s.id, s.status, s.symbol, u.email,
    s.shares,
    coalesce(s.invested_removed_micro, 0) as basis_removed_micro,
    s.usdc_micro,
    s.cngn_gross_micro,
    s.cngn_net_micro,
    s.fee_micro,
    s.broker_ref,
    s.error,
    s.created_at,
    s.updated_at,
    round(extract(epoch from (now() - s.created_at)) / 60)::bigint as age_minutes
  from public.equity_sales s
  join auth.users u on u.id = s.user_id
),

-- Holdings with a cost basis but no shares. These are what the earlier filter hid.
zero_share_holdings as (
  select u.email, h.symbol, h.shares, h.invested_cngn_micro, h.updated_at
  from public.portfolio_holdings h
  join auth.users u on u.id = h.user_id
  where coalesce(h.shares, 0) = 0
    and coalesce(h.invested_cngn_micro, 0) > 0
),

report as (

  select 1 as ord, '1. VERDICT' as section,
    case
      when (select count(*) from sales_all where status not in ('filled', 'failed')) > 0
        then 'ACTION NEEDED: sales are stuck in a non-terminal state. Shares removed, customer possibly not credited.'
      else 'All sales are in a terminal state.'
    end as item, '' as value

  -- Every sale, so nothing is hidden by a status assumption this time.
  union all
  select 2, '2. All sales',
    id::text || '  ' || email || '  ' || symbol || '  [' || status || ']',
    'shares ' || shares::text
      || ', basis removed ' || round(basis_removed_micro / 1e6, 2)::text || ' ngn'
      || ', usdc ' || coalesce(round(usdc_micro / 1e6, 2)::text, 'null')
      || ', gross ' || coalesce(round(cngn_gross_micro / 1e6, 2)::text, 'null')
      || ', net credited ' || coalesce(round(cngn_net_micro / 1e6, 2)::text, 'null')
      || ', age ' || age_minutes::text || ' min'
  from sales_all

  -- Errors recorded on the failed and stuck ones, this is the why.
  union all
  select 3, '3. Sale errors', id::text || '  ' || symbol || '  [' || status || ']',
    coalesce(left(error, 220), '(no error recorded)')
  from sales_all
  where error is not null or status not in ('filled', 'failed')

  -- Did the status constraint change, or are these rows illegal?
  union all
  select 4, '4. Status constraint', con.conname,
    pg_get_constraintdef(con.oid)
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  where c.relname = 'equity_sales' and con.contype = 'c'

  -- Holdings with basis but no shares, hidden by the earlier shares > 0 filter.
  union all
  select 5, '5. Basis without shares', email || '  ' || symbol,
    round(invested_cngn_micro / 1e6, 2)::text || ' ngn basis, '
      || shares::text || ' shares, last touched '
      || to_char(updated_at, 'DD Mon HH24:MI')
  from zero_share_holdings

  -- Was the customer credited for the stuck sales? Look for the matching ledger row.
  union all
  select 6, '6. Ledger rows for sales', t.reference,
    t.type || ' / ' || t.direction || ', '
      || round(coalesce(t.amount_usdc_micro, 0) / 1e6, 2)::text || ' ngn, '
      || t.status || ', ' || to_char(t.created_at, 'DD Mon HH24:MI')
  from public.transactions t
  where t.type = 'equity_sell'
)

select section, item, value
from report
order by ord, item;
