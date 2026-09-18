-- DRILLDOWN-ledger-gap.sql
--
-- Read-only. Explains why one user's ledger sum is far above their wallet balance.
--
-- The exploit signature would be wallet ABOVE ledger, money with no ledger row behind it.
-- This user is the reverse, so the question is which debits are missing an amount rather
-- than where extra money came from. Working hypothesis: withdrawals write a row with
-- amount_usdc_micro null or zero, so the reconciliation sum counts credits and not debits.

-- 1. Per type and direction, with a count of rows carrying no usdc amount.
select
  '1. by type' as section,
  type,
  direction,
  count(*)                                                          as rows,
  count(*) filter (where amount_usdc_micro is null)                 as null_usdc,
  count(*) filter (where coalesce(amount_usdc_micro, 0) = 0)        as zero_or_null_usdc,
  sum(coalesce(amount_usdc_micro, 0))                               as sum_usdc_micro,
  sum(coalesce(amount_kobo, 0))                                     as sum_kobo,
  min(created_at)::date                                             as first,
  max(created_at)::date                                             as last
from public.transactions
where user_id = '78b1fad2-9016-4027-9ab3-d4b6a7bd0e46'
group by type, direction
order by type, direction;

-- 2. Same question across every user, since this is unlikely to be one account's problem.
select
  '2. all users by type' as section,
  type,
  direction,
  count(*)                                                   as rows,
  count(*) filter (where coalesce(amount_usdc_micro, 0) = 0)  as zero_or_null_usdc,
  sum(coalesce(amount_usdc_micro, 0))                        as sum_usdc_micro,
  sum(coalesce(amount_kobo, 0))                              as sum_kobo
from public.transactions
group by type, direction
order by zero_or_null_usdc desc, type;

-- 3. Status breakdown. My reconciliation only counted 'completed', so a pile of rows in
--    another status would also skew it.
select '3. by status' as section, status, count(*) as rows,
       sum(coalesce(amount_usdc_micro, 0)) as sum_usdc_micro
from public.transactions
where user_id = '78b1fad2-9016-4027-9ab3-d4b6a7bd0e46'
group by status
order by rows desc;

-- 4. Redo the reconciliation counting kobo instead of usdc_micro. If this one balances,
--    the two amount columns are simply populated by different paths.
with led as (
  select user_id,
         sum(case when direction = 'credit' then coalesce(amount_kobo, 0)
                  else -coalesce(amount_kobo, 0) end) as net_kobo
  from public.transactions
  where status = 'completed'
  group by user_id
)
select
  '4. kobo reconciliation' as section,
  w.user_id,
  w.usdc_balance_micro                            as wallet_micro,
  l.net_kobo,
  l.net_kobo * 10000                              as net_kobo_as_micro,
  w.usdc_balance_micro - (l.net_kobo * 10000)     as gap_micro
from public.wallets w
join led l on l.user_id = w.user_id
where w.usdc_balance_micro <> 0 or l.net_kobo <> 0
order by abs(w.usdc_balance_micro - (l.net_kobo * 10000)) desc
limit 20;

-- 5. The flagged user's largest rows, to see what is actually in there.
select '5. biggest rows' as section, id, type, direction, status,
       amount_kobo, amount_usdc_micro, reference, created_at
from public.transactions
where user_id = '78b1fad2-9016-4027-9ab3-d4b6a7bd0e46'
order by coalesce(amount_usdc_micro, 0) desc
limit 15;

-- 6. Who is this, and is it a team account.
select '6. identity' as section, p.id, p.email, p.kyc_status, p.created_at
from public.profiles p
where p.id = '78b1fad2-9016-4027-9ab3-d4b6a7bd0e46';

-- 7. Any wallet holding more than its ledger explains, which IS the exploit direction.
--    Nothing should appear here.
with led as (
  select user_id,
         sum(case when direction = 'credit' then coalesce(amount_usdc_micro, 0)
                  else -coalesce(amount_usdc_micro, 0) end) as net_micro
  from public.transactions
  where status = 'completed'
  group by user_id
)
select '7. wallet above ledger' as section, w.user_id, w.usdc_balance_micro,
       coalesce(l.net_micro, 0) as ledger_net_micro,
       w.usdc_balance_micro - coalesce(l.net_micro, 0) as excess_micro
from public.wallets w
left join led l on l.user_id = w.user_id
where w.usdc_balance_micro - coalesce(l.net_micro, 0) > 0
order by excess_micro desc
limit 20;
