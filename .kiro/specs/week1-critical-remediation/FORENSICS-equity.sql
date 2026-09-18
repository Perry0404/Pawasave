-- Equity forensics. Tasks 13 and 14.
--
-- Three findings became Critical once the feature was confirmed live in production:
--   P3-H-01  concurrent orders measure a shared wallet balance delta, so one order
--            can be credited with another order's output
--   P3-H-03  the buy runs in a fire-and-forget background task with no reconciler,
--            so a process death leaves a customer debited with nothing
--   P3-H-04  if leg 1 succeeds and leg 2 fails the refund is booked in the database
--            while the cNGN is already gone, so the ledger claims money we do not hold
--
-- This asks whether any of that has already happened.
--
-- Read-only. Single result set, most urgent first.

with

-- Orders and sales stuck past the point where they should have settled. An order
-- takes 1 to 2 minutes, so anything over 15 is stranded rather than in flight.
stranded_orders as (
  select
    o.id, o.user_id, u.email, o.symbol,
    o.amount_cngn_micro,
    o.created_at,
    round(extract(epoch from (now() - o.created_at)) / 60)::bigint as stuck_minutes
  from public.equity_orders o
  join auth.users u on u.id = o.user_id
  where o.status = 'pending'
    and o.created_at < now() - interval '15 minutes'
),
stranded_sales as (
  select
    s.id, s.user_id, u.email, s.symbol,
    s.shares, coalesce(s.invested_removed_micro, 0) as basis_removed,
    s.created_at,
    round(extract(epoch from (now() - s.created_at)) / 60)::bigint as stuck_minutes
  from public.equity_sales s
  join auth.users u on u.id = s.user_id
  where s.status = 'pending'
    and s.created_at < now() - interval '15 minutes'
),

-- Implied naira per USDC on each filled buy. Cross-order contamination shows up as
-- an outlier, because an order that captured another order's USDC paid its own cNGN
-- for someone else's output.
buy_rates as (
  select
    o.id, u.email, o.symbol, o.created_at,
    o.amount_cngn_micro, o.usdc_micro,
    round(o.amount_cngn_micro::numeric / nullif(o.usdc_micro, 0), 2) as implied_rate
  from public.equity_orders o
  join auth.users u on u.id = o.user_id
  where o.status = 'filled' and coalesce(o.usdc_micro, 0) > 0
),
rate_stats as (
  select
    percentile_cont(0.5) within group (order by implied_rate) as median_rate,
    min(implied_rate) as min_rate,
    max(implied_rate) as max_rate,
    count(*)          as n
  from buy_rates
),

-- Orders overlapping in time. The buy holds a shared wallet for the whole of leg 1
-- and leg 2, so two orders inside the same window are the contamination condition.
order_overlaps as (
  select
    a.id as id_a, b.id as id_b,
    ua.email as email_a, ub.email as email_b,
    a.symbol as sym_a, b.symbol as sym_b,
    a.created_at as at_a,
    round(extract(epoch from (b.created_at - a.created_at)))::bigint as gap_seconds
  from public.equity_orders a
  join public.equity_orders b
    on b.id > a.id
   and b.created_at between a.created_at and a.created_at + interval '4 minutes'
  join auth.users ua on ua.id = a.user_id
  join auth.users ub on ub.id = b.user_id
),

-- Sales overlapping buys is the worse direction, a sale delivers USDC into the same
-- wallet a buy is measuring.
sale_buy_overlaps as (
  select
    s.id as sale_id, o.id as order_id,
    us.email as seller, uo.email as buyer,
    s.created_at as sale_at,
    round(extract(epoch from (o.created_at - s.created_at)))::bigint as gap_seconds
  from public.equity_sales s
  join public.equity_orders o
    on o.created_at between s.created_at - interval '4 minutes'
                        and s.created_at + interval '4 minutes'
  join auth.users us on us.id = s.user_id
  join auth.users uo on uo.id = o.user_id
),

report as (

  -- 1. Verdict
  select 1 as ord, '1. VERDICT' as section,
    case
      when (select count(*) from stranded_orders) > 0
        or (select count(*) from stranded_sales) > 0
        then 'ACTION NEEDED: stranded orders exist, customers are debited with nothing. See section 2.'
      when (select count(*) from order_overlaps) > 0
        or (select count(*) from sale_buy_overlaps) > 0
        then 'REVIEW: orders overlapped in time, so contamination was possible. Check rates in section 4.'
      else 'Clear. No stranded orders and no overlapping orders found.'
    end as item, '' as value

  -- 2. Stranded, money currently in limbo
  union all
  select 2, '2. Stranded buys',
    email || '  ' || symbol || '  order ' || id::text,
    round(amount_cngn_micro / 1e6, 2)::text || ' ngn debited, stuck ' || stuck_minutes::text || ' min'
  from stranded_orders

  union all
  select 2, '2. Stranded sells',
    email || '  ' || symbol || '  sale ' || id::text,
    shares::text || ' shares and ' || round(basis_removed / 1e6, 2)::text
      || ' ngn basis removed, stuck ' || stuck_minutes::text || ' min'
  from stranded_sales

  union all
  select 2, '2. Stranded totals', 'customer money in limbo',
    round(coalesce((select sum(amount_cngn_micro) from stranded_orders), 0) / 1e6, 2)::text
      || ' ngn across ' || (select count(*) from stranded_orders)::text || ' buys, plus '
      || (select count(*) from stranded_sales)::text || ' sells with shares removed'

  -- 3. Order status spread, for context
  union all
  select 3, '3. Order status', 'buys ' || status, count(*)::text || ' orders, '
    || round(sum(amount_cngn_micro) / 1e6, 2)::text || ' ngn'
  from public.equity_orders group by status

  union all
  select 3, '3. Order status', 'sells ' || status, count(*)::text || ' sales'
  from public.equity_sales group by status

  -- 4. Contamination signal. A tight cluster around one rate is healthy.
  union all
  select 4, '4. Implied rate on filled buys', 'spread across ' || n::text || ' filled buys',
    'median ' || coalesce(median_rate::text, 'n/a')
      || ', min ' || coalesce(min_rate::text, 'n/a')
      || ', max ' || coalesce(max_rate::text, 'n/a')
  from rate_stats

  union all
  select 4, '4. Implied rate on filled buys',
    email || '  ' || symbol || '  ' || to_char(created_at, 'DD Mon HH24:MI'),
    round(amount_cngn_micro / 1e6, 2)::text || ' ngn for '
      || round(usdc_micro / 1e6, 2)::text || ' usdc, rate ' || implied_rate::text
  from buy_rates

  -- 5. Overlapping windows, the precondition for contamination
  union all
  select 5, '5. Overlapping buys',
    'orders ' || id_a::text || ' and ' || id_b::text
      || '  (' || email_a || ' / ' || email_b || ')',
    sym_a || ' and ' || sym_b || ', ' || gap_seconds::text || 's apart at '
      || to_char(at_a, 'DD Mon HH24:MI')
  from order_overlaps

  union all
  select 5, '5. Sale overlapping a buy',
    'sale ' || sale_id::text || ' and order ' || order_id::text
      || '  (' || seller || ' sold / ' || buyer || ' bought)',
    gap_seconds::text || 's apart at ' || to_char(sale_at, 'DD Mon HH24:MI')
  from sale_buy_overlaps
)

select section, item, value
from report
order by ord, item;
