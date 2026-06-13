import { NextRequest, NextResponse } from 'next/server'
import { scanAndCredit } from '@/lib/deposit-scan'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/scan-deposits
 *
 * Scans Base for incoming cNGN transfers to every user's deposit address and
 * credits them automatically. Advances the global block cursor each run.
 *
 * Required env vars:
 *   BASE_MAINNET_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL)
 *   DEPOSIT_WALLET_MNEMONIC, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
 *   CRON_SECRET — Vercel cron secret
 */
export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  try {
    const { credited, fromBlock, toBlock, scannedAddresses } = await scanAndCredit()
    return NextResponse.json({
      ok: true,
      credited: credited.length,
      fromBlock,
      toBlock,
      scannedAddresses,
    })
  } catch (e: any) {
    if (/not configured/i.test(e?.message || '')) {
      return NextResponse.json({ ok: true, skipped: true, reason: e.message })
    }
    console.error('[scan-deposits] error:', e)
    return NextResponse.json({ error: e?.message || 'scan failed' }, { status: 500 })
  }
}
