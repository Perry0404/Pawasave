import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import {
  GETEQUITY_ENABLED, buyWithCngn, sellAsset, quoteSell, custodyAssetBalance, assetRateBps,
} from '@/lib/getequity'
import { withLease, LeaseUnavailableError } from '@/lib/custody-lease'

/**
 * GET /api/cron/savings-gntb-sync   (every 10 min, see ops/cron/crontab)
 *
 * Puts Goals, Ajo/circle and cooperative money to work 1:1 in GetEquity's gNTB T-bill fund (migration 115).
 * Every naira in an active goal or an active Ajo pot is user money; this keeps custody's
 * savings gNTB worth exactly that much:
 *   target  = Σ active goals (saved + interest credited) + Σ circle pots (+ their interest)
 *             + Σ cooperative funds
 *   holding = custody gNTB − gNTB that users bought directly in the marketplace
 *   buy the shortfall, sell the excess. No buffer: gNTB redeems at NAV, 0% fee.
 *
 * Users are never made to wait. The app credits deposits and payouts instantly in the
 * ledger; this job follows within minutes to keep the backing in step.
 *
 * It then sets platform_settings.yield_backing_apy_percent to gNTB's live rate scaled by
 * how much of the target is actually covered. Goals and Ajo interest only accrue while
 * that is above 0, and never above it, so users are only ever paid what is really earned.
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store' // reads tables via GET (see equity-sell-reconcile)
export const maxDuration = 120

const GNTB = process.env.SAVINGS_GNTB_TOKEN || '0x0BBD0A655773AabCF014B7C6E7a2FFB5489528f0'
// Skip dust: don't trade for differences smaller than this (cNGN micro, default ₦500).
const MIN_TRADE_MICRO = BigInt(process.env.SAVINGS_GNTB_MIN_TRADE_MICRO || '500000000')
const ONE = 10n ** 18n

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, { ...init, cache: 'no-store' }) },
  })
}

async function savingsTargetMicro(db: ReturnType<typeof admin>): Promise<bigint> {
  const [goals, pots, coops] = await Promise.all([
    db.from('savings_goals').select('saved_usdc_micro, interest_earned_micro').eq('status', 'active').limit(10000),
    db.from('esusu_groups').select('pot_balance_kobo, interest_accrued_micro').in('status', ['forming', 'active']).limit(10000),
    db.from('cooperatives').select('fund_balance_micro').eq('status', 'active').gt('fund_balance_micro', 0).limit(10000),
  ])
  if (goals.error) throw new Error(`goals query: ${goals.error.message}`)
  if (pots.error) throw new Error(`pots query: ${pots.error.message}`)
  if (coops.error) throw new Error(`coops query: ${coops.error.message}`)
  const n = (v: unknown) => BigInt(Math.floor(Number(v) || 0))
  let t = 0n
  // What users are owed: principal plus the interest already credited to them.
  for (const g of goals.data ?? []) t += n(g.saved_usdc_micro) + n(g.interest_earned_micro)
  for (const p of pots.data ?? []) t += n(p.pot_balance_kobo) * 10_000n + n(p.interest_accrued_micro)
  for (const c of coops.data ?? []) t += n(c.fund_balance_micro)
  return t
}

/** gNTB units (18-dp) that users own directly via the marketplace — not savings backing. */
async function marketplaceUnits(db: ReturnType<typeof admin>): Promise<bigint> {
  const { data, error } = await db.from('portfolio_holdings').select('shares').ilike('symbol', 'gntb').gt('shares', 0)
  if (error) throw new Error(`holdings query: ${error.message}`)
  let u = 0n
  for (const h of data ?? []) u += BigInt(Math.floor((Number(h.shares) || 0) * 1e6)) * 10n ** 12n
  return u
}

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!GETEQUITY_ENABLED) return NextResponse.json({ ok: true, skipped: 'getequity disabled' })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'no service key' }, { status: 503 })

  const db = admin()
  const out: Record<string, unknown> = {}

  try {
    await withLease('custody:signer', async () => {
      const [target, mktUnits, custodyUnits, navQuote, rateBps] = await Promise.all([
        savingsTargetMicro(db), marketplaceUnits(db), custodyAssetBalance(GNTB),
        quoteSell(GNTB, ONE), assetRateBps(GNTB),
      ])
      const nav = navQuote.netPayout // cNGN micro per whole gNTB unit
      if (nav <= 0n) throw new Error('could not price gNTB')

      let units = custodyUnits > mktUnits ? custodyUnits - mktUnits : 0n
      let value = (units * nav) / ONE
      const diff = target - value
      Object.assign(out, { targetMicro: target.toString(), valueMicro: value.toString(), navMicro: nav.toString(), rateBps })

      if (diff > MIN_TRADE_MICRO) {
        const { txHash, units: bought } = await buyWithCngn(GNTB, diff)
        out.bought = { cngnMicro: diff.toString(), units: bought, txHash }
      } else if (-diff > MIN_TRADE_MICRO && units > 0n) {
        let sell = ((-diff) * ONE) / nav
        if (sell > units) sell = units
        const { txHash } = await sellAsset(GNTB, sell)
        out.sold = { units: Number(sell) / 1e18, txHash }
      } else {
        out.inSync = true
      }

      // Re-read the real position after trading, then publish the backing rate.
      units = (await custodyAssetBalance(GNTB)) - mktUnits
      if (units < 0n) units = 0n
      value = (units * nav) / ONE
      const coverage = target > 0n ? Math.min(1, Number(value) / Number(target)) : 0
      const backing = Math.round((rateBps / 100) * coverage * 100) / 100
      await db.from('platform_settings').update({ value: String(backing) }).eq('key', 'yield_backing_apy_percent')
      Object.assign(out, { coverage: Math.round(coverage * 1000) / 10, backingApy: backing })
    }, { holder: 'savings-gntb-sync', waitMs: 15_000 })
  } catch (e) {
    if (e instanceof LeaseUnavailableError) return NextResponse.json({ ok: true, skipped: e.message })
    out.error = e instanceof Error ? e.message : String(e)
    console.error('[savings-gntb-sync]', out)
    return NextResponse.json({ ok: false, ...out }, { status: 500 })
  }

  console.info('[savings-gntb-sync]', out)
  return NextResponse.json({ ok: true, ...out })
}
