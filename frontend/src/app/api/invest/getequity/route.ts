import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { GETEQUITY_ENABLED, GETEQUITY_MIN_UNITS, listAssets, buyWithCngn, quoteBuy, type GetEquityAsset } from '@/lib/getequity'
import { withLease } from '@/lib/custody-lease'
import { sendInvestmentBuyEmail } from '@/lib/notify-tx'

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
 * STATUS: GetEquity's Market is LIVE on Base mainnet (settles in cNGN). When
 * GETEQUITY_ENABLED is off, the list is a static preview and buying returns 503
 * ("launching soon") with NO debit — same pattern as the equity broker. When it's
 * on, the list is read live from the chain and buys run under the custody lease.
 * PawaSave charges GETEQUITY_FEE_BPS on top of GetEquity's on-chain vault fee.
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
// Symbols verified on-chain against GetEquity's live Base MAINNET contracts (2026-09-15).
const PRODUCT_META: Record<string, { name: string; kind: 'term' | 'fund' | 'equity'; blurb: string }> = {
  DPRI:  { name: 'Dangote Refinery IPO',         kind: 'equity', blurb: 'Pre-IPO equity' },
  NTBS5: { name: 'Nigerian Treasury Bill Series 5', kind: 'term', blurb: 'Government-backed · fixed income' },
}

/**
 * Marketplace visibility allowlist. When GETEQUITY_MARKETPLACE_SYMBOLS is set
 * (comma-separated symbols, e.g. "DPRI"), only those symbols are offered for
 * purchase — everything else the Market lists is hidden. This is how we keep the
 * T-bill (NTBS5) OFF the marketplace until its exact yield/rate is confirmed,
 * while the Dangote IPO (DPRI) is live. Unset = show every registered asset.
 */
function marketplaceAllowlist(): Set<string> | null {
  const raw = (process.env.GETEQUITY_MARKETPLACE_SYMBOLS || '').trim()
  if (!raw) return null
  return new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
}
function isAllowed(symbol: string, allow: Set<string> | null): boolean {
  return !allow || allow.has(symbol.toUpperCase())
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
  const allow = marketplaceAllowlist()
  return Object.entries(PRODUCT_META)
    .filter(([symbol]) => isAllowed(symbol, allow))
    .map(([symbol, m]) => ({
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
    return NextResponse.json({ live: false, assets: previewCards(), feeBps: FEE_BPS })
  }
  try {
    const allow = marketplaceAllowlist()
    const assets = await listAssets()
    const cards = assets.map(toCard).filter((c) => isAllowed(c.symbol, allow))
    return NextResponse.json({ live: true, assets: cards, feeBps: FEE_BPS })
  } catch (e) {
    // On-chain read hiccup — fall back to the preview list rather than an empty tab.
    console.error('[invest/getequity] listAssets failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ live: false, assets: previewCards(), feeBps: FEE_BPS })
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

/** PawaSave's own platform fee on a GetEquity buy (revenue), in basis points.
 *  This is ON TOP of GetEquity's ~0.5–1% on-chain vault fee (which goes to them).
 *  Deducted from the amount the user commits: they pay X, we keep feeBps·X, and the
 *  remainder buys the asset. Configurable via GETEQUITY_FEE_BPS (default 100 = 1%). */
const FEE_BPS = (() => {
  const n = Number(process.env.GETEQUITY_FEE_BPS)
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.floor(n) : 100
})()
function splitFee(gross: bigint): { fee: bigint; net: bigint } {
  const fee = (gross * BigInt(FEE_BPS)) / 10_000n
  return { fee, net: gross - fee }
}

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
    // Enforce the marketplace allowlist server-side — a hidden asset (e.g. the T-bill
    // pending its confirmed rate) can't be bought even by POSTing its symbol directly.
    if (!isAllowed(symbol, marketplaceAllowlist())) {
      return NextResponse.json({ error: 'This investment is not currently available.' }, { status: 403 })
    }
    if (amount < MIN_CNGN_MICRO) {
      return NextResponse.json({ error: 'Minimum investment is ₦1,000' }, { status: 400 })
    }

    // Identity gate before any debit — SAME policy as the live tokenized-stock flow
    // (/api/invest/equity): Strails BVN onboarding is enough to invest; full 'verified'
    // also passes. Also enforced in the RPC.
    const { data: profile } = await supabase
      .from('profiles')
      .select('kyc_status, strails_onboard_status, strails_va_account_number')
      .eq('id', user.id)
      .single()
    const identityOk = profile?.kyc_status === 'verified'
      || profile?.strails_onboard_status === 'completed'
      || !!profile?.strails_va_account_number
    if (!identityOk) {
      return NextResponse.json({ error: 'Add your BVN to set up your account, then you can invest.' }, { status: 403 })
    }

    // Not switched on yet → surface clearly and DO NOT debit. This is what keeps the
    // route safe to deploy before the migration is applied.
    if (!GETEQUITY_ENABLED || !token) {
      return NextResponse.json(
        { status: 'coming_soon', message: 'Regulated investments are launching soon.' },
        { status: 503 },
      )
    }

    // Split the committed amount into PawaSave's fee (revenue) and the net that buys
    // the asset on-chain. The wallet is debited net+fee; the fee is booked to revenue
    // only when the buy fills, and fully refunded with the net if it fails.
    const { fee, net } = splitFee(amount)

    // Enforce GetEquity's minimum lot (default 10 units) BEFORE any debit — the NET
    // (what actually buys) must cover the cost of the minimum units at the live price.
    // Quoting also confirms the asset is priceable right now.
    try {
      const minCost = (await quoteBuy(token, GETEQUITY_MIN_UNITS * 10n ** 18n)).totalCost
      if (net < minCost) {
        // Gross the user must commit so NET (= gross − our fee) still covers the minimum.
        const minGross = (minCost * 10_000n) / BigInt(10_000 - FEE_BPS)
        const minNaira = Math.ceil(Number(minGross) / 1e6)
        return NextResponse.json(
          { error: `Minimum purchase is ${GETEQUITY_MIN_UNITS} units — about ₦${minNaira.toLocaleString('en-NG')}.` },
          { status: 400 },
        )
      }
    } catch (e) {
      console.error('[invest/getequity] min-units quote failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Could not price this investment right now — please try again.' }, { status: 502 })
    }

    // Atomic cNGN debit (net + fee) + pending order (via the user's session → auth.uid()).
    const { data: orderId, error: placeErr } = await supabase.rpc('place_getequity_order', {
      p_user_id: user.id,
      p_symbol: symbol,
      p_token: token,
      p_amount_cngn_micro: net.toString(),
      p_fee_cngn_micro: fee.toString(),
    })
    if (placeErr || !orderId) {
      const msg = /insufficient/i.test(placeErr?.message || '') ? 'Insufficient cNGN balance' : 'Could not place order'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    const admin = serviceClient()
    try {
      // Under the custody lease (serialises with every other custody signer). Buys
      // with NET (committed amount minus PawaSave's fee); a lease failure lands in the
      // catch below, which refunds, which is right because nothing was bought.
      const { txHash, units } = await withLease(
        'custody:signer',
        () => buyWithCngn(token, net),
        { holder: `getequity-buy ${symbol}`, waitMs: 25_000 },
      )
      await admin.rpc('settle_getequity_order', {
        p_order_id: orderId,
        p_status: 'filled',
        p_units: units,
        p_tx_hash: txHash,
      })
      // Buy receipt — isolated so an email failure can't affect the filled order.
      try {
        await sendInvestmentBuyEmail(user.id, {
          name: PRODUCT_META[symbol]?.name || symbol,
          symbol,
          units,
          investedNgn: Number(net) / 1e6,
          feeNgn: Number(fee) / 1e6,
          reference: txHash || `getequity_${orderId}`,
        })
      } catch (mailErr) { console.error('[invest/getequity] buy email failed:', mailErr) }
      return NextResponse.json({
        status: 'filled', orderId, symbol, units, txHash,
        feeCngnMicro: fee.toString(), netCngnMicro: net.toString(),
      })
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