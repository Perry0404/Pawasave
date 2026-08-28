import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isEquityBrokerLive, equityProvider, sellEquity } from '@/lib/equity-broker'

/**
 * POST /api/invest/equity/sell   { symbol, shares }
 *   Sell held tokenized-stock shares for cNGN. Flow:
 *     KYC → broker-live → min-proceeds guard → place_equity_sell (reserve shares) →
 *     broker sells on-chain (stock → USDC → cNGN) → settle_equity_sell (credit cNGN
 *     NET of the flat ₦500 fee, or restore the shares on failure).
 *   Buying is free; the ₦500 flat fee is charged only here, as platform revenue.
 */
export const dynamic = 'force-dynamic'

const FLAT_FEE_MICRO = 500_000_000n // ₦500

async function getUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return { user, supabase }
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const symbol = String(body.symbol || '').trim().toUpperCase()
    const shares = Number(body.shares)
    const provider = String(body.provider || equityProvider() || 'base_dex')
    if (!symbol) return NextResponse.json({ error: 'Symbol required' }, { status: 400 })
    if (!(shares > 0)) return NextResponse.json({ error: 'Shares must be positive' }, { status: 400 })

    // Same identity rule as buying: Strails BVN onboarding IS the basic verification; Sense
    // is only for lifting withdrawal caps. Accept Sense-verified OR a completed onboarding.
    const { data: profile } = await supabase
      .from('profiles')
      .select('kyc_status, strails_onboard_status, strails_va_account_number')
      .eq('id', user.id)
      .single()
    const identityOk = profile?.kyc_status === 'verified'
      || profile?.strails_onboard_status === 'completed'
      || !!profile?.strails_va_account_number
    if (!identityOk) {
      return NextResponse.json({ error: 'Add your BVN to set up your account, then you can trade.' }, { status: 403 })
    }

    if (!isEquityBrokerLive()) {
      return NextResponse.json({ status: 'coming_soon', message: 'Stock trading is launching soon.' }, { status: 503 })
    }

    // Guard: the on-chain sale is irreversible, so reject up front if the estimated cNGN
    // proceeds can't clear the flat ₦500 fee. Uses the cached equity price (best-effort).
    const { data: priceRow } = await supabase
      .from('equity_prices').select('price_ngn_micro').eq('symbol', symbol).maybeSingle()
    const priceMicro = BigInt(Math.floor(Number(priceRow?.price_ngn_micro) || 0))
    if (priceMicro > 0n) {
      const estMicro = priceMicro * BigInt(Math.floor(shares * 1e6)) / 1_000_000n
      if (estMicro <= FLAT_FEE_MICRO) {
        return NextResponse.json({ error: 'Sale too small — proceeds must exceed the ₦500 fee.' }, { status: 400 })
      }
    }

    // Reserve the shares (atomic decrement + pending sale) via the user's session.
    const { data: saleId, error: placeErr } = await supabase.rpc('place_equity_sell', {
      p_user_id: user.id, p_symbol: symbol, p_provider: provider, p_shares: shares,
    })
    if (placeErr || !saleId) {
      const msg = /insufficient/i.test(placeErr?.message || '') ? 'You don’t hold that many shares' : 'Could not place sell order'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    // Complete the sale in the BACKGROUND and return immediately. The stock→USDC swap +
    // HyperFX USDC→cNGN auction take 1–2 min — longer than the client/proxy HTTP timeout
    // (~100s), which was killing the request mid-flow so settle_equity_sell never ran: the
    // cNGN arrived on-chain but the user was never credited and the ₦500 fee never booked.
    // This long-running self-hosted Node server keeps executing after we respond; the client
    // polls GET for the outcome (filled → credited, or failed → shares restored).
    const admin = serviceClient()
    void (async () => {
      try {
        const sale = await sellEquity(symbol, shares)
        await admin.rpc('settle_equity_sell', {
          p_sale_id: saleId, p_status: 'filled',
          p_usdc_micro: sale.usdcMicro.toString(),
          p_cngn_gross_micro: sale.cngnGrossMicro.toString(),
          p_broker_ref: sale.brokerRef,
        })
        console.info('[invest/equity/sell] filled', { saleId, symbol, gross: sale.cngnGrossMicro.toString() })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Broker error'
        await admin.rpc('settle_equity_sell', { p_sale_id: saleId, p_status: 'failed', p_error: msg.slice(0, 500) })
        console.error('[invest/equity/sell] broker failed, shares restored:', msg)
      }
    })()

    return NextResponse.json({ status: 'processing', saleId, symbol })
  } catch (err: unknown) {
    console.error('[invest/equity/sell] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
