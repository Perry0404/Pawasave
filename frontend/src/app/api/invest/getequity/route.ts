import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { GETEQUITY_ENABLED, listAssets, buyWithCngn, type GetEquityAsset } from '@/lib/getequity'

/**
 * GET  /api/invest/getequity  → regulated Nigerian RWA products (T-bills, funds,
 *                               REITs, IPOs) from GetEquity, listed in the Invest tab.
 * POST /api/invest/getequity  → buy (custody executes on-chain, cNGN-settled).
 *
 * Two roles for the SAME products (see docs/getequity-integration.md):
 *   • Invisible yield engine — NTBL (T-bill) backs Fixed/Goals; a redeemable fund
 *     (ANMF) can back Flexible/Ajo. Users see only an APY, never the instrument.
 *   • Visible marketplace — the exact same products are ALSO listed here to buy
 *     directly (T-bill alongside the IPO etc.); the only difference is the yield.
 *
 * STATUS: GetEquity is on Base Sepolia testnet; mainnet pending. When
 * GETEQUITY_ENABLED is off, the list is a static preview and buying returns 503
 * ("launching soon") with NO debit — same pattern as the equity broker. When it's
 * on, the list is read live from the chain. The buy path (atomic debit + custody
 * execution + ledger) lands with its migration on mainnet — see the plan doc.
 */
export const dynamic = 'force-dynamic'

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

/** Display metadata for known GetEquity products, keyed by on-chain symbol.
 *  The chain returns terse symbols; this gives users a human name + descriptor.
 *  `kind` classifies liquidity for the UI (term = locked to maturity, fund =
 *  redeemable, equity = shares). At runtime we override `kind` from the token's
 *  own hasMaturity()/hasPeriodicPayouts() flags — this is just the fallback/preview. */
// Symbols verified against GetEquity's live Base Sepolia contracts.
const PRODUCT_META: Record<string, { name: string; kind: 'term' | 'fund' | 'equity'; blurb: string }> = {
  NTBL:   { name: 'Nigerian Treasury Bill',  kind: 'term',   blurb: 'Government-backed · fixed income' },
  ARMNGF: { name: 'ARM NGN Mutual Fund',     kind: 'fund',   blurb: 'Money-market income fund' },
  CHDNRE: { name: 'Chapel Hill Denham REIT', kind: 'equity', blurb: 'Real estate income' },
  DPRI:   { name: 'Dangote Refinery IPO',    kind: 'equity', blurb: 'Pre-IPO equity' },
}

type ProductCard = {
  token: string | null
  symbol: string
  name: string
  kind: 'term' | 'fund' | 'equity'
  blurb: string
  tradeable: boolean
  maturityDate: number
}

/** Static preview shown before the integration is switched on, so the tab is
 *  never empty and users can register interest ahead of the mainnet launch. */
function previewCards(): ProductCard[] {
  return Object.entries(PRODUCT_META).map(([symbol, m]) => ({
    token: null, symbol, name: m.name, kind: m.kind, blurb: m.blurb,
    tradeable: false, maturityDate: 0,
  }))
}

function toCard(a: GetEquityAsset): ProductCard {
  const meta = PRODUCT_META[a.symbol]
  const kind: ProductCard['kind'] = a.hasMaturity
    ? 'term'
    : a.hasPeriodicPayouts
    ? 'fund'
    : (meta?.kind ?? 'equity')
  return {
    token: a.token,
    symbol: a.symbol,
    name: meta?.name ?? a.name,
    kind,
    blurb: meta?.blurb ?? (kind === 'term' ? 'Fixed term' : kind === 'fund' ? 'Withdraw anytime' : 'Equity'),
    tradeable: a.tradeable,
    maturityDate: a.maturityDate,
  }
}

export async function GET() {
  const { user } = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  if (!GETEQUITY_ENABLED) {
    return NextResponse.json({ live: false, assets: previewCards() })
  }
  try {
    const assets = await listAssets()
    return NextResponse.json({ live: true, assets: assets.map(toCard) })
  } catch (e) {
    // On-chain read hiccup — fall back to the preview list rather than an empty tab.
    console.error('[invest/getequity] listAssets failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ live: false, assets: previewCards() })
  }
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

const MIN_CNGN_MICRO = 1_000_000_000n // ₦1,000 minimum

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const symbol = String(body.symbol || '').trim().toUpperCase()
    const token = String(body.token || '').trim()
    let amount: bigint
    try { amount = BigInt(body.amountCngnMicro) } catch { amount = 0n }

    if (!symbol) return NextResponse.json({ error: 'Symbol required' }, { status: 400 })
    if (amount < MIN_CNGN_MICRO) {
      return NextResponse.json({ error: 'Minimum investment is ₦1,000' }, { status: 400 })
    }

    // KYC gate (also enforced in the RPC) — clean message before any debit.
    const { data: profile } = await supabase.from('profiles').select('kyc_status').eq('id', user.id).single()
    if (profile?.kyc_status !== 'verified') {
      return NextResponse.json({ error: 'Complete identity verification (KYC) to invest.' }, { status: 403 })
    }

    // Not switched on yet (testnet) → surface clearly and DO NOT debit. This is
    // what keeps the route safe to deploy before the migration is applied.
    if (!GETEQUITY_ENABLED || !token) {
      return NextResponse.json(
        { status: 'coming_soon', message: 'Regulated investments are launching soon.' },
        { status: 503 },
      )
    }

    // Atomic cNGN debit + pending order (via the user's session → auth.uid()).
    const { data: orderId, error: placeErr } = await supabase.rpc('place_getequity_order', {
      p_user_id: user.id,
      p_symbol: symbol,
      p_token: token,
      p_amount_cngn_micro: amount.toString(),
    })
    if (placeErr || !orderId) {
      const msg = /insufficient/i.test(placeErr?.message || '') ? 'Insufficient cNGN balance' : 'Could not place order'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    const admin = serviceClient()
    try {
      const { txHash, units } = await buyWithCngn(token, amount)
      await admin.rpc('settle_getequity_order', {
        p_order_id: orderId,
        p_status: 'filled',
        p_units: units,
        p_tx_hash: txHash,
      })
      return NextResponse.json({ status: 'filled', orderId, symbol, units, txHash })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'On-chain buy failed'
      // Refund the debited cNGN.
      await admin.rpc('settle_getequity_order', { p_order_id: orderId, p_status: 'failed', p_error: msg.slice(0, 500) })
      console.error('[invest/getequity] buy failed, refunded:', msg)
      return NextResponse.json({ error: 'Purchase failed — your cNGN was refunded.' }, { status: 502 })
    }
  } catch (err) {
    console.error('[invest/getequity] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}