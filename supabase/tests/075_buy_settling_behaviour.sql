-- Behaviour checks for migration 075. The property that matters: a settling buy must never
-- be auto-refunded, because its cNGN has left custody and its USDC has not been spent yet.

create temp table r (ord int, name text, detail text, ok boolean);

-- Wallet and order fixtures. usdc_balance_micro is where cNGN lives, per 063.
insert into public.wallets (user_id, usdc_balance_micro)
values ('22222222-2222-2222-2222-222222222222', 0)
on conflict (user_id) do update set usdc_balance_micro = 0;

create or replace function pg_temp.new_order() returns bigint
language sql as $$
  insert into public.equity_orders
    (user_id, symbol, asset_type, provider, amount_cngn_micro, status)
  values ('22222222-2222-2222-2222-222222222222', 'TSLA', 'tokenized_stock', 'base_dex', 1700000000, 'pending')
  returning id;
$$;

-- 1. A pending order that fails still refunds. That path must not regress.
do $$
declare oid bigint;
begin
  oid := pg_temp.new_order();
  perform public.settle_equity_order(oid, 'failed', null, null, null, 'broker down');
  insert into r
  select 1, 'pending order still refunds',
         'status ' || o.status || ', wallet ' || w.usdc_balance_micro::text,
         o.status = 'refunded' and w.usdc_balance_micro = 1700000000
  from public.equity_orders o, public.wallets w
  where o.id = oid and w.user_id = o.user_id;
end $$;

-- 2. Parking a pending order records the USDC and does not credit the wallet.
do $$
declare oid bigint; before bigint;
begin
  select usdc_balance_micro into before from public.wallets
  where user_id = '22222222-2222-2222-2222-222222222222';
  oid := pg_temp.new_order();
  perform public.mark_equity_buy_settling(oid, 1225700, null, 'no route for stock leg');
  insert into r
  select 2, 'parking records usdc and does not refund',
         'status ' || o.status || ', usdc ' || o.usdc_micro::text || ', wallet unchanged ' || (w.usdc_balance_micro = before)::text,
         o.status = 'settling' and o.usdc_micro = 1225700 and w.usdc_balance_micro = before
  from public.equity_orders o, public.wallets w
  where o.id = oid and w.user_id = o.user_id;
end $$;

-- 3. A settling order must NOT be refunded. This is the whole reason 075 exists.
do $$
declare oid bigint; before bigint;
begin
  oid := pg_temp.new_order();
  perform public.mark_equity_buy_settling(oid, 1225700, null, 'stock leg pending');
  select usdc_balance_micro into before from public.wallets
  where user_id = '22222222-2222-2222-2222-222222222222';
  perform public.settle_equity_order(oid, 'failed', null, null, null, 'give up');
  insert into r
  select 3, 'settling order refuses to refund',
         'status ' || o.status || ', wallet unchanged ' || (w.usdc_balance_micro = before)::text,
         o.status = 'settling' and w.usdc_balance_micro = before
  from public.equity_orders o, public.wallets w
  where o.id = oid and w.user_id = o.user_id;
end $$;

-- 4. A settling order can be filled, which credits the holding and books the ledger row.
do $$
declare oid bigint;
begin
  oid := pg_temp.new_order();
  perform public.mark_equity_buy_settling(oid, 1225700, null, 'stock leg pending');
  perform public.settle_equity_order(oid, 'filled', 1225700, 0.0035, '0xabc');
  insert into r
  select 4, 'settling order can be filled',
         'status ' || o.status || ', shares ' || o.shares::text
         || ', holding ' || coalesce(h.shares::text, 'none')
         || ', ledger rows ' || (select count(*) from public.transactions t where t.reference = 'equity_' || oid::text)::text,
         o.status = 'filled' and o.shares = 0.0035 and h.shares > 0
         and (select count(*) from public.transactions t where t.reference = 'equity_' || oid::text) = 1
  from public.equity_orders o
  left join public.portfolio_holdings h
    on h.user_id = o.user_id and h.symbol = o.symbol and h.provider = o.provider
  where o.id = oid;
end $$;

-- 5. Filling twice must not double the ledger or the holding.
do $$
declare oid bigint; shares_before numeric;
begin
  oid := pg_temp.new_order();
  perform public.mark_equity_buy_settling(oid, 1225700, null, 'pending');
  perform public.settle_equity_order(oid, 'filled', 1225700, 0.001, '0xdef');
  select shares into shares_before from public.portfolio_holdings
  where user_id = '22222222-2222-2222-2222-222222222222' and symbol = 'TSLA' and provider = 'base_dex';
  perform public.settle_equity_order(oid, 'filled', 1225700, 0.001, '0xdef');
  insert into r
  select 5, 'double fill is a no-op',
         'ledger rows ' || (select count(*) from public.transactions t where t.reference = 'equity_' || oid::text)::text
         || ', holding unchanged ' || (h.shares = shares_before)::text,
         (select count(*) from public.transactions t where t.reference = 'equity_' || oid::text) = 1
         and h.shares = shares_before
  from public.portfolio_holdings h
  where h.user_id = '22222222-2222-2222-2222-222222222222' and h.symbol = 'TSLA' and h.provider = 'base_dex';
end $$;

-- 6. Attempt counter, and the escalation view only picks up orders at the cap.
do $$
declare oid bigint; a int; b2 int;
begin
  oid := pg_temp.new_order();
  perform public.mark_equity_buy_settling(oid, 999999, null, 'pending');
  a := public.bump_equity_buy_attempt(oid, 'try one');
  b2 := public.bump_equity_buy_attempt(oid, 'try two');
  insert into r select 6, 'buy attempt counter increments',
    'first ' || a::text || ', second ' || b2::text, a = 1 and b2 = 2;

  insert into r select 7, 'view excludes under the cap',
    count(*)::text || ' rows', count(*) = 0 from public.equity_orders_needing_attention;

  update public.equity_orders set settle_attempts = 12 where id = oid;
  insert into r select 8, 'view includes at the cap',
    count(*)::text || ' rows', count(*) = 1
    from public.equity_orders_needing_attention where id = oid;
end $$;

select case when ok then 'PASS' else 'FAIL' end as result, name, detail from r order by ord;
select count(*) filter (where not ok) as failures from r;
