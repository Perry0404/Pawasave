// 115_116_savings_coop.test.mjs
//
// Behaviour test for migrations 115 (savings interest) and 116 (cooperatives), run against an
// in-memory Postgres (PGlite) with a minimal stub of the tables they touch. No database needed:
//
//   cd supabase/tests/pglite && npm i --no-save @electric-sql/pglite@0.2 && node 115_116_savings_coop.test.mjs
//
import { PGlite } from '@electric-sql/pglite'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '../../migrations/')
const db = new PGlite()
let fails = 0
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++ }
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const val = async (sql, p = []) => Object.values(await one(sql, p))[0]
const throws = async (sql, p, re) => { try { await db.query(sql, p); ok(false, `expected error ${re}`) } catch (e) { ok(re.test(e.message), `rejects: ${e.message}`) } }

await db.exec(fs.readFileSync(path.join(HERE, 'stub.sql'), 'utf8'))
await db.exec(fs.readFileSync(REPO + '115_savings_rates_v2.sql', 'utf8'))
await db.exec(fs.readFileSync(REPO + '116_cooperatives.sql', 'utf8'))
// Applying twice must be safe.
await db.exec(fs.readFileSync(REPO + '115_savings_rates_v2.sql', 'utf8'))
await db.exec(fs.readFileSync(REPO + '116_cooperatives.sql', 'utf8'))
console.log('migrations applied (twice)')

const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c'
const N = (naira) => BigInt(naira) * 1000000n
for (const u of [A, B, C]) {
  await db.query('insert into auth.users values ($1)', [u])
  await db.query("insert into profiles values ($1, $2, $3)", [u, 'User ' + u.slice(-1), 'u' + u.slice(-1)])
  await db.query('insert into wallets (user_id, usdc_balance_micro) values ($1, $2)', [u, String(N(100000))])
}
const bal = async (u) => BigInt(await val('select usdc_balance_micro from wallets where user_id=$1', [u]))
await db.query("update platform_settings set value='14.5' where key='yield_backing_apy_percent'")

// ── cooperative ──
const cr = await val("select coop_create($1,'Staff Coop','test',$2,'monthly',$3,2)", [A, String(N(5000)), String(N(1000))])
const coop = cr.id
ok(/^[0-9A-F]{7}$/.test(cr.join_code), 'join code ' + cr.join_code)
await val('select coop_join($1,$2)', [B, cr.join_code.toLowerCase()])
await val('select coop_join($1,$2)', [C, cr.join_code])
ok((await val('select coop_join($1,$2)', [C, cr.join_code])).already === true, 'rejoin is a no-op')
ok(Number(await val("select count(*) from coop_charges where coop_id=$1 and status='owing'", [coop])) === 5, '5 charges: 3 dues + 2 entrance')

const p1 = await val("select coop_pay($1,$2,'ref1')", [B, coop])
ok(p1.paid_count === 2 && BigInt(p1.paid_micro) === N(6000), 'B pays dues+entrance ' + JSON.stringify(p1))
ok((await val("select coop_pay($1,$2,'ref1')", [B, coop])).duplicate === true, 'same reference is idempotent')
ok((await val("select coop_pay($1,$2,'ref2')", [B, coop])).reason === 'nothing_owing', 'nothing owing')
ok(await bal(B) === N(94000), 'B debited 6000')

const run1 = await val('select coop_run_dues()')
ok(run1.autopaid_members === 2, 'autopay A and C ' + JSON.stringify(run1))
ok(BigInt(await val('select fund_balance_micro from cooperatives where id=$1', [coop])) === N(17000), 'fund 17000')

// payouts
await throws('select coop_propose_payout($1,$2,$3,$4,$5)', [A, coop, C, String(N(3000)), 'welfare'], /appoint more officers/)
await throws('select coop_propose_payout($1,$2,$3,$4,$5)', [B, coop, C, String(N(3000)), 'welfare'], /only officers/)
await throws('select coop_set_role($1,$2,$3,$4)', [B, coop, C, 'treasurer'], /only the chairman/)
await val('select coop_set_role($1,$2,$3,$4)', [A, coop, B, 'treasurer'])
await throws('select coop_propose_payout($1,$2,$3,$4,$5)', [A, coop, C, String(N(99999)), 'welfare'], /more than the fund/)
const pr = await val('select coop_propose_payout($1,$2,$3,$4,$5)', [A, coop, C, String(N(3000)), 'Welfare for C'])
ok(pr.executed === false, 'needs a second approval')
await throws('select coop_vote_payout($1,$2,true)', [A, pr.id], /already voted/)
await throws('select coop_vote_payout($1,$2,true)', [C, pr.id], /only officers/)
const v = await val('select coop_vote_payout($1,$2,true)', [B, pr.id])
ok(v.executed === true, 'executes on 2nd approval')
ok(await bal(C) === N(100000 - 6000 + 3000), 'C credited 3000')
ok(BigInt(await val('select fund_balance_micro from cooperatives where id=$1', [coop])) === N(14000), 'fund 14000')
ok((await val('select coop_vote_payout($1,$2,true)', [B, pr.id])).reason === 'executed', 'cannot execute twice')

// rejection: 2 officers, need 2 → one no makes it impossible
const pr2 = await val('select coop_propose_payout($1,$2,$3,$4,$5)', [B, coop, B, String(N(1000)), 'Self pay'])
ok((await val('select coop_vote_payout($1,$2,false)', [A, pr2.id])).rejected === true, 'rejected when approvals impossible')

// levy, leave, remove
ok((await val("select coop_raise_levy($1,$2,$3,'End of year party')", [B, coop, String(N(2000))])).members === 3, 'levy on 3')
await throws("select coop_raise_levy($1,$2,$3,'x party')", [C, coop, String(N(2000))], /only officers/)
await throws('select coop_leave($1,$2)', [A, coop], /hand the chair/)
await val('select coop_leave($1,$2)', [C, coop])
ok(Number(await val("select count(*) from coop_charges ch join coop_members m on m.id=ch.member_id where m.user_id=$1 and ch.status='owing'", [C])) === 0, 'leaver owing waived')

// interest
const fundBefore = BigInt(await val('select fund_balance_micro from cooperatives where id=$1', [coop]))
const ai = await val('select accrue_coop_interest()')
const expect = BigInt(Math.floor(Number(fundBefore) * 0.105 / 365))
ok(BigInt(ai.interest_micro) === expect, `coop interest ${ai.interest_micro} == ${expect}`)
ok((await val('select accrue_coop_interest()')).skipped === 'already accrued today', 'coop interest once a day')
ok(BigInt(ai.spread_micro) === BigInt(Math.floor(Number(fundBefore) * 0.04 / 365)), 'coop spread booked')

// new period (relabel the first period so backdated test periods don't collide)
await db.query("update coop_charges set label='2000-01-01' where kind='dues'")
await db.query("update cooperatives set next_dues_at = now() - interval '3 days' where id=$1", [coop])
const run2 = await val('select coop_run_dues()')
ok(run2.periods_raised === 1, 'new period raised')
ok(Number(await val("select count(*) from coop_charges where coop_id=$1 and kind='dues'", [coop])) === 5, '3 first-period + 2 new-period dues')
await db.query("update coop_members set auto_pay=false")
await db.query("update cooperatives set next_dues_at = now() - interval '2 days' where id=$1", [coop])
await val('select coop_run_dues()')
ok(Number(await val("select count(*) from coop_charges where coop_id=$1 and status='owing'", [coop])) === 2, 'autopay off leaves dues owing')

// insufficient
await db.query('update wallets set usdc_balance_micro = $2 where user_id=$1', [B, String(N(10))])
ok((await val("select coop_pay($1,$2,'ref9')", [B, coop])).reason === 'insufficient', 'insufficient balance')

// ── circles: daily interest rides with the pot ──
await db.query("update platform_settings set value='1970-01-01' where key='circle_interest_last_accrued_on'")
const g = await val("insert into esusu_groups (name, owner_id, contribution_amount_kobo, status, pot_balance_kobo, current_cycle) values ('Ajo', $1, 1000000, 'active', 2000000, 0) returning id", [A])
const mA = await val('insert into esusu_members (group_id,user_id,payout_position) values ($1,$2,1) returning id', [g, A])
const mB = await val('insert into esusu_members (group_id,user_id,payout_position) values ($1,$2,2) returning id', [g, B])
await db.query('insert into esusu_contributions (group_id,member_id,cycle_number,amount_kobo) values ($1,$2,0,1000000),($1,$3,0,1000000)', [g, mA, mB])
const ci = await val('select accrue_circle_interest()')
const potInt = BigInt(Math.floor(20000e6 * 0.105 / 365))
ok(BigInt(ci.interest_micro) === potInt, `circle interest ${ci.interest_micro} == ${potInt}`)
const aBefore = await bal(A)
const pay = await val('select process_esusu_payout($1)', [g])
ok(pay.ok && BigInt(pay.interest_micro) === potInt, 'payout includes interest ' + JSON.stringify(pay))
ok(await bal(A) - aBefore === N(20000) + potInt, 'recipient got pot + interest')
ok(BigInt(await val('select interest_accrued_micro from esusu_groups where id=$1', [g])) === 0n, 'interest reset after payout')

const col = await val("insert into esusu_groups (name, owner_id, status, pot_balance_kobo, payout_mode, circle_type, beneficiary_id) values ('Aso', $1, 'active', 500000, 'collection', 'aso_ebi', $2) returning id", [A, C])
await db.query("update platform_settings set value='1970-01-01' where key='circle_interest_last_accrued_on'")
await val('select accrue_circle_interest()')
const cInt = BigInt(await val('select interest_accrued_micro from esusu_groups where id=$1', [col]))
const cBefore = await bal(C)
await val('select circle_settle($1,$2)', [col, A])
ok(await bal(C) - cBefore === N(5000) + cInt && cInt > 0n, 'collection settle pays pot + interest')

// ── goals ──
const goal = await val("insert into savings_goals (user_id,title,saved_usdc_micro,target_usdc_micro,saved_naira_kobo) values ($1,'Laptop',$2,$2,10000000) returning id", [A, String(N(100000))])
const gi = await val('select accrue_goal_interest()')
ok(BigInt(gi.interest_micro) === BigInt(Math.floor(100000e6 * 0.12 / 365)), 'goal interest at 12%')
const gBefore = await bal(A)
await val('select complete_savings_goal($1,$2)', [goal, A])
ok(await bal(A) - gBefore === N(100000) + BigInt(gi.interest_micro), 'goal completes with interest')

// not backed → nothing accrues
await db.query("update platform_settings set value='0' where key='yield_backing_apy_percent'")
await db.query("update platform_settings set value='1970-01-01' where key in ('coop_interest_last_accrued_on','circle_interest_last_accrued_on')")
ok((await val('select accrue_coop_interest()')).skipped === 'not backed', 'coop: no interest when unbacked')
ok((await val('select accrue_circle_interest()')).skipped === 'not backed', 'circle: no interest when unbacked')

ok(Number(await val("select count(*) from transactions where metadata ? 'coop_id'")) >= 4, 'coop transactions recorded')
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED')
process.exit(fails ? 1 : 0)
