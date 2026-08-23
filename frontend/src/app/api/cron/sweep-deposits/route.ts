import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { sweepDeposits } from '@/lib/deposit-sweep'
import { supplyToLend, custodyCngnBalance } from '@/lib/custody'
import { acquireSupplyLock, releaseSupplyLock } from '@/lib/supply-lock'

/**
 * Reconcile stale ramp transactions (off-ramp debits that never delivered →
 * fail + refund; on-ramp intents never paid → fail). Folded into this cron so it
 * runs on the existing schedule without adding a new cron entry.
 */
async function reconcileStale(): Promise<unknown> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  try {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )
    const { data } = await admin.rpc('reconcile_stale_transactions', {
      p_user_id: null,
      p_withdrawal_minutes: Number(process.env.WITHDRAWAL_RECONCILE_MINUTES) || 20,
      p_deposit_minutes: Number(process.env.DEPOSIT_RECONCILE_MINUTES) || 90,
    })
    return data
  } catch (e) {
    console.error('[sweep-deposits] reconcile failed:', e)
    return null
  }
}

/**
 * GET /api/cron/sweep-deposits
 *
 * Sweeps cNGN out of the per-user HD deposit addresses into one custody address
 * (DEPOSIT_SWEEP_DESTINATION) so the hot deposit wallets never accumulate user
 * funds — mitigating CRIT-03 (single-mnemonic custody). Runs after the deposit
 * scanner has credited balances; sweeping is independent so it can retry safely.
 *
 * Skips cleanly (no-op) until DEPOSIT_SWEEP_DESTINATION is configured.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const auth = checkCronAuth(request)
  if (auth) return auth

  // Always reconcile stale ramp txs — independent of the sweep.
  const reconcile = await reconcileStale()

  // Sweep always runs now: sweepDeposits() defaults its destination to the custody
  // wallet when DEPOSIT_SWEEP_DESTINATION isn't set, so crypto deposits reach
  // custody (and can fund off-ramps) without extra config.
  try {
    const res = await sweepDeposits()
    // Put custody's idle cNGN to work in PawasaveLend so the pool shows real
    // liquidity/TVL — i.e. it reads as "active". Best-effort: a supply failure must
    // never fail the sweep. NOTE: this shows LIQUIDITY, not earnings — the pool
    // still pays ~0 until it has borrowers. Keeps CUSTODY_POOL_BUFFER_MICRO back
    // as a raw float for instant off-ramps (default 0 = supply everything).
    let pool: Record<string, unknown> = {}
    // Serialise custody→pool supplies (migration 054) so a concurrent cron can't
    // read the same idle balance and double-fire supply(idle) — one would revert.
    const gotLock = await acquireSupplyLock()
    if (!gotLock) {
      pool = { supplied: '0', reason: 'another run holds the custody-supply lock' }
    } else {
      try {
        const buffer   = BigInt(process.env.CUSTODY_POOL_BUFFER_MICRO || '0')
        const bal      = await custodyCngnBalance()
        const toSupply = bal > buffer ? bal - buffer : 0n
        if (toSupply >= 1_000_000n) {
          const { txHash, shares } = await supplyToLend(toSupply)
          pool = { supplied: toSupply.toString(), txHash, shares: shares.toString() }
          console.info('[sweep-deposits] supplied idle custody to pool', pool)
        } else {
          pool = { supplied: '0', reason: 'within buffer or below 1 cNGN' }
        }
      } catch (poolErr: unknown) {
        pool = { error: poolErr instanceof Error ? poolErr.message : String(poolErr) }
        console.warn('[sweep-deposits] pool supply failed:', pool.error)
      } finally {
        await releaseSupplyLock()
      }
    }
    return NextResponse.json({ ok: true, ...res, pool, reconcile })
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('[sweep-deposits] error:', e?.message || err)
    return NextResponse.json({ error: e?.message || 'sweep failed' }, { status: 500 })
  }
}