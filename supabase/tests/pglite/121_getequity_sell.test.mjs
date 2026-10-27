// 121_getequity_sell.test.mjs — selling GetEquity holdings (migration 121) against PGlite.
//   cd supabase/tests/pglite && npm i --no-save @electric-sql/pglite@0.2 && node 121_getequity_sell.test.mjs
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const M = fs.readFileSync(path.join(HERE, '../../migrations/121_getequity_sell.sql'), 'utf8')
const db = new PGlite()
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const val = async (s, p = []) => Object.values((await db.query(s, p)).rows[0])[0]
const one = async (s, p = []) => (await db.query(s, p)).rows[0]
const throws = async (s, p, re, m) => { try { await db.query(s, p); ok(false, m + ' (did not raise)') } catch (e) { ok(re.test(e.message), m + (re.test(e.message) ? '' : ` (${e.message})`)) } }

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.platform_settings (key text primary key, value text);
INSERT INTO public.platform_settings VALUES ('platform_revenue_kobo','0');
CREATE TABLE public.wallets (user_id uuid unique, usdc_balance_micro bigint not null default 0, updated_at timestamptz);
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, direction text,
  amount_kobo bigint, amount_usdc_micro bigint, description text, reference text, status text, metadata jsonb);
CREATE TABLE public.platform_fees (id bigserial primary key, user_id uuid, transaction_ref text, fee_type text, gross_amount_kobo bigint,
  fee_amount_kobo bigint, fee_percent numeric);
CREATE TABLE public.portfolio_holdings (id bigserial primary key, user_id uuid, symbol text, asset_type text, provider text,
  invested_cngn_micro bigint not null default 0, shares numeric not null default 0, pledged_loan_id uuid, updated_at timestamptz,
  unique (user_id, symbol, provider));
CREATE TABLE public.getequity_orders (id bigserial primary key, user_id uuid not null, symbol text not null, token text not null,
  side text not null default 'buy', amount_cngn_micro bigint not null check (amount_cngn_micro > 0), fee_cngn_micro bigint not null default 0,
  units numeric, tx_hash text, status text not null default 'pending', error text, created_at timestamptz default now(), updated_at timestamptz default now());
`)
await db.exec(M); await db.exec(M)
console.log('migration applied (twice)')

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002'
await db.query('insert into wallets (user_id) values ($1),($2)', [A, B])
// A bought 100,000 gNTB units for ₦100,000; B's DPRI is pledged to a loan.
await db.query(`insert into portfolio_holdings (user_id, symbol, asset_type, provider, invested_cngn_micro, shares) values ($1,'GNTB','rwa','getequity',100000000000,100000)`, [A])
await db.query(`insert into getequity_orders (user_id, symbol, token, side, amount_cngn_micro, units, status) values ($1,'GNTB','0x0BBD','buy',100000000000,100000,'filled')`, [A])
await db.query(`insert into portfolio_holdings (user_id, symbol, asset_type, provider, invested_cngn_micro, shares, pledged_loan_id) values ($1,'DPRI','rwa','getequity',5000000000,10,gen_random_uuid())`, [B])

await throws('select place_getequity_sell($1,$2,$3,$4)', [A, 'GNTB', 200000, 1], /insufficient units/, 'cannot sell more units than held')
await throws('select place_getequity_sell($1,$2,$3,$4)', [B, 'DPRI', 10, 5000000000], /securing a loan/, 'cannot sell a holding pledged to a loan')
await db.exec(`SET request.jwt.claim.sub = '${B}'`)
await throws('select place_getequity_sell($1,$2,$3,$4)', [A, 'GNTB', 1000, 1000000000], /unauthorized/, 'cannot sell someone else\'s holding')
await db.exec('RESET request.jwt.claim.sub')

// Sell half: cost basis ₦50,000 reserved, units leave the holding.
const o1 = await val('select place_getequity_sell($1,$2,$3,$4)', [A, 'GNTB', 50000, 57000000000])
let h = await one(`select shares, invested_cngn_micro from portfolio_holdings where user_id = $1 and symbol = 'GNTB'`, [A])
ok(Number(h.shares) === 50000 && Number(h.invested_cngn_micro) === 50000000000, 'half the units and half the cost basis are reserved')
ok(Number(await val('select cost_basis_micro from getequity_orders where id = $1', [o1])) === 50000000000 && await val('select token from getequity_orders where id = $1', [o1]) === '0x0BBD', 'the sell order carries cost basis and token')

// Filled at ₦57,250 (₦7,250 gain); fee = 0.5/14.5 of the gain = ₦250.
await db.query('select settle_getequity_sell($1,$2,$3,$4,$5)', [o1, 'filled', 57250000000, 250000000, '0xhash'])
ok(Number(await val('select usdc_balance_micro from wallets where user_id = $1', [A])) === 57000000000, 'proceeds minus the fee land in the spendable balance (₦57,000)')
ok(Number(await val("select value from platform_settings where key = 'platform_revenue_kobo'")) === 25000, 'the ₦250 fee is booked to revenue')
ok(await val("select count(*)::int from transactions where reference = $1", [`getequity_sell_${o1}`]) === 1, 'one ledger credit with a unique reference')
await db.query('select settle_getequity_sell($1,$2,$3,$4,$5)', [o1, 'filled', 57250000000, 250000000, '0xhash'])
ok(Number(await val('select usdc_balance_micro from wallets where user_id = $1', [A])) === 57000000000, 'settling twice pays once')

// A failed sale returns the units and cost basis.
const o2 = await val('select place_getequity_sell($1,$2,$3,$4)', [A, 'GNTB', 50000, 57000000000])
await db.query('select settle_getequity_sell($1,$2,$3,$4,$5,$6)', [o2, 'failed', null, 0, null, 'market paused'])
h = await one(`select shares, invested_cngn_micro from portfolio_holdings where user_id = $1 and symbol = 'GNTB'`, [A])
ok(Number(h.shares) === 50000 && Number(h.invested_cngn_micro) === 50000000000, 'a failed sale puts the units and cost basis back')
ok(await val('select status from getequity_orders where id = $1', [o2]) === 'failed', 'and the order is marked failed')

await db.exec('SET ROLE authenticated')
await throws('select settle_getequity_sell($1,$2,$3,$4)', [o2, 'filled', 1, 0], /permission denied/, 'a customer cannot settle their own sale')
await db.exec('RESET ROLE')

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
