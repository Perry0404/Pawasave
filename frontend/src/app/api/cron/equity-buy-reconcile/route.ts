import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { completeEquityBuyFromUsdc } from '@/lib/equity-broker'
import { custodyUsdcBalanceFresh } from '@/lib/custody'
import { withLease, LeaseUnavailableError } from '@/lib/custody-lease'
import { sendEquityBuyEmail } from '@/lib/notify-tx'

/**
 * GET /api/cron/equity-buy-reconcile
 *
 * Finishes stock buys stuck between their two legs. A buy is cNGN into the HyperFX escrow
 * then USDC into the stock. When leg 2 fails the order parks as 'settling' with the USDC in
 * custody (see migration 075) rather than refunding cNGN that has already left. This retries
 * the USDC to stock swap and settles 'filled' on success.
 *
 * The mirror of equity-sell-reconcile. Protected by CRON_SECRET.
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 300

// Roughly two hours of 10-minute runs. Past this the order needs a human, see
// equity_orders_needing_attention in migration 075.
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
      // This cron reads a table with a GET. Next caches GET fetches, so without no-store the
      // first empty response gets cached and later parked orders are never seen.
      global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: 'no-store' }) },
    },
  )

  const { data: orders, error } = await admin
    .from('equity_orders')
    .select('id,user_id,symbol,amount_cngn_micro,usdc_micro,settle_attempts')
    .eq('status', 'settling')
    .lt('settle_attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) {
    console.error('[equity-buy-reconcile] query error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let settled = 0
  let stillPending = 0
  let gaveUp = 0

  const note = async (id: number, msg: string) => {
    const { data } = await admin.rpc('bump_equity_buy_attempt', { p_order_id: id, p_error: msg })
    if (typeof data === 'number' && data >= MAX_ATTEMPTS) gaveUp++
  }

  try {
    // One lease for the batch. completeEquityBuyFromUsdc takes it again per order, which is
    // re-entrant inside this context, so it does not deadlock.
    await withLease('custody:signer', async (lease) => {
      for (const o of orders ?? []) {
        lease.assertHeld()
        try {
          const usdc = BigInt(o.usdc_micro || 0)
          if (usdc <= 0n) { stillPending++; await note(o.id, 'no usdc recorded on the order'); continue }

          // Confirm custody still holds it. Spending a recorded amount that is no longer
          // there takes USDC belonging to another order or a pending sell.
          const held = await custodyUsdcBalanceFresh()
          if (held < usdc) {
            stillPending++
            await note(o.id, `custody holds ${held} usdc micro, order recorded ${usdc}`)
            console.warn('[equity-buy-reconcile] custody short of recorded usdc', {
              orderId: o.id, held: held.toString(), recorded: usdc.toString(),
            })
            continue
          }

          const { brokerRef, shares } = await completeEquityBuyFromUsdc(o.symbol, usdc)

          await admin.rpc('settle_equity_order', {
            p_order_id: o.id, p_status: 'filled',
            p_usdc_micro: usdc.toString(),
            p_shares: shares,
            p_broker_ref: brokerRef,
          })
          settled++
          console.info('[equity-buy-reconcile] settled', { orderId: o.id, symbol: o.symbol, shares })

          try {
            await sendEquityBuyEmail(o.user_id, {
              symbol: o.symbol, shares,
              investedNgn: Number(o.amount_cngn_micro) / 1e6,
              reference: brokerRef || `equity_${o.id}`,
            })
          } catch (mailErr) { console.error('[equity-buy-reconcile] email failed:', mailErr) }
        } catch (e: unknown) {
          stillPending++
          const msg = e instanceof Error ? e.message : String(e)
          await note(o.id, msg)
          console.warn('[equity-buy-reconcile] still pending', o.id, msg)
        }
      }
    }, { holder: 'equity-buy-reconcile', waitMs: 10_000 })
  } catch (e) {
    if (!(e instanceof LeaseUnavailableError)) throw e
    return NextResponse.json({ ok: true, scanned: orders?.length ?? 0, skipped: e.message })
  }

  return NextResponse.json({ ok: true, scanned: orders?.length ?? 0, settled, stillPending, gaveUp })
}
