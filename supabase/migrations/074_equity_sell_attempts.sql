-- 074_equity_sell_attempts.sql  (run after 072)
--
-- Bound the sell reconciler. A sale parked 'settling' is retried by
-- cron/equity-sell-reconcile every ~10 min forever, so a sale that can never fill, say the
-- recorded USDC is no longer in custody, retries indefinitely with nothing in the row to
-- show it has been failing or why.
--
-- Adds an attempt counter and the last error, plus a bump function the cron calls when a
-- retry does not fill. Past the cap the cron stops trying and the row is visible for manual
-- settlement.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

alter table public.equity_sales
  add column if not exists settle_attempts   int not null default 0,
  add column if not exists last_settle_error text,
  add column if not exists last_settle_at    timestamptz;

-- Record a retry that did not fill. Kept separate from settle_equity_sell so a failed
-- attempt never touches status, shares or balances.
create or replace function public.bump_equity_sell_attempt(
  p_sale_id bigint,
  p_error   text default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
begin
  update public.equity_sales
  set settle_attempts   = settle_attempts + 1,
      last_settle_error = left(coalesce(p_error, ''), 500),
      last_settle_at    = now()
  where id = p_sale_id
  returning settle_attempts into v_attempts;

  return coalesce(v_attempts, -1);
end;
$$;

revoke all on function public.bump_equity_sell_attempt(bigint, text) from public, anon, authenticated;
grant execute on function public.bump_equity_sell_attempt(bigint, text) to service_role;

-- Sales the reconciler has given up on, for the ops dashboard.
create or replace view public.equity_sales_needing_attention as
  select id, user_id, symbol, shares, usdc_micro, broker_ref,
         settle_attempts, last_settle_error, last_settle_at, created_at
  from public.equity_sales
  where status = 'settling'
    and settle_attempts >= 12;

revoke all on public.equity_sales_needing_attention from public, anon, authenticated;
grant select on public.equity_sales_needing_attention to service_role;
