-- APPLY-075.sql
--
-- Run this in the Supabase SQL editor BEFORE deploying the buy-reconciler commit.
--
-- Ordering matters. The buy route now calls mark_equity_buy_settling when leg 1 has spent
-- the cNGN but leg 2 has not bought the stock. Until that function exists the call fails and
-- the order is left 'pending' with the cNGN already gone, which is the exact stranding this
-- is meant to prevent. cron/equity-buy-reconcile also selects equity_orders.settle_attempts.
--
-- 073 and 074 are already applied. This only needs 063 to have run, which it has.
-- Idempotent, so re-running is safe. Verification is at the bottom.

alter table public.equity_orders drop constraint if exists equity_orders_status_check;
alter table public.equity_orders add constraint equity_orders_status_check
  check (status in ('pending', 'settling', 'filled', 'failed', 'refunded'));

alter table public.equity_orders
  add column if not exists settle_attempts   int not null default 0,
  add column if not exists last_settle_error text,
  add column if not exists last_settle_at    timestamptz;

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
    -- No ON CONFLICT: the status guard above already makes a re-settle a no-op, and
    -- transactions.reference has no unique index to conflict on.

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

-- ─────────────────────────────────────────────────────────────
-- Verification. Every row should read PASS.
-- ─────────────────────────────────────────────────────────────

with checks as (
  select 1 as ord, 'settling is an allowed order status' as check_name,
         coalesce(pg_get_constraintdef(oid), 'constraint missing') as detail,
         coalesce(pg_get_constraintdef(oid) like '%settling%', false) as ok
  from pg_constraint
  where conname = 'equity_orders_status_check'

  union all
  select 2, 'equity_orders has attempt columns',
         count(*)::text || ' of 3', count(*) = 3
  from information_schema.columns
  where table_schema = 'public' and table_name = 'equity_orders'
    and column_name in ('settle_attempts', 'last_settle_error', 'last_settle_at')

  union all
  select 3, 'buy settle functions exist',
         count(*)::text || ' of 3', count(*) = 3
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('mark_equity_buy_settling', 'bump_equity_buy_attempt', 'settle_equity_order')

  union all
  select 4, 'buy settle functions pin search_path',
         count(*)::text || ' of 3', count(*) = 3
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('mark_equity_buy_settling', 'bump_equity_buy_attempt', 'settle_equity_order')
    and array_to_string(p.proconfig, ',') like '%search_path%'

  union all
  select 5, 'buy settle functions not client callable',
         coalesce(string_agg(distinct p.proname, ', '), 'none reachable'), count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('mark_equity_buy_settling', 'bump_equity_buy_attempt', 'settle_equity_order')
    and (has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'))

  union all
  select 6, 'needs-attention view exists', count(*)::text, count(*) = 1
  from information_schema.views
  where table_schema = 'public' and table_name = 'equity_orders_needing_attention'

  union all
  -- Nothing should be parked yet. Anything here is a pre-existing stranded buy worth a look.
  select 7, 'orders currently parked settling',
         count(*)::text || ' rows', true
  from public.equity_orders where status = 'settling'

  union all
  -- Buys stuck pending for over an hour are the ones the old code stranded.
  select 8, 'buys stuck pending over 1h',
         coalesce(string_agg(id::text, ', '), 'none'), true
  from public.equity_orders
  where status = 'pending' and created_at < now() - interval '1 hour'
)
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from checks
order by ord;
