// 119_compliance.test.mjs
//
// Behaviour test for migration 119 (compliance monitoring and holds) against an in-memory
// Postgres (PGlite) with a minimal stub of the tables it reads:
//
//   cd supabase/tests/pglite && npm i --no-save @electric-sql/pglite@0.2 && node 119_compliance.test.mjs
//
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const M119 = fs.readFileSync(path.join(HERE, '../../migrations/119_compliance.sql'), 'utf8')
const db = new PGlite()
let fails = 0
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++ }
const val = async (sql, p = []) => Object.values((await db.query(sql, p)).rows[0])[0]
const rows = async (sql, p = []) => (await db.query(sql, p)).rows

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.platform_settings (key text primary key, value text);
CREATE TABLE public.profiles (id uuid primary key, display_name text default '', kyc_status text default 'pending',
  strails_va_account_number text, pin_failed_attempts int not null default 0, pin_locked_until timestamptz,
  created_at timestamptz not null default now() - interval '90 days');
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, direction text,
  amount_kobo bigint not null, status text default 'completed', created_at timestamptz default now());
CREATE TABLE public.p2p_transfers (sender_id uuid, recipient_id uuid, recipient_email text, created_at timestamptz default now());
`)
await db.exec(M119)
await db.exec(M119) // applying twice must be safe
console.log('migration applied (twice)')

const U = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`
const [NORMAL, MULE, SPLITTER, NEWBIE, WHALE, FANOUT, LOCKED, VELO] = [1, 2, 3, 4, 5, 6, 7, 8].map(U)
for (const u of [NORMAL, MULE, SPLITTER, WHALE, FANOUT, LOCKED, VELO]) await db.query('insert into profiles (id) values ($1)', [u])
await db.query("insert into profiles (id, created_at) values ($1, now() - interval '2 days')", [NEWBIE])
const tx = (u, type, naira, status = 'completed') => db.query('insert into transactions (user_id, type, amount_kobo, status) values ($1,$2,$3,$4)', [u, type, Math.round(naira * 100), status])

await tx(NORMAL, 'deposit', 15000); await tx(NORMAL, 'withdrawal', 4000)            // ordinary saver
await tx(MULE, 'deposit', 300000); await tx(MULE, 'withdrawal', 290000)             // in and straight out
for (let i = 0; i < 3; i++) await tx(SPLITTER, 'deposit', 19500)                     // just under ₦20k, 3x
await tx(NEWBIE, 'deposit', 600000)                                                   // big money, 2-day-old account
await tx(WHALE, 'deposit', 5200000)                                                   // over ₦5m in a day
for (let i = 0; i < 16; i++) await db.query('insert into p2p_transfers (sender_id, recipient_email) values ($1,$2)', [FANOUT, `r${i}@x.com`])
await db.query("update profiles set pin_locked_until = now(), pin_failed_attempts = 5 where id = $1", [LOCKED])
for (let i = 0; i < 11; i++) await tx(VELO, 'deposit', 1000)
await tx(NORMAL, 'withdrawal', 2000000, 'failed')                                     // failed tx is ignored

const opened = await val('select compliance_scan()')
const flags = await rows('select user_id, rule, severity from compliance_flags order by user_id, rule')
const has = (u, rule) => flags.some((f) => f.user_id === u && f.rule === rule)
const status = async (u) => val('select compliance_status from profiles where id = $1', [u])

ok(!flags.some((f) => f.user_id === NORMAL), 'an ordinary saver is not flagged (and a failed transaction is ignored)')
ok(has(MULE, 'pass_through'), 'money in and straight out again is flagged as pass-through (high)')
ok(has(SPLITTER, 'structuring'), 'three deposits just under the ₦20,000 tier are flagged as structuring (high)')
ok(has(NEWBIE, 'new_account_large_inflow'), 'a large inflow into a 2-day-old account is flagged')
ok(has(WHALE, 'ctr_threshold') && has(WHALE, 'large_transaction'), 'over ₦5m in a day raises a CTR flag and a large-transaction flag')
ok(has(FANOUT, 'p2p_fan_out'), 'paying 16 different people in a day is flagged as fan-out')
ok(has(LOCKED, 'pin_lockout'), 'a PIN lockout is flagged (low)')
ok(has(VELO, 'velocity'), 'eleven deposits in a day is flagged for velocity')

ok(await status(MULE) === 'review' && await status(SPLITTER) === 'review' && await status(WHALE) === 'review', 'high flags put the account on review automatically')
ok(await status(NEWBIE) === 'clear' && await status(VELO) === 'clear' && await status(LOCKED) === 'clear', 'medium and low flags do not hold the account')
ok(Number(await val("select count(*) from compliance_actions where action = 'auto_review'")) === 3, 'each automatic hold is written to the audit log')

const again = await val('select compliance_scan()')
ok(Number(again) === 0 && Number(await val('select count(*) from compliance_flags')) === flags.length, `running the scan again opens no duplicates (first run opened ${opened})`)

// An admin clears an account: it is not re-held by today's existing flag.
await db.query("update profiles set compliance_status = 'clear' where id = $1", [MULE])
await db.query("update compliance_flags set status = 'actioned' where user_id = $1", [MULE])
await val('select compliance_scan()')
ok(await status(MULE) === 'clear', 'an account cleared by an admin is not put back on hold by the same day\'s flag')

const m = await val('select compliance_metrics()')
ok(m.users_in_review === 2 && m.flags_open_high === 2 && m.users_total === 8, `metrics: ${m.users_in_review} in review, ${m.flags_open_high} open high flags, ${m.users_total} users`)

// Thresholds are tunable without a release.
await db.query("update platform_settings set value = '10000000' where key = 'compliance_large_tx_kobo'") // ₦100,000
await tx(NORMAL, 'deposit', 150000)
await val('select compliance_scan()')
ok((await rows("select 1 from compliance_flags where user_id = $1 and rule = 'large_transaction'", [NORMAL])).length === 1, 'lowering a threshold in platform_settings takes effect on the next scan')

// A customer session cannot clear its own hold.
await db.query("update profiles set compliance_status = 'review' where id = $1", [NORMAL])
await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)")
let blocked = false
try { await db.query("update profiles set compliance_status = 'clear' where id = $1", [NORMAL]) } catch (e) { blocked = /only be changed/.test(e.message) }
await db.exec("select set_config('request.jwt.claim.role', '', false)")
ok(blocked && await status(NORMAL) === 'review', 'a customer cannot clear their own hold (database guard)')
await db.query("update profiles set compliance_status = 'clear' where id = $1", [NORMAL])
ok(await status(NORMAL) === 'clear', 'the server (service role) can clear it')

const grants = await val("select string_agg(grantee, ',' order by grantee) from information_schema.routine_privileges where routine_name = 'compliance_scan'")
ok(!/authenticated|anon/.test(grants || ''), `scan not callable by app users (granted to: ${grants})`)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
