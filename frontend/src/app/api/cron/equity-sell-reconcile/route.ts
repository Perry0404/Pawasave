import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { convertUsdcToCngn } from '@/lib/hyperfx'
import { sendEquitySellEmail } from '@/lib/notify-tx'

/**
 * GET /api/cron/equity-sell-reconcile
 *
 * Finishes stock sells that got stuck between their two legs. A sell is stock→USDC
 * (irreversible) then USDC→cNGN (HyperFX). When the second leg finds no solver in time,
 * the sale is parked 'settling' with the USDC sitting in custody (see sell/route.ts +
 * migration 072) instead of being falsely failed + the shares restored. This cron retries
 * the USDC→cNGN conversion for each settling sale and, on success, settles it 'filled' —
 * crediting the user their cNGN (net of the ₦500 fee) and emailing the receipt. A sale that
 * still can't fill is left 'settling' for the next run; the USDC never leaves custody.
 *
 * Protected by CRON_SECRET. Runs every ~10 min (see vercel.json / ops/cron/crontab).
 */
export const dynamic = 'force-dynamic'

const FLAT_FEE_MICRO = 500_000_000n // ₦500

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const { data: sales, error } = await admin
    .from('equity_sales')
    .select('id,user_id,symbol,shares,usdc_micro,broker_ref')
    .eq('status', 'settling')
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) {
    console.error('[equity-sell-reconcile] query error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let settled = 0
  let stillPending = 0
  for (const s of sales ?? []) {
    try {
      const usdc = BigInt(s.usdc_micro || 0)
      if (usdc <= 0n) { stillPending++; continue }

      const cngnGross = await convertUsdcToCngn(usdc) // retry the leg that missed a solver
      if (cngnGross <= 0n) { stillPending++; continue }

      await admin.rpc('settle_equity_sell', {
        p_sale_id: s.id, p_status: 'filled',
        p_usdc_micro: usdc.toString(),
        p_cngn_gross_micro: cngnGross.toString(),
        p_broker_ref: s.broker_ref,
      })
      settled++
      console.info('[equity-sell-reconcile] settled', { saleId: s.id, symbol: s.symbol, gross: cngnGross.toString() })

      try {
        const netMicro = cngnGross - FLAT_FEE_MICRO
        await sendEquitySellEmail(s.user_id, {
          symbol: s.symbol, shares: Number(s.shares),
          netNgn: Number(netMicro > 0n ? netMicro : 0n) / 1e6,
          feeNgn: Number(FLAT_FEE_MICRO) / 1e6,
          reference: s.broker_ref || `equity_sell_${s.id}`,
        })
      } catch (mailErr) { console.error('[equity-sell-reconcile] email failed:', mailErr) }
    } catch (e: unknown) {
      stillPending++
      console.warn('[equity-sell-reconcile] still pending', s.id, e instanceof Error ? e.message : e)
    }
  }

  return NextResponse.json({ ok: true, scanned: sales?.length ?? 0, settled, stillPending })
}
