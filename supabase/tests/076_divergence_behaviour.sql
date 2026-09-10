-- Behaviour checks for migration 076.

create temp table r (ord int, name text, detail text, ok boolean);

-- 1. A recorded shortfall shows up as open.
do $$
declare v_id bigint;
begin
  v_id := public.record_custody_divergence(
    'equity_buy_cngn_escrow_stranded', 'cngn', 1700000000,
    'equity_orders', 41, null, '0xaaa', 'customer refunded, cNGN escrowed');
  insert into r
  select 1, 'records an open shortfall',
         'id ' || v_id::text || ', status ' || d.status || ', amount ' || d.amount_micro::text,
         v_id is not null and d.status = 'open' and d.amount_micro = 1700000000
  from public.custody_divergence d where d.id = v_id;
end $$;

-- 2. The same placement tx must not create a second row. A retrying cron would otherwise
--    inflate the shortfall on every pass.
do $$
declare a bigint; b bigint;
begin
  a := public.record_custody_divergence('k', 'usdc', 500000, 'equity_sales', 9, null, '0xbbb', 'first');
  b := public.record_custody_divergence('k', 'usdc', 500000, 'equity_sales', 9, null, '0xbbb', 'second');
  insert into r
  select 2, 'same place_tx is deduplicated',
         'ids ' || a::text || ' and ' || b::text || ', rows ' || count(*)::text,
         a = b and count(*) = 1
  from public.custody_divergence where place_tx = '0xbbb';
end $$;

-- 3. Rows without a placement tx are not deduplicated against each other, since the partial
--    index only covers non-null values.
do $$
declare a bigint; b bigint;
begin
  a := public.record_custody_divergence('offramp', 'cngn', 1000, null, null, null, null, 'one');
  b := public.record_custody_divergence('offramp', 'cngn', 1000, null, null, null, null, 'two');
  insert into r
  select 3, 'null place_tx rows are kept separate',
         'rows ' || count(*)::text, a <> b and count(*) = 2
  from public.custody_divergence where place_tx is null and kind = 'offramp';
end $$;

-- 4. A zero or negative amount is rejected rather than stored as a bogus event.
do $$
declare v_id bigint;
begin
  v_id := public.record_custody_divergence('k', 'usdc', 0, null, null, null, '0xccc', 'zero');
  insert into r select 4, 'zero amount is refused',
    'returned ' || coalesce(v_id::text, 'null'), v_id is null;
end $$;

-- 5. Resolving marks it recovered and removes it from the open total.
do $$
declare v_id bigint; okk boolean; before_short bigint;
begin
  v_id := public.record_custody_divergence('k', 'usdc', 250000, null, null, null, '0xddd', 'to recover');
  select short_micro into before_short from public.custody_divergence_open where asset = 'usdc';
  okk := public.resolve_custody_divergence(v_id, 'recovered', 250000, '0xcancel', 'cancelled the order');
  insert into r
  select 5, 'resolving clears it from the open total',
         'returned ' || okk::text || ', status ' || d.status
         || ', open dropped by ' || (before_short - coalesce((select short_micro from public.custody_divergence_open where asset = 'usdc'), 0))::text,
         okk and d.status = 'recovered'
         and coalesce((select short_micro from public.custody_divergence_open where asset = 'usdc'), 0) = before_short - 250000
  from public.custody_divergence d where d.id = v_id;
end $$;

-- 6. Resolving twice is refused, so a recovery cannot be double counted.
do $$
declare v_id bigint; first boolean; second boolean;
begin
  v_id := public.record_custody_divergence('k', 'usdc', 111111, null, null, null, '0xeee', 'x');
  first := public.resolve_custody_divergence(v_id, 'recovered', 111111, '0xtx', null);
  second := public.resolve_custody_divergence(v_id, 'recovered', 111111, '0xtx', null);
  insert into r select 6, 'double resolve is refused',
    'first ' || first::text || ', second ' || second::text, first and not second;
end $$;

-- 7. An unknown status is refused.
do $$
declare v_id bigint; res boolean;
begin
  v_id := public.record_custody_divergence('k', 'usdc', 222222, null, null, null, '0xfff', 'y');
  res := public.resolve_custody_divergence(v_id, 'vanished', null, null, null);
  insert into r
  select 7, 'unknown resolve status refused',
         'returned ' || res::text || ', still ' || d.status,
         res = false and d.status = 'open'
  from public.custody_divergence d where d.id = v_id;
end $$;

-- 8. The open view groups by asset and only counts open rows.
insert into r
select 8, 'open view groups by asset',
       coalesce(string_agg(asset || '=' || short_micro::text, ', ' order by asset), 'empty'),
       count(*) >= 1
from public.custody_divergence_open;

select case when ok then 'PASS' else 'FAIL' end as result, name, detail from r order by ord;
select count(*) filter (where not ok) as failures from r;
