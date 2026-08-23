import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'
import {
  GETEQUITY_ENABLED, buyWithCngn, quoteSell, custodyAssetBalance, pendingPayout, claimPayout,
} from '@/lib/getequity'
import { custodyCngnBalance } from '@/lib/custody'
import { acquireSupplyLock, releaseSupplyLock } from '@/lib/supply-lock'

/**
 * GET /api/cron/getequity-yield
 *
 * The invisible yield engine — parks idle custody cNGN into GetEquity assets so
 * PawaSave savings earn a real, regulated return while PawasaveLend has no borrow
 * demand producing yield. Users never see the asset layer; they see an APY.
 *
 * PRODUCT ROUTING (per founder): each savings category backs a different asset —
 *   • TERM route  → NTBL (Nigerian Treasury Bill, term)  ← backs Fixed deposit + Goals
 *   • FLEX route  → ARMNGF (ARM money-market fund, redeemable) ← backs Ajo + Flexible
 *
 * MONEY SAFETY:
 *  • Each route NEVER deploys past its own hard cap, and both leave a shared liquid
 *    withdrawal reserve untouched. NTBL is term-locked, so over-deploying would strand
 *    cNGN needed for withdrawals — the cap + reserve prevent that.
 *  • Routes run SEQUENTIALLY and each re-reads the idle balance, so the second route
 *    can't spend cNGN the first already deployed.
 *  • Guarded by the shared custody-supply lock (054) so it can't race the Lend crons.
 *  • DARK by default: does nothing unless GETEQUITY_ENABLED is set AND a route has a
 *    token + a POSITIVE cap. Not scheduled in vercel.json — add it when enabling.
 *
 * Each route per run: (1) claim accrued interest back into custody, then (2) top up
 * toward its cap with deployable idle float.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// TERM (Fixed + Goals) → NTBL. Falls back to the legacy single-token env vars.
const TERM_TOKEN = process.env.GETEQUITY_YIELD_TOKEN_TERM || process.env.GETEQUITY_YIELD_TOKEN || ''
const TERM_CAP   = BigInt(process.env.GETEQUITY_YIELD_TERM_MAX_MICRO || process.env.GETEQUITY_YIELD_MAX_MICRO || '0')
// FLEX (Ajo + Flexible) → ARMNGF (money-market, redeemable on demand).
const FLEX_TOKEN = process.env.GETEQUITY_YIELD_TOKEN_FLEX || ''
const FLEX_CAP   = BigInt(process.env.GETEQUITY_YIELD_FLEX_MAX_MICRO || '0')

const MIN_MICRO     = BigInt(process.env.GETEQUITY_YIELD_MIN_MICRO || '1000000000') // ₦1,000 min deploy
const RESERVE_MICRO = BigInt(process.env.GETEQUITY_YIELD_RESERVE_MICRO || '0')      // liquid withdrawal float to keep

/** Claim interest, then top a single asset toward its cap with deployable idle cNGN. */
async function deployRoute(label: string, token: string, capMicro: bigint): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { label, token, deployedMicro: '0' }

  // 1) Claim accrued interest first — brings cNGN back into custody.
  try {
    if ((await pendingPayout(token)) > 0n) {
      const { txHash } = await claimPayout(token)
      out.claimedTx = txHash
    }
  } catch (e) {
    out.claimError = e instanceof Error ? e.message : String(e)
  }

  // 2) How much is already parked here (what we'd get back selling the position)?
  let parked = 0n
  const bal = await custodyAssetBalance(token)
  if (bal > 0n) parked = (await quoteSell(token, bal)).netPayout

  // Re-read idle each route so a prior route's spend is already reflected.
  const idle = await custodyCngnBalance()
  const room       = capMicro > parked ? capMicro - parked : 0n
  const deployable = idle > RESERVE_MICRO ? idle - RESERVE_MICRO : 0n
  const deploy     = deployable < room ? deployable : room

  out.idleMicro = idle.toString()
  out.parkedMicro = parked.toString()

  if (deploy >= MIN_MICRO) {
    const { txHash, units } = await buyWithCngn(token, deploy)
    out.deployedMicro = deploy.toString()
    out.buyTx = txHash
    out.units = units
  } else {
    out.skipped = 'below min or cap reached'
  }
  return out
}

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  const termOn = Boolean(TERM_TOKEN) && TERM_CAP > 0n
  const flexOn = Boolean(FLEX_TOKEN) && FLEX_CAP > 0n
  if (!GETEQUITY_ENABLED || (!termOn && !flexOn)) {
    return NextResponse.json({ ok: true, skipped: 'getequity yield not configured' })
  }

  if (!(await acquireSupplyLock())) {
    return NextResponse.json({ ok: true, skipped: 'custody-supply lock held' })
  }

  const routes: Record<string, unknown>[] = []
  try {
    // TERM first (Fixed+Goals → NTBL), then FLEX (Ajo+Flexible → ARMNGF). Sequential
    // so the second can't spend what the first deployed.
    if (termOn) routes.push(await deployRoute('term:NTBL', TERM_TOKEN, TERM_CAP))
    if (flexOn) routes.push(await deployRoute('flex:ARMNGF', FLEX_TOKEN, FLEX_CAP))
  } catch (e) {
    routes.push({ error: e instanceof Error ? e.message : String(e) })
  } finally {
    await releaseSupplyLock()
  }

  console.info('[getequity-yield]', routes)
  return NextResponse.json({ ok: true, routes })
}