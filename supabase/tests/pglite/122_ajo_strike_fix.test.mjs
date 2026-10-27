// 122_ajo_strike_fix.test.mjs — one strike per missed cycle, removal at 4, collected members too.
//   cd supabase/tests/pglite && node 122_ajo_strike_fix.test.mjs
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const M = fs.readFileSync(path.join(HERE, '../../migrations/122_ajo_strike_fix.sql'), 'utf8')
const db = new PGlite()
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const one = async (s, p = []) => (await db.query(s, p)).rows[0]
const val = async (s, p = []) => Object.values((await db.query(s, p)).rows[0])[0]

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.platform_settings (key text primary key, value text);
INSERT INTO public.platform_settings VALUES ('platform_revenue_kobo','0');
CREATE TABLE public.wallets (user_id uuid unique, usdc_balance_micro bigint not null default 0, cngn_pool_micro bigint not null default 0, updated_at timestamptz);
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, direction text,
  amount_kobo bigint, amount_usdc_micro bigint, description text, reference text, status text);
CREATE TABLE public.platform_fees (id bigserial primary key, user_id uuid, transaction_ref text, fee_type text, gross_amount_kobo bigint, fee_amount_kobo bigint, fee_percent numeric);
CREATE TABLE public.esusu_groups (id uuid primary key default gen_random_uuid(), name text, status text default 'active', cycle_period text default 'daily',
  contribution_amount_kobo bigint, current_cycle int default 1, cycle_started_at timestamptz, created_at timestamptz default now(),
  pot_balance_kobo bigint default 0, emergency_pot_kobo bigint default 0);
CREATE TABLE public.esusu_members (id uuid primary key default gen_random_uuid(), group_id uuid, user_id uuid, payout_position int,
  missed_strikes int not null default 0, removed boolean not null default false, removed_at timestamptz, has_collected boolean not null default false,
  amount_owed_kobo bigint not null default 0);
CREATE TABLE public.esusu_contributions (id uuid primary key default gen_random_uuid(), group_id uuid, member_id uuid, cycle_number int, amount_kobo bigint);
CREATE FUNCTION public.process_esusu_payout(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":false}'::jsonb $$;
`)
await db.exec(M); await db.exec(M)
console.log('migration applied (twice)')

const G = (await one(`insert into esusu_groups (name, contribution_amount_kobo, current_cycle, cycle_started_at) values ('Market line', 100000, 3, now() - interval '2 days') returning id`)).id
const users = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004']
for (const u of users) await db.query('insert into wallets (user_id) values ($1)', [u])
const mem = async (u, pos, strikes, collected) => (await one(
  'insert into esusu_members (group_id, user_id, payout_position, missed_strikes, has_collected) values ($1,$2,$3,$4,$5) returning id', [G, u, pos, strikes, collected])).id
const COLLECTOR = await mem(users[0], 1, 38, true)   // paid out, then stopped paying (the 38-strike case)
const NEWBIE = await mem(users[1], 2, 0, false)      // first miss
const THIRD = await mem(users[2], 3, 3, false)       // on 3 strikes: the 4th removes
const PAYER = await mem(users[3], 4, 0, false)
await db.query('update wallets set usdc_balance_micro = 10000000000 where user_id = $1', [users[3]]) // can pay
// The collector paid cycles 1 and 2 before stopping.
await db.query('insert into esusu_contributions (group_id, member_id, cycle_number, amount_kobo) values ($1,$2,1,99500),($1,$2,2,99500)', [G, COLLECTOR])

const r1 = await val('select esusu_autodebit(24)')
const c = await one('select removed, amount_owed_kobo from esusu_members where id = $1', [COLLECTOR])
ok(c.removed === true, 'a member at 38 strikes who already collected is now removed')
ok(Number(c.amount_owed_kobo) === 2 * 100000, 'and recorded as owing what they still had to pay in (4 cycles − 2 paid = ₦2,000)')
ok(r1.events.some((e) => e.action === 'removed' && Number(e.owed_kobo) === 200000), 'the removal event carries the amount owed (for the email)')
ok((await one('select missed_strikes, removed from esusu_members where id = $1', [NEWBIE])).missed_strikes === 1, 'a first miss gives 1 strike')
const t = await one('select missed_strikes, removed from esusu_members where id = $1', [THIRD])
ok(t.missed_strikes === 4 && t.removed === true, 'the 4th strike removes the member')
ok((await one('select missed_strikes from esusu_members where id = $1', [PAYER])).missed_strikes === 0, 'a member with funds is auto-debited, no strike')

// Run again in the SAME cycle (the old bug added a strike every night).
const r2 = await val('select esusu_autodebit(24)')
ok((await one('select missed_strikes from esusu_members where id = $1', [NEWBIE])).missed_strikes === 1, 'running again in the same cycle adds no strike')
ok(!r2.events.some((e) => e.action === 'strike'), 'and sends no new strike email')

// Next cycle: a second strike.
await db.query('update esusu_groups set current_cycle = 4 where id = $1', [G])
await val('select esusu_autodebit(24)')
ok((await one('select missed_strikes from esusu_members where id = $1', [NEWBIE])).missed_strikes === 2, 'a new missed cycle gives the next strike')

// Re-adding a removed member clears the per-cycle marker.
await db.query('update esusu_members set removed = false, missed_strikes = 0 where id = $1', [THIRD])
ok((await one('select last_strike_cycle from esusu_members where id = $1', [THIRD])).last_strike_cycle === null, 're-adding a member clears their strike marker')

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
