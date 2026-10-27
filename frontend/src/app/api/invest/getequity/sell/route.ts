import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { GETEQUITY_ENABLED, GETEQUITY_MIN_UNITS, quoteSell, sellAsset } from '@/lib/getequity'
import { withLease } from '@/lib/custody-lease'
import { complianceBlock } from '@/lib/compliance'

/**
 * POST /api/invest/getequity/sell   { symbol, units? }   (units omitted = sell everything)
 *
 * Sells a GetEquity holding (e.g. the Treasury Bills fund gNTB, the Dangote IPO DPRI) back to
 * GetEquity's Market for cNGN (migration 121):
 *   reserve units (place_getequity_sell) → Market.sell under the custody lease →
 *   settle_getequity_sell (credit proceeds net of fee, or return the units on failure).
 *
 * PawaSave's fee is a share of the GAIN only (GETEQUITY_SELL_GAIN_FEE_BPS, default 345 =
 * 3.45% of the gain, i.e. 0.5 of a 14.5% yield, so a Treasury Bills holder nets 14% a year).
 * No fee when the sale is at or below cost.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const ONE = 10n ** 18n
const GAIN_FEE_BPS = (() => {
  const n = Number(process.env.GETEQUITY_SELL_GAIN_FEE_BPS)
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.floor(n) : 345
})()

async function sessionClient() {
  const store = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } })
}
function serviceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await sessionClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const held = await complianceBlock(user.id, 'invest')
    if (held) return held
    if (!GETEQUITY_ENABLED) return NextResponse.json({ error: 'Selling is not available right now.' }, { status: 503 })

    const body = await request.json().catch(() => ({}))
    const symbol = String(body.symbol || '').trim().toUpperCase()
    if (!symbol) return NextResponse.json({ error: 'Symbol required' }, { status: 400 })

    const admin = serviceClient()
    const { data: holding } = await admin.from('portfolio_holdings')
      .select('shares, pledged_loan_id').eq('user_id', user.id).eq('symbol', symbol)
      .eq('provider', 'getequity').eq('asset_type', 'rwa').maybeSingle()
    const heldUnits = Number(holding?.shares || 0)
    if (!(heldUnits > 0)) return NextResponse.json({ error: 'You do not hold this investment' }, { status: 400 })
    if (holding?.pledged_loan_id) return NextResponse.json({ error: 'This investment is securing a loan. Repay the loan first.' }, { status: 409 })

    const { data: lastBuy } = await admin.from('getequity_orders').select('token')
      .eq('user_id', user.id).eq('symbol', symbol).eq('side', 'buy').eq('status', 'filled')
      .order('id', { ascending: false }).limit(1).maybeSingle()
    const token = lastBuy?.token
    if (!token) return NextResponse.json({ error: 'Could not find this investment on GetEquity' }, { status: 400 })

    // Units to sell, at 6-decimal precision (how holdings are stored), never more than held.
    const wanted = body.units == null || body.units === '' ? heldUnits : Math.min(Number(body.units), heldUnits)
    if (!(wanted > 0)) return NextResponse.json({ error: 'Enter how much to sell' }, { status: 400 })
    const sellingAll = wanted >= heldUnits
    const base = BigInt(Math.floor(wanted * 1e6)) * 10n ** 12n
    if (base <= 0n) return NextResponse.json({ error: 'Amount too small' }, { status: 400 })
    if (!sellingAll && base < GETEQUITY_MIN_UNITS * ONE) {
      return NextResponse.json({ error: `The minimum sale is ${GETEQUITY_MIN_UNITS} units, or sell everything.` }, { status: 400 })
    }
    const units = Number(base) / 1e18

    let quote: bigint
    try { quote = (await quoteSell(token, base)).netPayout }
    catch { return NextResponse.json({ error: 'Could not price this sale right now. Please try again.' }, { status: 502 }) }
    if (quote <= 0n) return NextResponse.json({ error: 'Could not price this sale right now. Please try again.' }, { status: 502 })

    const { data: orderId, error: placeErr } = await supabase.rpc('place_getequity_sell', {
      p_user_id: user.id, p_symbol: symbol, p_units: units, p_quote_micro: quote.toString(),
    })
    if (placeErr || !orderId) {
      const raw = placeErr?.message || ''
      const msg = /insufficient/i.test(raw) ? 'You do not hold that many units'
        : /loan/i.test(raw) ? 'This investment is securing a loan. Repay the loan first.'
        : /function|schema cache|does not exist/i.test(raw) ? 'Selling is being set up. Please try again shortly.'
        : 'Could not place the sale'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    try {
      const { txHash, payoutMicro } = await withLease('custody:signer', () => sellAsset(token, base),
        { holder: `getequity-sell ${symbol}`, waitMs: 25_000 })
      const { data: order } = await admin.from('getequity_orders').select('cost_basis_micro').eq('id', orderId).maybeSingle()
      const cost = BigInt(Math.floor(Number(order?.cost_basis_micro || 0)))
      const gain = payoutMicro - cost
      const fee = gain > 0n ? (gain * BigInt(GAIN_FEE_BPS)) / 10_000n : 0n
      const { error: settleErr } = await admin.rpc('settle_getequity_sell', {
        p_order_id: orderId, p_status: 'filled', p_payout_micro: payoutMicro.toString(), p_fee_micro: fee.toString(), p_tx_hash: txHash,
      })
      if (settleErr) {
        // Sold on-chain but not credited: leave the order pending for manual settlement, never fail it.
        console.error('[invest/getequity/sell] SOLD BUT NOT SETTLED', { orderId, txHash, payout: payoutMicro.toString(), err: settleErr.message })
        return NextResponse.json({ status: 'processing', message: 'Sale complete. Your money is being credited.' }, { status: 202 })
      }
      return NextResponse.json({
        status: 'filled', orderId, symbol, units, txHash,
        proceedsMicro: (payoutMicro - fee).toString(), feeMicro: fee.toString(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'On-chain sale failed'
      await admin.rpc('settle_getequity_sell', { p_order_id: orderId, p_status: 'failed', p_error: msg.slice(0, 500) })
      console.error('[invest/getequity/sell] failed, units returned:', msg)
      return NextResponse.json({ error: 'The sale did not go through. Your investment is unchanged.' }, { status: 502 })
    }
  } catch (err) {
    console.error('[invest/getequity/sell] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
