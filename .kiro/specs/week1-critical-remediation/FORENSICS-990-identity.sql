-- FORENSICS-990-identity.sql
--
-- Read-only. Corrects two things from the previous file.
--
-- 1. profiles has no email column and wallets has no created_at, which is why sections 5 and
--    8 errored. Email lives in auth.users.
-- 2. Section 9 compared every deposit against crypto_deposits, but that table only holds
--    on-chain deposits to per-user addresses. Strails deposits are fiat and arrive by
--    webhook, so they were never going to appear there. Ignore that result, it was my error,
--    not a discrepancy. The reconciliation below is done per channel instead.

-- 1. Who these accounts are.
select
  '1. identity' as section,
  u.id, u.email, u.created_at as signed_up, u.last_sign_in_at,
  round(coalesce(w.usdc_balance_micro, 0) / 1e6, 2) as balance_ngn,
  p.kyc_status
from auth.users u
left join public.wallets w  on w.user_id = u.id
left join public.profiles p on p.id = u.id
where u.id in (
  '78b1fad2-9016-4027-9ab3-d4b6a7bd0e46',
  '904072c7-f5eb-4833-a182-e1b9c885ae3d',
  'a5098e88-666c-42b4-96b6-cea1e3d21ae9',
  '8166da1e-827b-4397-98b1-5a2d09ccee26',
  'd71b06ad-6765-4ccd-b11a-d1eda125e866',
  'c4af0655-8f7a-46b4-bb2c-b1af6ee95c54',
  '275eb416-5fb9-41b4-a213-22f4eee4898f',
  '5627dea2-876c-4c56-8813-7144af65dc5a'
)
order by u.created_at;

-- 2. Every deposit with the email attached, so the pattern is readable at a glance.
select
  '2. deposits by account' as section,
  u.email,
  round(t.amount_usdc_micro / 1e6, 2) as credited_ngn,
  round(coalesce((t.metadata->>'gross_naira')::numeric, t.amount_kobo / 100.0), 2) as gross_ngn,
  coalesce((t.metadata->>'fee_naira')::numeric, 0) as our_fee_ngn,
  t.metadata->>'channel' as channel,
  t.metadata->>'sender_name' as sender_name,
  t.reference,
  t.created_at
from public.transactions t
join auth.users u on u.id = t.user_id
where t.type = 'deposit' and t.direction = 'credit' and t.status = 'completed'
order by t.created_at desc
limit 40;

-- 3. The float question. We credit the customer the net Strails reports, but custody only
--    receives what Strails actually sends on chain, and those differ. Under the current
--    policy a deposit below 50,000 naira carries a zero PawaSave fee, so any gap between
--    what we credit and what lands is absorbed by us.
select
  '3. credited vs fee taken' as section,
  count(*)                                                        as strails_deposits,
  round(sum(coalesce((metadata->>'gross_naira')::numeric, 0)), 2)  as total_gross_ngn,
  round(sum(amount_usdc_micro) / 1e6, 2)                          as total_credited_ngn,
  round(sum(coalesce((metadata->>'fee_naira')::numeric, 0)), 2)    as total_our_fee_ngn
from public.transactions
where type = 'deposit' and direction = 'credit' and status = 'completed'
  and metadata->>'channel' = 'Strails';

-- 4. Per-deposit view of the same thing, newest first. cNGN actually received is on chain,
--    not in the database, so compare these figures against the custody inbound list.
select
  '4. per deposit' as section,
  u.email,
  round(coalesce((t.metadata->>'gross_naira')::numeric, 0), 2) as gross_ngn,
  round(t.amount_usdc_micro / 1e6, 2)                          as credited_ngn,
  coalesce((t.metadata->>'fee_naira')::numeric, 0)             as our_fee_ngn,
  t.created_at
from public.transactions t
join auth.users u on u.id = t.user_id
where t.type = 'deposit' and t.direction = 'credit' and t.status = 'completed'
  and t.metadata->>'channel' = 'Strails'
order by t.created_at desc;

-- 5. How many distinct accounts have ever deposited, and how recently. Tells us whether this
--    is a handful of testers or a growing user base.
select
  '5. depositor summary' as section,
  count(distinct t.user_id)                       as depositors,
  min(t.created_at)::date                         as first_deposit,
  max(t.created_at)::date                         as latest_deposit,
  round(sum(t.amount_usdc_micro) / 1e6, 2)        as total_credited_ngn
from public.transactions t
where t.type = 'deposit' and t.direction = 'credit' and t.status = 'completed';

-- 6. Total registered accounts, so the deposit count has context.
select '6. user counts' as section,
       (select count(*) from auth.users)                                    as registered,
       (select count(*) from public.wallets where usdc_balance_micro > 0)    as funded_wallets,
       round((select sum(usdc_balance_micro) from public.wallets) / 1e6, 2)  as total_customer_ngn;
