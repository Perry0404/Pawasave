import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { sweepDeposits } from '@/lib/deposit-sweep'

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
    return NextResponse.json({ ok: true, ...res, reconcile })
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('[sweep-deposits] error:', e?.message || err)
    return NextResponse.json({ error: e?.message || 'sweep failed' }, { status: 500 })
  }
}