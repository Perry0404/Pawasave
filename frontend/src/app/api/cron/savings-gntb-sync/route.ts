import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import {
  GETEQUITY_ENABLED, buyWithCngn, sellAsset, quoteSell, custodyAssetBalance, assetRateBps, listAssets,
} from '@/lib/getequity'
import { withLease, LeaseUnavailableError } from '@/lib/custody-lease'

/**
 * GET /api/cron/savings-gntb-sync   (every 5 min, see ops/cron/crontab)
 *
 * Puts savings to work 1:1 in GetEquity assets (migrations 115 and 120).
 *
 * gNTB (T-bill fund) backs Goals, Ajo/circle pots, cooperative funds, and every Fixed
 * Savings v2 lock whose backing_token is gNTB. Fixed Savings v2 locks backed by another
 * asset (the GetEquity credit fund, once listed) are backed in that asset instead. For each
 * asset:
 *   target  = what users are owed in it (principal + interest credited or accrued so far)
 *   holding = custody units − units users bought directly in the marketplace
 *   buy the shortfall in WHOLE units (pooled), sell the excess in whole units.
 *
 * Users are never made to wait. The app credits deposits and payouts instantly in the
 * ledger; this job follows within minutes to keep the backing in step. When a fixed lock
 * pays out, it leaves the target and the next run sells the backing it no longer needs.
 *
 * Rates it publishes:
 *   yield_backing_apy_percent    gNTB's rate scaled by how much of the gNTB target is covered.
 *                                Goals and Ajo interest only accrue while this is above 0.
 *   fixed_v2_backing_apy_percent the live rate of the asset configured to back NEW fixed
 *                                locks (fixed_v2_backing_token). lock_savings_v2 refuses to
 *                                quote a saver rate above it minus the minimum spread.
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store' // reads tables via GET (see equity-sell-reconcile)
export const maxDuration = 120

const GNTB = process.env.SAVINGS_GNTB_TOKEN || '0x0BBD0A655773AabCF014B7C6E7a2FFB5489528f0'
// Skip dust: don't trade for differences smaller than this (cNGN micro, default ₦500).
const MIN_TRADE_MICRO = BigInt(process.env.SAVINGS_GNTB_MIN_TRADE_MICRO || '500000000')
const ONE = 10n ** 18n
const DAY_MS = 86_400_000

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, { ...init, cache: 'no-store' }) },
  })
}
type Db = ReturnType<typeof admin>
const n = (v: unknown) => BigInt(Math.floor(Number(v) || 0))
const key = (a: string) => a.toLowerCase()

async function savingsTargetMicro(db: Db): Promise<bigint> {
  const [goals, pots, coops] = await Promise.all([
    db.from('savings_goals').select('saved_usdc_micro, interest_earned_micro').eq('status', 'active').limit(10000),
    db.from('esusu_groups').select('pot_balance_kobo, interest_accrued_micro').in('status', ['forming', 'active']).limit(10000),
    db.from('cooperatives').select('fund_balance_micro').eq('status', 'active').gt('fund_balance_micro', 0).limit(10000),
  ])
  if (goals.error) throw new Error(`goals query: ${goals.error.message}`)
  if (pots.error) throw new Error(`pots query: ${pots.error.message}`)
  if (coops.error) throw new Error(`coops query: ${coops.error.message}`)
  let t = 0n
  // What users are owed: principal plus the interest already credited to them.
  for (const g of goals.data ?? []) t += n(g.saved_usdc_micro) + n(g.interest_earned_micro)
  for (const p of pots.data ?? []) t += n(p.pot_balance_kobo) * 10_000n + n(p.interest_accrued_micro)
  for (const c of coops.data ?? []) t += n(c.fund_balance_micro)
  return t
}

/**
 * Fixed Savings v2 owed per backing asset: principal + the share of the quoted interest
 * earned so far (straight line over the term), so the backing grows toward the payout.
 * Returns an empty map before migration 120 (the columns don't exist yet).
 */
async function lockTargetsMicro(db: Db): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const { data, error } = await db.from('savings_locks')
    .select('amount_usdc_micro, projected_interest_micro, duration_days, locked_at, backing_token')
    .eq('version', 2).eq('status', 'active').is('paid_out_at', null).limit(20000)
  if (error) {
    if (/column|does not exist|schema cache/i.test(error.message)) return out
    throw new Error(`locks query: ${error.message}`)
  }
  const now = Date.now()
  for (const l of data ?? []) {
    if (!l.backing_token) continue
    const days = Math.max(1, Number(l.duration_days) || 1)
    const elapsed = Math.min(1, Math.max(0, (now - new Date(l.locked_at).getTime()) / (days * DAY_MS)))
    const owed = n(l.amount_usdc_micro) + n(Number(l.projected_interest_micro || 0) * elapsed)
    out.set(key(l.backing_token), (out.get(key(l.backing_token)) ?? 0n) + owed)
  }
  return out
}

/** Units (18-dp) of an asset that users own directly via the marketplace — not savings backing. */
async function marketplaceUnits(db: Db, symbol: string): Promise<bigint> {
  const { data, error } = await db.from('portfolio_holdings').select('shares').ilike('symbol', symbol).gt('shares', 0)
  if (error) throw new Error(`holdings query: ${error.message}`)
  let u = 0n
  for (const h of data ?? []) u += BigInt(Math.floor((Number(h.shares) || 0) * 1e6)) * 10n ** 12n
  return u
}

async function setting(db: Db, k: string): Promise<string | null> {
  const { data } = await db.from('platform_settings').select('value').eq('key', k).maybeSingle()
  return (data?.value as string | undefined) ?? null
}

/** Bring custody's holding of one asset to `target` (cNGN micro). */
async function syncAsset(db: Db, token: string, symbol: string, target: bigint) {
  const [mktUnits, custodyUnits, navQuote, rateBps] = await Promise.all([
    marketplaceUnits(db, symbol), custodyAssetBalance(token), quoteSell(token, ONE), assetRateBps(token),
  ])
  const nav = navQuote.netPayout // cNGN micro per whole unit
  if (nav <= 0n) throw new Error(`could not price ${symbol}`)
  const r: Record<string, unknown> = { targetMicro: target.toString(), navMicro: nav.toString(), rateBps }

  let units = custodyUnits > mktUnits ? custodyUnits - mktUnits : 0n
  let value = (units * nav) / ONE
  const diff = target - value
  r.valueMicro = value.toString()

  if (diff > MIN_TRADE_MICRO) {
    try {
      const { txHash, units: bought } = await buyWithCngn(token, diff, 100, { wholeUnits: true })
      r.bought = { cngnMicro: diff.toString(), units: bought, txHash }
    } catch (e) {
      // Short of one whole unit (or the market's minimum lot): wait for the pool to grow.
      const m = e instanceof Error ? e.message : String(e)
      if (!/too small|Minimum purchase/i.test(m)) throw e
      r.waiting = m
    }
  } else if (-diff > MIN_TRADE_MICRO && units > 0n) {
    // Whole units, rounded down, so a sell never takes the holding below what users are owed.
    let sell = (((-diff) * ONE) / nav / ONE) * ONE
    if (sell > units) sell = (units / ONE) * ONE
    if (sell > 0n) {
      const { txHash } = await sellAsset(token, sell)
      r.sold = { units: Number(sell / ONE), txHash }
    } else {
      r.inSync = true
    }
  } else {
    r.inSync = true
  }

  units = (await custodyAssetBalance(token)) - mktUnits
  if (units < 0n) units = 0n
  value = (units * nav) / ONE
  const coverage = target > 0n ? Math.min(1, Number(value) / Number(target)) : 0
  r.coverage = Math.round(coverage * 1000) / 10
  return { r, rateBps, coverage }
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
      const [savings, locks, fixedToken] = await Promise.all([
        savingsTargetMicro(db), lockTargetsMicro(db), setting(db, 'fixed_v2_backing_token'),
      ])

      // ── gNTB: savings + gNTB-backed fixed locks ──
      const g = await syncAsset(db, GNTB, 'gntb', savings + (locks.get(key(GNTB)) ?? 0n))
      out.gntb = { ...g.r, fixedLocksMicro: (locks.get(key(GNTB)) ?? 0n).toString() }
      const backing = Math.round((g.rateBps / 100) * g.coverage * 100) / 100
      await db.from('platform_settings').update({ value: String(backing) }).eq('key', 'yield_backing_apy_percent')
      out.backingApy = backing

      // ── any other asset backing fixed locks (e.g. the credit fund) ──
      const others = new Set([...locks.keys()].filter((t) => t !== key(GNTB)))
      if (fixedToken && key(fixedToken) !== key(GNTB)) others.add(key(fixedToken))
      let fixedRateBps = fixedToken && key(fixedToken) === key(GNTB) ? g.rateBps : null
      if (others.size) {
        const assets = await listAssets()
        for (const t of others) {
          const a = assets.find((x) => key(x.token) === t)
          if (!a) { out[t] = { error: 'not listed on the GetEquity market' }; continue }
          const s = await syncAsset(db, a.token, a.symbol, locks.get(t) ?? 0n)
          out[a.symbol] = s.r
          if (fixedToken && key(fixedToken) === t) fixedRateBps = s.rateBps
        }
      }

      // The rate lock_savings_v2 checks new locks against: the asset's own live rate.
      // 0 when unknown, which keeps new locks shut rather than guessing.
      const fixedApy = fixedRateBps != null ? Math.round(fixedRateBps) / 100 : 0
      await db.from('platform_settings').update({ value: String(fixedApy) }).eq('key', 'fixed_v2_backing_apy_percent')
      out.fixedBackingApy = fixedApy
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
