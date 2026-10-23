// 120_fixed_savings_v2.test.mjs
//
// Behaviour test for migration 120 (Fixed Savings v2: no early exit, automatic payout,
// rate capped by the backing asset, loans against it held to maturity) against an in-memory Postgres (PGlite):
//
//   cd supabase/tests/pglite && npm i --no-save @electric-sql/pglite@0.2 && node 120_fixed_savings_v2.test.mjs
//
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const M120 = fs.readFileSync(path.join(HERE, '../../migrations/120_fixed_savings_v2.sql'), 'utf8')
const db = new PGlite()
let fails = 0
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++ }
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0])[0]
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const throws = async (sql, p, re, msg) => {
  try { await db.query(sql, p); ok(false, msg + ' (did not raise)') }
  catch (e) { ok(re.test(e.message), msg + (re.test(e.message) ? '' : ` (raised: ${e.message})`)) }
}

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.platform_settings (key text primary key, value text);
INSERT INTO public.platform_settings VALUES ('platform_revenue_kobo','0');
CREATE TABLE public.profiles (id uuid primary key, kyc_status text default 'verified');
CREATE TABLE public.wallets (user_id uuid unique, usdc_balance_micro bigint not null default 0,
  cngn_pool_micro bigint not null default 0, updated_at timestamptz,
  CONSTRAINT wallets_balances_nonneg CHECK (usdc_balance_micro >= 0 AND cngn_pool_micro >= 0));
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, direction text,
  amount_kobo bigint, amount_usdc_micro bigint, description text, reference text, status text default 'completed', metadata jsonb,
  created_at timestamptz default now());
CREATE UNIQUE INDEX transactions_reference_uniq ON public.transactions(reference) WHERE reference IS NOT NULL;
CREATE TABLE public.revenue_journal (id bigserial primary key, user_id uuid not null, transaction_id uuid,
  revenue_type text not null, amount_usdc_micro bigint not null, description text, created_at timestamp default now());
CREATE TABLE public.platform_fees (id bigserial primary key, user_id uuid, transaction_ref text, fee_type text, gross_amount_kobo bigint,
  fee_amount_kobo bigint, fee_percent numeric, created_at timestamptz default now());
CREATE TABLE public.savings_locks (id uuid primary key default gen_random_uuid(), user_id uuid, amount_usdc_micro bigint, amount_kobo bigint,
  apy_percent numeric, duration_days int, projected_interest_micro bigint, effective_rate_at_creation numeric,
  locked_at timestamptz default now(), unlocks_at timestamptz, status text default 'active', matured_at timestamptz, withdrawn_at timestamptz,
  user_consent_accepted boolean, consent_accepted_at timestamptz, pledged_loan_id uuid, created_at timestamptz default now());
CREATE TABLE public.loans (id uuid primary key default gen_random_uuid(), user_id uuid, principal_micro bigint, apr_percent numeric,
  origination_fee_micro bigint, accrued_interest_micro bigint default 0, due_date timestamptz, agreement_version text, status text default 'active',
  last_accrued_at timestamptz default now(), closed_at timestamptz);
CREATE TABLE public.loan_collateral (loan_id uuid, asset_type text, asset_ref text, pledged_value_micro bigint, ltv_percent numeric);
CREATE TABLE public.portfolio_holdings (id uuid primary key default gen_random_uuid(), user_id uuid, symbol text, shares numeric,
  asset_type text, pledged_loan_id uuid, invested_cngn_micro bigint default 0, updated_at timestamptz);
CREATE TABLE public.equity_prices (symbol text, price_ngn_micro bigint, updated_at timestamptz);
CREATE FUNCTION public._loan_setting(k text, d numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT d $$;
CREATE FUNCTION public._loan_equity_value(u uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE FUNCTION public._loan_rwa_value(u uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
`)
await db.exec(M120)
await db.exec(M120) // applying twice must be safe
console.log('migration applied (twice)')

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
const [SAVER, OTHER, OLDLOCK] = [1, 2, 3].map(U)
for (const u of [SAVER, OTHER, OLDLOCK]) {
  await db.query('insert into profiles (id) values ($1)', [u])
  await db.query('insert into wallets (user_id, cngn_pool_micro) values ($1, $2)', [u, 500_000_000_000]) // ₦500k
}
const set = (k, v) => db.query('update platform_settings set value = $2 where key = $1', [k, String(v)])
const lock = (u, amt, days, consent = true) => db.query('select lock_savings_v2($1,$2,$3,$4) as id', [u, amt, days, consent])
const N100K = 100_000_000_000

// ── opening: stays shut until the backing earns enough for 20% ──
ok(await val("select value from platform_settings where key = 'fixed_v2_user_apy_percent'") === '20', 'the default saver rate is 20%')
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 180, true], /coming soon/, 'refused while fixed_v2_enabled is off')
await set('fixed_v2_enabled', 'true')
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 180, true], /not open right now/,
  'refused while the backing rate is unknown (sync has not run): never quote a rate the asset does not earn')
await set('fixed_v2_backing_apy_percent', 14.5)
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 180, true], /not open right now/,
  'stays shut on gNTB at 14.5%: 20% needs a backing asset earning at least 21.5%')
await set('fixed_v2_backing_apy_percent', 21)
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 180, true], /not open right now/, 'still shut at 21% (below the 1.5% spread)')
await set('fixed_v2_backing_apy_percent', 23)
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 180, false], /cannot be withdrawn/, 'refused without consent')
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 45, true], /not an offered term/, 'refused for a term that is not offered')
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, 500_000_000, 180, true], /Minimum/, 'refused below the ₦1,000 minimum')
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, 900_000_000_000, 180, true], /Insufficient/, 'refused above the savings balance')

await db.exec(`SET request.jwt.claim.sub = '${OTHER}'`)
await throws('select lock_savings_v2($1,$2,$3,$4)', [SAVER, N100K, 180, true], /unauthorized/, 'one user cannot open a lock on another user\'s money')
await db.exec(`RESET request.jwt.claim.sub`)

const id = (await lock(SAVER, N100K, 180)).rows[0].id
const L = await one('select * from savings_locks where id = $1', [id])
const expectInterest = Math.floor(N100K * 20 / 100 * 180 / 365)
ok(L.version === 2 && L.breakable === false, 'opens once a 23% asset backs it; the lock is v2 and not breakable')
ok(Number(L.projected_interest_micro) === expectInterest, `interest fixed at signup: 20% for 180 days = ₦${expectInterest / 1e6}`)
ok(L.backing_token?.startsWith('0x0BBD') && Number(L.backing_apy_percent) === 23, 'the lock records its backing asset and that asset\'s rate')
ok(Number(await val('select cngn_pool_micro from wallets where user_id = $1', [SAVER])) === 400_000_000_000, 'the savings pool is debited ₦100k')

// ── no early exit ──
await throws('select withdraw_lock($1,$2,true)', [SAVER, id], /locked until/, 'early withdrawal is refused')
await throws('select withdraw_lock($1,$2,false)', [SAVER, id], /locked until/, 'a normal withdrawal before maturity is refused')
await db.query("update savings_locks set unlocks_at = now() - interval '1 minute' where id = $1", [id])
await throws('select withdraw_lock($1,$2,false)', [SAVER, id], /pays out automatically/, 'even after maturity a v2 lock is never withdrawn by hand (the payout job does it)')
await db.query("update savings_locks set unlocks_at = now() + interval '180 days' where id = $1", [id])

// v1 locks still behave as before (the early path is unchanged for them)
await db.query(`insert into savings_locks (id, user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days, projected_interest_micro, unlocks_at)
  values ('00000000-0000-4000-8000-0000000000aa', $1, 10000000000, 1000000, 20, 90, 0, now() + interval '90 days')`, [OLDLOCK])
ok(await val("select withdraw_lock($1, '00000000-0000-4000-8000-0000000000aa', true)", [OLDLOCK]) === true, 'a v1 lock can still be broken early (unchanged)')

// ── borrowing against it: held, never sold ──
// ₦70k loan (70% LTV) against the ₦100k lock, already overdue past the grace period.
const LOAN = '00000000-0000-4000-8000-0000000000bb'
await db.query(`insert into loans (id, user_id, principal_micro, apr_percent, origination_fee_micro, due_date, agreement_version, last_accrued_at)
  values ($1, $2, 70000000000, 24, 0, now() - interval '30 days', 'v1', now())`, [LOAN, SAVER])
await db.query('update savings_locks set pledged_loan_id = $1 where id = $2', [LOAN, id])
const liq = await val('select liquidate_overdue_loans()')
const heldLock = await one('select status, pledged_loan_id from savings_locks where id = $1', [id])
ok(liq.held_to_maturity === 1 && liq.liquidated === 0, 'an overdue loan covered by the fixed savings is held, not liquidated')
ok(heldLock.status === 'active' && heldLock.pledged_loan_id === LOAN, 'the lock is not seized or broken; it stays pledged until maturity')
ok(await val('select status from loans where id = $1', [LOAN]) === 'active', 'the loan stays open and keeps accruing interest')

// Mixed collateral that the lock alone does not cover: the stock is seized, the lock is held.
const MIX = '00000000-0000-4000-8000-0000000000cc', MIXLOCK = '00000000-0000-4000-8000-0000000000cd'
await db.query(`insert into loans (id, user_id, principal_micro, apr_percent, origination_fee_micro, due_date, agreement_version, last_accrued_at)
  values ($1, $2, 30000000000, 24, 0, now() - interval '30 days', 'v1', now())`, [MIX, OTHER])
await db.query(`insert into savings_locks (id, user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days, projected_interest_micro,
  unlocks_at, version, breakable, pledged_loan_id) values ($1, $2, 10000000000, 1000000, 20, 90, 0, now() + interval '60 days', 2, false, $3)`, [MIXLOCK, OTHER, MIX])
await db.query(`insert into portfolio_holdings (user_id, symbol, shares, asset_type, invested_cngn_micro, pledged_loan_id)
  values ($1, 'MTNN', 100, 'tokenized_stock', 25000000000, $2)`, [OTHER, MIX])
await val('select liquidate_overdue_loans()')
const mix = await one('select status, principal_micro, accrued_interest_micro from loans where id = $1', [MIX])
ok(await val('select status from savings_locks where id = $1', [MIXLOCK]) === 'active', 'with mixed collateral the fixed savings is still held')
ok(mix.status === 'active' && Number(mix.principal_micro) + Number(mix.accrued_interest_micro) <= 5_000_000_000 + 1_000_000,
  'the stock is seized and pays down the debt; the loan stays open for the lock to settle at maturity')

// ── automatic payout ──
const none = await val('select mature_fixed_locks()')
ok(none.paid.length === 0, 'nothing is paid before maturity')
await db.query("update savings_locks set unlocks_at = now() - interval '1 minute' where id = $1", [id])
const spendBefore = Number(await val('select usdc_balance_micro from wallets where user_id = $1', [SAVER]))
const revBefore = Number(await val("select value from platform_settings where key = 'platform_revenue_kobo'"))
const run = await val('select mature_fixed_locks()')
const spendAfter = Number(await val('select usdc_balance_micro from wallets where user_id = $1', [SAVER]))
const p = run.paid[0]
ok(run.paid.length === 1 && p.lock_id === id, 'the matured lock is paid out')
const owed = Number(p.loan_repaid_micro)
ok(owed >= 70_000_000_000 && owed < 70_100_000_000, 'the payout repays the loan first (₦70k + interest)')
ok(spendAfter - spendBefore === N100K + expectInterest - owed, 'the rest of principal + interest lands in the spendable balance')
ok(await val('select status from loans where id = $1', [LOAN]) === 'repaid', 'the loan is closed as repaid')
const after = await one('select status, paid_out_at, payout_reference, pledged_loan_id from savings_locks where id = $1', [id])
ok(after.status === 'withdrawn' && after.paid_out_at && after.payout_reference === `lock-payout-${id}` && after.pledged_loan_id === null,
  'the lock is closed, released and stamped with the payout')
ok(await val("select count(*)::int from transactions where reference = $1", [`lock-payout-${id}`]) === 1, 'one ledger credit, with a unique reference')
ok(await val("select count(*)::int from transactions where reference = $1 and type = 'loan_repayment'", [`lock-loan-${id}`]) === 1, 'and one loan-repayment debit')
const expectSpread = Math.floor(N100K * (23 - 20) / 100 * 180 / 365)
ok(Number(await val("select coalesce(sum(amount_usdc_micro),0) from revenue_journal where revenue_type = 'yield_spread'")) === expectSpread,
  `the spread (23% - 20% over 180 days = ₦${expectSpread / 1e6}) is booked as revenue`)
ok(Number(await val("select value from platform_settings where key = 'platform_revenue_kobo'")) - revBefore >= Math.floor(expectSpread / 10000),
  'spread and loan interest are added to platform revenue')

const again = await val('select mature_fixed_locks()')
ok(again.paid.length === 0 && Number(await val('select usdc_balance_micro from wallets where user_id = $1', [SAVER])) === spendAfter,
  'running the payout again pays nothing (no double payout)')

await db.exec(`SET ROLE authenticated`)
await throws('select mature_fixed_locks()', [], /permission denied/, 'a customer cannot trigger payouts')
await db.exec(`RESET ROLE`)

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
