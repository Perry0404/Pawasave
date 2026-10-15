// 118_account_deletion.test.mjs
//
// Behaviour test for migration 118 (account deletion), against an in-memory Postgres (PGlite)
// with a minimal stub of the tables it reads:
//
//   cd supabase/tests/pglite && npm i --no-save @electric-sql/pglite@0.2 && node 118_account_deletion.test.mjs
//
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const M118 = fs.readFileSync(path.join(HERE, '../../migrations/118_account_deletion.sql'), 'utf8')
const db = new PGlite()
let fails = 0
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++ }
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0])[0]
const throws = async (sql, p, re) => { try { await db.query(sql, p); ok(false, `expected error ${re}`) } catch (e) { ok(re.test(e.message), `rejects: ${e.message}`) } }

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid primary key);
CREATE TABLE public.profiles (id uuid primary key references auth.users(id) on delete cascade, display_name text not null default '',
  phone text, tag text, transaction_pin_hash text, kyc_status text default 'verified');
CREATE TABLE public.wallets (user_id uuid unique, naira_balance_kobo bigint not null default 0, usdc_balance_micro bigint not null default 0,
  cngn_pool_micro bigint not null default 0);
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid references public.profiles(id) on delete cascade, amount_kobo bigint);
CREATE TABLE public.savings_goals (user_id uuid, status text, saved_naira_kobo bigint default 0, saved_usdc_micro bigint default 0);
CREATE TABLE public.savings_locks (user_id uuid, status text);
CREATE TABLE public.loans (user_id uuid, status text);
CREATE TABLE public.esusu_groups (id uuid primary key default gen_random_uuid(), status text);
CREATE TABLE public.esusu_members (group_id uuid, user_id uuid);
CREATE TABLE public.coop_members (user_id uuid, status text);
CREATE TABLE public.portfolio_holdings (user_id uuid, shares numeric);
CREATE TABLE public.flexible_pool_positions (user_id uuid, cngn_deposited_micro bigint);
CREATE TABLE public.p2p_transfers (sender_id uuid, status text);
CREATE TABLE public.pawa_orders (seller_id uuid, buyer_id uuid, status text);
CREATE TABLE public.push_subscriptions (user_id uuid, endpoint text);
`)
await db.exec(M118)
await db.exec(M118) // applying twice must be safe
console.log('migration applied (twice)')

const U = '00000000-0000-4000-8000-00000000000a'
await db.query('insert into auth.users values ($1)', [U])
await db.query("insert into profiles (id, display_name, phone, tag, transaction_pin_hash) values ($1, 'Ada Obi', '0803', 'ada', 'hash')", [U])
await db.query('insert into wallets (user_id, cngn_pool_micro) values ($1, 5000000)', [U]) // ₦5
await db.query('insert into transactions (user_id, amount_kobo) values ($1, 500000)', [U])
await db.query("insert into push_subscriptions values ($1, 'https://push')", [U])
const G = (await db.query("insert into esusu_groups (status) values ('active') returning id")).rows[0].id
await db.query('insert into esusu_members values ($1, $2)', [G, U])
await db.query("insert into loans values ($1, 'active')", [U])

const blockers = async () => await val('select account_deletion_blockers($1)', [U])
let b = await blockers()
ok(b.length === 3 && b.includes('Withdraw your wallet balance') && b.includes('Repay your loan') && b.includes('Leave or finish your Ajo circles'),
  `lists what is still open: ${b.join(' | ')}`)
await throws('select delete_account($1)', [U], /account not empty/)

// Clear each one; dust under ₦1 does not block.
await db.query('update wallets set cngn_pool_micro = 400000 where user_id = $1', [U]) // ₦0.40
await db.query("update loans set status = 'repaid'")
await db.query("update esusu_groups set status = 'completed'")
b = await blockers()
ok(b.length === 0, 'clear once the wallet is empty (dust under ₦1 ignored), the loan repaid and the circle finished')

// Each other blocker is detected.
const cases = [
  ["insert into savings_goals values ($1, 'active', 0, 10)", 'Withdraw or close your savings goals'],
  ["insert into savings_locks values ($1, 'matured')", 'Withdraw your locked savings'],
  ["insert into coop_members values ($1, 'active')", 'Leave your cooperatives'],
  ['insert into portfolio_holdings values ($1, 0.5)', 'Sell your investments'],
  ['insert into flexible_pool_positions values ($1, 1)', 'Withdraw from the flexible savings pool'],
  ["insert into p2p_transfers values ($1, 'pending')", 'Cancel or wait for your unclaimed transfers'],
  ["insert into pawa_orders values ($1, null, 'paid')", 'Finish your open Pay with Pawa orders'],
]
for (const [sql, msg] of cases) {
  await db.query(sql, [U])
  b = await blockers()
  ok(b.length === 1 && b[0] === msg, `detects: ${msg}`)
  await db.exec('delete from savings_goals; delete from savings_locks; delete from coop_members; delete from portfolio_holdings; delete from flexible_pool_positions; delete from p2p_transfers; delete from pawa_orders;')
}
await db.query("insert into savings_goals values ($1, 'completed', 0, 10)", [U])
await db.query("insert into coop_members values ($1, 'left')", [U])
ok((await blockers()).length === 0, 'finished goals and cooperatives already left do not block')

const r = await val('select delete_account($1, $2)', [U, 'moving abroad'])
ok(r.ok === true && r.already === false, 'deletes once clear')
const p = (await db.query('select * from profiles where id = $1', [U])).rows[0]
ok(p.display_name === 'Deleted user' && p.phone === null && p.tag === null && p.transaction_pin_hash === null && p.deleted_at !== null,
  'profile anonymised: name, phone, tag and PIN removed; marked deleted')
ok(p.deletion_reason === 'moving abroad', 'reason recorded')
ok(Number(await val('select count(*) from transactions where user_id = $1', [U])) === 1, 'financial records are kept')
ok(Number(await val('select count(*) from push_subscriptions where user_id = $1', [U])) === 0, 'push subscriptions removed')
const again = await val('select delete_account($1)', [U])
ok(again.ok === true && again.already === true, 'a second call is a harmless no-op')

const grants = await val("select string_agg(grantee, ',' order by grantee) from information_schema.routine_privileges where routine_name = 'delete_account'")
ok(!/authenticated|anon/.test(grants || ''), `not callable by app users (granted to: ${grants})`)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
