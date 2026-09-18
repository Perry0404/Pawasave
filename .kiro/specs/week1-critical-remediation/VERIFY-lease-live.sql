-- VERIFY-lease-live.sql
--
-- Run in the Supabase SQL editor a few minutes after the deploy, once at least one supply
-- cron has fired. Read-only. Confirms the deployed code is really taking the lease, and
-- shows the state of the two sales whose USDC is stranded in the intent gateway.

-- 1. Has anything acquired the lease yet? holder is set by custody-lease.ts, so a row here
--    with a recognisable holder is direct proof the new path is live.
select
  '1. lease activity' as section,
  key,
  coalesce(holder, '(no holder recorded, this would be the OLD lock)') as holder,
  acquired_at,
  locked_until,
  case
    when token is null   then 'NO TOKEN, old try_acquire_lock wrote this'
    when locked_until > now() then 'held right now'
    else 'expired, free to steal'
  end as state
from public.system_locks
order by acquired_at desc nulls last;

-- 2. Sales still parked. settle_attempts climbing with a "custody holds ... sale recorded"
--    error is the new guard doing its job: it is refusing to spend float on USDC that is
--    escrowed in the gateway rather than sitting in custody.
select
  '2. parked sales' as section,
  id, symbol, status,
  usdc_micro,
  settle_attempts,
  left(coalesce(last_settle_error, '(none yet)'), 90) as last_error,
  last_settle_at,
  round(extract(epoch from (now() - created_at)) / 60) as age_min
from public.equity_sales
where status in ('settling', 'pending')
order by created_at;

-- 3. Anything the reconciler has given up on.
select '3. needs a human' as section, id, symbol, usdc_micro, settle_attempts, last_settle_error
from public.equity_sales_needing_attention
order by id;

-- 4. Did any sell settle after the SDK pin? A row here dated after the deploy means
--    solvers are filling again on 2.8.11.
select
  '4. recent settled sells' as section,
  id, symbol, usdc_micro, cngn_gross_micro, cngn_net_micro, updated_at
from public.equity_sales
where status = 'filled'
order by updated_at desc
limit 5;
