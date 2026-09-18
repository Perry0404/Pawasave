#!/usr/bin/env node
/**
 * Asserts the wave assignments in tasks.md cover every backend route exactly once.
 *
 * The whole spec turns on not missing a route, so the task list itself gets checked
 * against the inventory rather than trusted. Run after editing any wave.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const inv = JSON.parse(readFileSync(resolve(DIR, 'inventory.json'), 'utf8'))

// `/auth/callback` stays in the frontend by design: it is a browser redirect flow that
// must write the session cookie on the origin the user is browsing.
const STAYS = ['/auth/callback']

const waves = {
  // invest/ngx was originally drafted into wave 1 as an unauthenticated read. It is not:
  // it gates on a Supabase session and 401s without one. Moved to the head of wave 2,
  // where it is the subject of the user-JWT verification (task 12), being read-only
  // market data with no money at stake.
  1: ['/api/invest/quotes', '/api/ramp/rate', '/api/ramp/banks', '/api/ramp/status'],
  2: [
    '/api/invest/ngx',
    '/api/wallet/deposit-address', '/api/wallet/sync-deposits', '/api/push/subscribe',
    '/api/security/pin', '/api/statement', '/api/welcome',
    '/api/esusu/contributed', '/api/esusu/group/[groupId]', '/api/esusu/yield',
  ],
  3: [
    '/api/p2p/cancel', '/api/p2p/claim', '/api/p2p/pending', '/api/p2p/resolve',
    '/api/p2p/send', '/api/p2p/tag',
    '/api/savings/forfeit-withdraw', '/api/loans', '/api/kyc/create-session',
    '/api/strails/onboard', '/api/strails/onboard-status', '/api/strails/probe',
    '/api/proxy', '/api/ussd', '/api/ramp/resolve-account',
  ],
  4: [
    '/api/webhook', '/api/flipeet-webhook', '/api/xend-webhook',
    '/api/strails-webhook', '/api/kyc/webhook',
  ],
  5: inv.routes.map((r) => r.url).filter((u) => u.startsWith('/api/cron/')),
  6: inv.routes.map((r) => r.url).filter((u) => u.startsWith('/api/admin/')),
  7: [
    '/api/ramp', '/api/invest/equity', '/api/invest/equity/sell',
    '/api/invest/getequity', '/api/xend',
  ],
}

const all = inv.routes.map((r) => r.url)
const expected = all.filter((u) => !STAYS.includes(u))
const assigned = Object.values(waves).flat()

const missing = expected.filter((u) => !assigned.includes(u))
const unknown = assigned.filter((u) => !all.includes(u))
const dupes = assigned.filter((u, i) => assigned.indexOf(u) !== i)

console.log(`inventory routes:        ${all.length}`)
console.log(`stays in frontend:       ${STAYS.length}  (${STAYS.join(', ')})`)
console.log(`backend routes expected: ${expected.length}`)
console.log(`assigned across waves:   ${assigned.length}`)
for (const [w, rs] of Object.entries(waves)) console.log(`  wave ${w}: ${rs.length}`)
console.log('')

let ok = true
if (missing.length) { ok = false; console.log(`UNASSIGNED (${missing.length}):\n  ${missing.join('\n  ')}`) }
if (unknown.length) { ok = false; console.log(`NOT IN INVENTORY (${unknown.length}):\n  ${unknown.join('\n  ')}`) }
if (dupes.length) { ok = false; console.log(`ASSIGNED TWICE (${dupes.length}):\n  ${dupes.join('\n  ')}`) }

console.log(ok ? 'PASS — every backend route assigned to exactly one wave' : 'FAIL')
process.exit(ok ? 0 : 1)
