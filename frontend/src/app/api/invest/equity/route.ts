import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  isEquityBrokerLive,
  equityProvider,
  supportedEquitySymbols,
  placeEquityOrder,
  type EquityAssetType,
} from '@/lib/equity-broker'

/**
 * POST /api/invest/equity   { assetType, symbol, amountCngnMicro, provider? }
 *   Buy a tokenized stock or pre-IPO token with cNGN. Flow:
 *     KYC check → broker-live check → place_equity_order (atomic cNGN debit +
 *     pending order) → broker buys (cNGN→USDC→token) → settle (fill or refund).
 *   Returns 503 "coming soon" (no debit) until a broker is configured.
 *
 * GET /api/invest/equity   → the caller's portfolio_holdings.
 */
export const dynamic = 'force-dynamic'

const MIN_CNGN_MICRO = 1_000_000_000n // ₦1,000 minimum equity buy

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

export async function GET() {
  const { user, supabase } = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data } = await supabase
    .from('portfolio_holdings')
    .select('symbol, asset_type, provider, invested_cngn_micro, shares, updated_at')
    .order('updated_at', { ascending: false })
  // Recent orders so the client can poll a background buy's outcome (processing→filled/refunded).
  const { data: orders } = await supabase
    .from('equity_orders')
    .select('id, symbol, status, shares, error, created_at')
    .order('created_at', { ascending: false })
    .limit(5)
  // USD→NGN rate so the client can value USD-quoted holdings in cNGN (same setting the
  // borrow engine uses). Read with the service client to avoid platform_settings RLS.
  let rate = 1600
  try {
    const { data: r } = await serviceClient().from('platform_settings').select('value').eq('key', 'usd_ngn_rate').maybeSingle()
    rate = Number(r?.value) || 1600
  } catch { /* fall back to default */ }
  return NextResponse.json({ holdings: data ?? [], orders: orders ?? [], broker: { live: isEquityBrokerLive(), provider: equityProvider() }, supportedSymbols: supportedEquitySymbols(), rate })
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const assetType = body.assetType as EquityAssetType
    const symbol = String(body.symbol || '').trim().toUpperCase()
    const provider = String(body.provider || equityProvider() || 'coinbase')
    let amount: bigint
    try { amount = BigInt(body.amountCngnMicro) } catch { amount = 0n }

    if (assetType !== 'tokenized_stock' && assetType !== 'pre_ipo') {
      return NextResponse.json({ error: 'Invalid asset type' }, { status: 400 })
    }
    if (!symbol) return NextResponse.json({ error: 'Symbol required' }, { status: 400 })
    if (amount < MIN_CNGN_MICRO) {
      return NextResponse.json({ error: 'Minimum investment is ₦1,000' }, { status: 400 })
    }

    // KYC gate (also enforced in the RPC) — clean message before any debit.
    const { data: profile } = await supabase.from('profiles').select('kyc_status').eq('id', user.id).single()
    if (profile?.kyc_status !== 'verified') {
      return NextResponse.json({ error: 'Complete identity verification (KYC) to invest in equities.' }, { status: 403 })
    }

    // Not live yet → surface clearly and DO NOT debit.
    if (!isEquityBrokerLive()) {
      return NextResponse.json(
        { status: 'coming_soon', message: 'Tokenized stocks & pre-IPO are launching soon.' },
        { status: 503 },
      )
    }

    // Symbol listed in the catalog but not yet routable (no verified token / DEX pool) →
    // coming soon, NEVER debit (a buy here could only refund). Mirrors the UI's gating.
    if (!supportedEquitySymbols().includes(symbol)) {
      return NextResponse.json(
        { status: 'coming_soon', message: `${symbol} isn't buyable yet — verification pending.` },
        { status: 503 },
      )
    }

    // Atomic cNGN debit + pending order (via the user's session → auth.uid()).
    const { data: orderId, error: placeErr } = await supabase.rpc('place_equity_order', {
      p_user_id: user.id,
      p_symbol: symbol,
      p_asset_type: assetType,
      p_provider: provider,
      p_amount_cngn_micro: amount.toString(),
    })
    if (placeErr || !orderId) {
      const msg = /insufficient/i.test(placeErr?.message || '') ? 'Insufficient cNGN balance' : 'Could not place order'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    // Complete the buy in the BACKGROUND and return immediately. The HyperFX solver
    // auction + swaps take 1–2 min — longer than the client/Cloudflare HTTP timeout
    // (~100s), which was killing the flow mid-way and stranding orders on 'pending'.
    // This long-running self-hosted Node server keeps executing after we respond, then
    // settles the order (fill or refund); the client polls GET for the outcome.
    const admin = serviceClient()
    void (async () => {
      try {
        const fill = await placeEquityOrder({ symbol, assetType, amountCngnMicro: amount, provider })
        await admin.rpc('settle_equity_order', {
          p_order_id: orderId, p_status: 'filled',
          p_usdc_micro: fill.usdcMicro.toString(), p_shares: fill.shares, p_broker_ref: fill.brokerRef,
        })
        console.info('[invest/equity] filled', { orderId, symbol, shares: fill.shares })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Broker error'
        await admin.rpc('settle_equity_order', { p_order_id: orderId, p_status: 'failed', p_error: msg.slice(0, 500) })
        console.error('[invest/equity] broker failed, refunded:', msg)
      }
    })()

    return NextResponse.json({ status: 'processing', orderId, symbol })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Server error'
    console.error('[invest/equity] error:', msg)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}