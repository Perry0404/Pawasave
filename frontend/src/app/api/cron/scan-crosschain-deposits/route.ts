import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'
import { runCrossChainDeposits } from '@/lib/crosschain-deposit'

/**
 * GET /api/cron/scan-crosschain-deposits
 *
 * Scans each enabled source chain for inbound USDC/USDT to users' HD deposit addresses,
 * then sweeps + places a HyperFX cross-chain intent (source token → cNGN on Base) and credits
 * the user. Dark until CROSSCHAIN_DEPOSIT_ENABLED=true + CROSSCHAIN_DEPOSIT_CHAINS is set.
 * Protected by CRON_SECRET. Intended to run every ~3–5 min per the host crontab.
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 300 // cross-chain fills can take minutes

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }
  try {
    const result = await runCrossChainDeposits()
    return NextResponse.json({ ok: true, ...result })
  } catch (e: unknown) {
    console.error('[scan-crosschain-deposits] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'error' }, { status: 500 })
  }
}
