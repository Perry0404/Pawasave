-- FORENSICS-990-deposits.sql
--
-- Read-only. Works out whether the 990 naira deposit emails are real customer deposits or
-- fabricated credits.
--
-- Why the earlier checks would have missed this. The unexplained-credits query excluded
-- type = 'deposit' as legitimate, and the balance-versus-ledger check passes whenever a
-- credit writes a matching transactions row. credit_crypto_deposit and credit_strails_deposit
-- both write one, and both were callable by anon until 09 Sep. So a fabricated deposit looks
-- identical to a real one in both of those views.
--
-- Leading hypothesis: set_deposit_address was also anon-writable, so pointing several users
-- at one address makes a single real on-chain deposit credit all of them. That would produce
-- identical balances and deposit emails to people who never deposited.

-- 0. Are the two constraints that block duplication actually present. The repo says
--    wallets.deposit_address is UNIQUE and crypto_deposits.tx_key is UNIQUE, but the repo and
--    production have diverged before, and if either is missing the hypothesis is back open.
select
  '0. duplication guards' as section,
  c.conname,
  c.contype,
  t.relname as on_table,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in ('wallets', 'crypto_deposits', 'profiles')
  and c.contype in ('u', 'p')
order by t.relname, c.conname;

select
  '0b. unique indexes' as section,
  tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('wallets', 'crypto_deposits', 'profiles')
  and indexdef ilike '%unique%'
order by tablename, indexname;

-- 1. Every deposit credit, newest first. Amounts, references, and which provider.
select
  '1. deposit rows' as section,
  t.id, t.user_id,
  t.amount_kobo, t.amount_usdc_micro,
  round(t.amount_usdc_micro / 1e6, 2) as ngn,
  t.reference, t.status, t.created_at,
  t.metadata->>'channel'  as channel,
  t.metadata->>'provider' as provider,
  t.metadata->>'tx_hash'  as tx_hash
from public.transactions t
where t.type = 'deposit' and t.direction = 'credit'
order by t.created_at desc
limit 60;

-- 2. Do several users share a deposit address. This is the hypothesis.
--    Any group above 1 means one on-chain deposit credits multiple accounts.
select
  '2. shared deposit address' as section,
  deposit_address,
  count(*)                              as users,
  string_agg(user_id::text, ', ')       as user_ids
from public.wallets
where deposit_address is not null and deposit_address <> ''
group by deposit_address
having count(*) > 1
order by users desc;

-- 3. The same on-chain deposit credited more than once.
select
  '3. reused tx_hash' as section,
  tx_hash,
  count(*)                        as credits,
  count(distinct user_id)         as distinct_users,
  sum(amount_cngn_micro)          as total_micro,
  string_agg(distinct user_id::text, ', ') as user_ids
from public.crypto_deposits
group by tx_hash
having count(*) > 1
order by credits desc;

-- 4. Deposit rows with no provider reference. A real on-ramp always carries one.
select
  '4. deposits with no reference' as section,
  t.id, t.user_id, round(t.amount_usdc_micro / 1e6, 2) as ngn,
  t.reference, t.metadata, t.created_at
from public.transactions t
where t.type = 'deposit' and t.direction = 'credit'
  and (t.reference is null or t.reference = '' or t.metadata is null)
order by t.created_at desc;

-- 5. Every wallet holding exactly 990 naira, and where it came from.
select
  '5. the 990 wallets' as section,
  w.user_id, w.usdc_balance_micro, w.deposit_address, w.created_at as wallet_created,
  p.email, p.created_at as user_created, p.kyc_status
from public.wallets w
left join public.profiles p on p.id = w.user_id
where w.usdc_balance_micro = 990000000
order by w.created_at;

-- 6. crypto_deposits in full. Compare this against what custody actually received on chain.
select
  '6. crypto deposits' as section,
  id, user_id, tx_hash, log_index, address, block_number,
  round(amount_cngn_micro / 1e6, 2) as ngn,
  created_at
from public.crypto_deposits
order by created_at desc
limit 40;

-- 7. Totals by day, so a burst is visible.
select
  '7. deposits by day' as section,
  date_trunc('day', created_at)::date as day,
  count(*)                            as rows,
  count(distinct user_id)             as users,
  round(sum(amount_usdc_micro) / 1e6, 2) as total_ngn
from public.transactions
where type = 'deposit' and direction = 'credit'
group by date_trunc('day', created_at)
order by day desc
limit 20;

-- 8. Accounts created and credited within a few minutes of each other, which is what a
--    scripted abuse looks like.
select
  '8. fast credit after signup' as section,
  p.id, p.email, p.created_at as signed_up,
  min(t.created_at)            as first_credit,
  round(extract(epoch from (min(t.created_at) - p.created_at)) / 60, 1) as minutes_to_credit,
  round(sum(t.amount_usdc_micro) / 1e6, 2) as total_credited_ngn
from public.profiles p
join public.transactions t
  on t.user_id = p.id and t.type = 'deposit' and t.direction = 'credit'
group by p.id, p.email, p.created_at
having extract(epoch from (min(t.created_at) - p.created_at)) < 900
order by minutes_to_credit;

-- 9. Ledger deposits against on-chain crypto_deposits, per user. A user credited more than
--    the chain shows arriving for them is the thing to explain.
with led as (
  select user_id, sum(amount_usdc_micro) as credited_micro, count(*) as credit_rows
  from public.transactions
  where type = 'deposit' and direction = 'credit' and status = 'completed'
  group by user_id
),
chain as (
  select user_id, sum(amount_cngn_micro) as onchain_micro, count(*) as chain_rows
  from public.crypto_deposits
  group by user_id
)
select
  '9. credited vs on-chain' as section,
  coalesce(l.user_id, c.user_id) as user_id,
  coalesce(l.credit_rows, 0)     as ledger_rows,
  coalesce(c.chain_rows, 0)      as chain_rows,
  round(coalesce(l.credited_micro, 0) / 1e6, 2) as credited_ngn,
  round(coalesce(c.onchain_micro, 0) / 1e6, 2)  as onchain_ngn
from led l
full outer join chain c on c.user_id = l.user_id
order by credited_ngn desc
limit 40;
