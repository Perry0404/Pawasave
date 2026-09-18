-- PROBE-table-grants.sql
--
-- Read-only. Covers the gap in everything so far: I audited function grants and left table
-- grants alone.
--
-- Why it matters. hooks/use-data.ts writes a ledger row straight from the browser
-- (supabase.from('transactions').insert(...)) right after saving to the vault. If
-- `authenticated` holds INSERT on transactions then a user can author arbitrary ledger
-- entries, which would make every reconciliation we have run meaningless, because those all
-- treat the ledger as the trustworthy side.
--
-- RLS may still block it even where the grant exists, so both are reported together. A grant
-- with RLS off and no policy is the dangerous combination.

-- 1. Client write access on the money tables, with the RLS state beside it.
select
  '1. write access on money tables' as section,
  c.relname as table_name,
  c.relrowsecurity as rls_on,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies,
  has_table_privilege('anon',          c.oid, 'INSERT') as anon_insert,
  has_table_privilege('authenticated', c.oid, 'INSERT') as user_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as user_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') as user_delete,
  case
    when not c.relrowsecurity and has_table_privilege('authenticated', c.oid, 'INSERT')
      then 'WRITABLE, RLS OFF'
    when has_table_privilege('authenticated', c.oid, 'INSERT')
      then 'insert granted, RLS decides'
    else 'no client insert'
  end as verdict
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('transactions', 'wallets', 'profiles', 'savings_locks', 'savings_goals',
                    'portfolio_holdings', 'equity_orders', 'equity_sales', 'crypto_deposits',
                    'platform_fees', 'revenue_journal', 'loans', 'esusu_contributions',
                    'proxy_transfers', 'custody_divergence', 'flexible_pool_positions')
order by user_insert desc, user_update desc, c.relname;

-- 2. The INSERT and UPDATE policies that actually govern those writes.
select
  '2. write policies' as section,
  tablename, policyname, cmd, roles::text,
  coalesce(with_check, qual) as expression
from pg_policies
where schemaname = 'public'
  and cmd in ('INSERT', 'UPDATE', 'ALL')
order by tablename, policyname;

-- 3. Every table a signed-in user can write, not just the ones I listed above.
select
  '3. all client-writable tables' as section,
  c.relname as table_name,
  c.relrowsecurity as rls_on,
  has_table_privilege('authenticated', c.oid, 'INSERT') as ins,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as upd,
  has_table_privilege('authenticated', c.oid, 'DELETE') as del
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (has_table_privilege('authenticated', c.oid, 'INSERT')
    or has_table_privilege('authenticated', c.oid, 'UPDATE')
    or has_table_privilege('authenticated', c.oid, 'DELETE'))
order by c.relname;

-- 4. Anything readable without logging in.
select
  '4. anon readable' as section,
  c.relname as object_name,
  c.relkind = 'v' as is_view,
  c.relrowsecurity as rls_on
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'v')
  and has_table_privilege('anon', c.oid, 'SELECT')
order by c.relkind, c.relname;

-- 5. Tables with RLS off. Any client grant on these is unconditional.
select
  '5. rls off' as section,
  c.relname as table_name,
  has_table_privilege('anon', c.oid, 'SELECT')          as anon_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') as user_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') as user_insert
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by c.relname;

-- 6. Has a browser-authored ledger row already happened? save_to_vault writes its row from
--    the client, so those exist by design. Rows whose type does not match any server path
--    would be the concerning ones.
select
  '6. ledger rows by type' as section,
  type, direction, count(*) as rows,
  min(created_at)::date as first, max(created_at)::date as last
from public.transactions
group by type, direction
order by type, direction;
