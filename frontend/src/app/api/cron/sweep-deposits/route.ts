import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'
import { sweepDeposits } from '@/lib/deposit-sweep'

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

  if (!process.env.DEPOSIT_SWEEP_DESTINATION) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'DEPOSIT_SWEEP_DESTINATION not set' })
  }

  try {
    const res = await sweepDeposits()
    return NextResponse.json({ ok: true, ...res })
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('[sweep-deposits] error:', e?.message || err)
    return NextResponse.json({ error: e?.message || 'sweep failed' }, { status: 500 })
  }
}