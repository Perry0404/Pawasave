-- 075_equity_buy_settling.sql  (run after 063 and 074)
--
-- Gives buys the same 'settling' state sells got in 072, for the same reason.
--
-- A buy is cNGN into the HyperFX escrow, then USDC into the stock. When leg 1 succeeds and
-- leg 2 fails, the route called settle_equity_order with 'failed', which refunds the
-- customer's cNGN in the database. But the cNGN has already left custody and the USDC is
-- sitting there unspent, so the customer is made whole out of company float and nothing
-- records that the float is short. The sell side already learned this the expensive way.
--
-- Now leg 1 succeeding parks the order as 'settling' with usdc_micro recorded and no
-- refund, and cron/equity-buy-reconcile retries leg 2. Only a pending order refunds,
-- because refunding a settling order means eating USDC custody is actually holding.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

alter table public.equity_orders drop constraint if exists equity_orders_status_check;
alter table public.equity_orders add constraint equity_orders_status_check
  check (status in ('pending', 'settling', 'filled', 'failed', 'refunded'));

alter table public.equity_orders
  add column if not exists settle_attempts   int not null default 0,
  add column if not exists last_settle_error text,
  add column if not exists last_settle_at    timestamptz;

-- Park a buy whose cNGN is already spent but whose stock leg has not completed.
-- Deliberately does not touch the wallet: the customer keeps no cNGN and no shares yet,
-- and the reconciler is what resolves it either way.
create or replace function public.mark_equity_buy_settling(
  p_order_id   bigint,
  p_usdc_micro bigint,
  p_broker_ref text default null,
  p_error      text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.equity_orders
  set status            = 'settling',
      usdc_micro        = p_usdc_micro,
      broker_ref        = coalesce(p_broker_ref, broker_ref),
      error             = left(coalesce(p_error, ''), 500),
      last_settle_error = left(coalesce(p_error, ''), 500),
      last_settle_at    = now(),
      updated_at        = now()
  where id = p_order_id
    and status = 'pending';
end;
$$;

-- Record a retry that did not complete. Never touches status or balances.
create or replace function public.bump_equity_buy_attempt(
  p_order_id bigint,
  p_error    text default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
begin
  update public.equity_orders
  set settle_attempts   = settle_attempts + 1,
      last_settle_error = left(coalesce(p_error, ''), 500),
      last_settle_at    = now()
  where id = p_order_id
  returning settle_attempts into v_attempts;

  return coalesce(v_attempts, -1);
end;
$$;

-- settle: pending|settling -> filled, and pending -> refunded.
-- Body follows 063 with the status guard widened and the refund branch narrowed.
create or replace function public.settle_equity_order(
  p_order_id   bigint,
  p_status     text,
  p_usdc_micro bigint  default null,
  p_shares     numeric default null,
  p_broker_ref text    default null,
  p_error      text    default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare o public.equity_orders%rowtype;
begin
  select * into o from public.equity_orders where id = p_order_id for update;
  if not found or o.status not in ('pending', 'settling') then
    return; -- idempotent
  end if;

  if p_status = 'filled' then
    update public.equity_orders
    set status = 'filled',
        usdc_micro = coalesce(p_usdc_micro, o.usdc_micro),
        shares = p_shares,
        broker_ref = coalesce(p_broker_ref, o.broker_ref),
        error = null,
        updated_at = now()
    where id = p_order_id;

    insert into public.portfolio_holdings (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
    values (o.user_id, o.symbol, o.asset_type, o.provider, o.amount_cngn_micro, coalesce(p_shares, 0))
    on conflict (user_id, symbol, provider) do update
      set invested_cngn_micro = public.portfolio_holdings.invested_cngn_micro + o.amount_cngn_micro,
          shares              = public.portfolio_holdings.shares + coalesce(p_shares, 0),
          updated_at          = now();

    insert into public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    values
      (o.user_id, 'investment', 'debit', floor(o.amount_cngn_micro / 10000), o.amount_cngn_micro,
       'Invested in ' || o.symbol, 'equity_' || o.id::text, 'completed',
       jsonb_build_object('channel', 'Equity', 'symbol', o.symbol, 'asset_type', o.asset_type,
                          'provider', o.provider, 'shares', p_shares, 'broker_ref', p_broker_ref));
    -- No ON CONFLICT: the status guard above already makes a re-settle a no-op, so this
    -- row is inserted at most once, and transactions.reference has no unique index to
    -- conflict on anyway.

  elsif o.status = 'pending' then
    -- Nothing left custody yet, so a refund is honest.
    update public.wallets
    set usdc_balance_micro = usdc_balance_micro + o.amount_cngn_micro, updated_at = now()
    where user_id = o.user_id;

    update public.equity_orders
    set status = 'refunded', error = p_error, updated_at = now()
    where id = p_order_id;

  else
    -- A settling order holds real USDC. Refunding here pays the customer AND keeps the
    -- USDC, so it needs a human. Leave it settling and record why.
    update public.equity_orders
    set last_settle_error = left(coalesce(p_error, 'refund refused, order is settling'), 500),
        last_settle_at    = now(),
        updated_at        = now()
    where id = p_order_id;
  end if;
end;
$$;

-- Buys the reconciler has given up on, for the ops dashboard.
create or replace view public.equity_orders_needing_attention as
  select id, user_id, symbol, amount_cngn_micro, usdc_micro, broker_ref,
         settle_attempts, last_settle_error, last_settle_at, created_at
  from public.equity_orders
  where status = 'settling'
    and settle_attempts >= 12;

revoke all on function public.mark_equity_buy_settling(bigint, bigint, text, text) from public, anon, authenticated;
revoke all on function public.bump_equity_buy_attempt(bigint, text)                from public, anon, authenticated;
revoke all on function public.settle_equity_order(bigint, text, bigint, numeric, text, text) from public, anon, authenticated;
revoke all on public.equity_orders_needing_attention from public, anon, authenticated;

grant execute on function public.mark_equity_buy_settling(bigint, bigint, text, text) to service_role;
grant execute on function public.bump_equity_buy_attempt(bigint, text)                to service_role;
grant execute on function public.settle_equity_order(bigint, text, bigint, numeric, text, text) to service_role;
grant select on public.equity_orders_needing_attention to service_role;
