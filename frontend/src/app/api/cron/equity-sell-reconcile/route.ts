import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { convertUsdcToCngn } from '@/lib/hyperfx'
import { custodyUsdcBalanceFresh } from '@/lib/custody'
import { withLease, LeaseUnavailableError } from '@/lib/custody-lease'
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
export const fetchCache = 'force-no-store' // this route reads a table via GET (see below)

const FLAT_FEE_MICRO = 500_000_000n // ₦500

// Roughly two hours of 10-minute runs. Past this the sale needs a human, see
// equity_sales_needing_attention in migration 074.
const MAX_ATTEMPTS = 12

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },
      // This cron READS a table with a GET (unlike the rpc()-POST crons). Next's App Router
      // caches GET fetches, so without no-store the first empty response (no settling sales
      // yet) gets cached and served forever — the cron would never see later parked sales.
      global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: 'no-store' }) },
    },
  )

  const { data: sales, error } = await admin
    .from('equity_sales')
    .select('id,user_id,symbol,shares,usdc_micro,broker_ref,settle_attempts')
    .eq('status', 'settling')
    .lt('settle_attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) {
    console.error('[equity-sell-reconcile] query error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let settled = 0
  let stillPending = 0
  let gaveUp = 0

  const note = async (id: number, msg: string) => {
    const { data } = await admin.rpc('bump_equity_sell_attempt', { p_sale_id: id, p_error: msg })
    if (typeof data === 'number' && data >= MAX_ATTEMPTS) gaveUp++
  }

  try {
    // One lease for the whole batch. Each conversion signs with custody, so running
    // alongside a buy or an off-ramp means two txs share a nonce.
    await withLease('custody:signer', async (lease) => {
      for (const s of sales ?? []) {
        lease.assertHeld()
        try {
          const usdc = BigInt(s.usdc_micro || 0)
          if (usdc <= 0n) { stillPending++; await note(s.id, 'no usdc recorded on the sale'); continue }

          // Confirm custody still holds the proceeds. Converting a recorded amount that
          // is no longer there spends USDC belonging to another sale or a pending buy.
          const held = await custodyUsdcBalanceFresh()
          if (held < usdc) {
            stillPending++
            await note(s.id, `custody holds ${held} usdc micro, sale recorded ${usdc}`)
            console.warn('[equity-sell-reconcile] custody short of recorded usdc', {
              saleId: s.id, held: held.toString(), recorded: usdc.toString(),
            })
            continue
          }

          const cngnGross = await convertUsdcToCngn(usdc) // retry the leg that missed a solver
          if (cngnGross <= 0n) { stillPending++; await note(s.id, 'no solver on usdc->cngn'); continue }

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
          const msg = e instanceof Error ? e.message : String(e)
          await note(s.id, msg)
          console.warn('[equity-sell-reconcile] still pending', s.id, msg)
        }
      }
    }, { holder: 'equity-sell-reconcile', waitMs: 10_000 })
  } catch (e) {
    if (!(e instanceof LeaseUnavailableError)) throw e
    return NextResponse.json({ ok: true, scanned: sales?.length ?? 0, skipped: e.message })
  }

  return NextResponse.json({ ok: true, scanned: sales?.length ?? 0, settled, stillPending, gaveUp })
}
