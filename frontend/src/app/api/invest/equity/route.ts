import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  isEquityBrokerLive,
  equityProvider,
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
  return NextResponse.json({ holdings: data ?? [], broker: { live: isEquityBrokerLive(), provider: equityProvider() } })
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

    const admin = serviceClient()
    try {
      const fill = await placeEquityOrder({ symbol, assetType, amountCngnMicro: amount, provider })
      await admin.rpc('settle_equity_order', {
        p_order_id: orderId,
        p_status: 'filled',
        p_usdc_micro: fill.usdcMicro.toString(),
        p_shares: fill.shares,
        p_broker_ref: fill.brokerRef,
      })
      return NextResponse.json({ status: 'filled', orderId, symbol, shares: fill.shares, brokerRef: fill.brokerRef })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Broker error'
      // Refund the debited cNGN.
      await admin.rpc('settle_equity_order', { p_order_id: orderId, p_status: 'failed', p_error: msg.slice(0, 500) })
      console.error('[invest/equity] broker failed, refunded:', msg)
      return NextResponse.json({ error: 'Purchase failed — your cNGN was refunded.' }, { status: 502 })
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Server error'
    console.error('[invest/equity] error:', msg)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}