/**
 * equity-prices.ts — refresh the cached cNGN value of tokenized-stock holdings.
 *
 * Stocks are quoted in USD (Yahoo). A DB function can't call an external API, so the
 * borrow engine values equity collateral from the `equity_prices` cache instead —
 * this refreshes it: fetch each symbol's USD price, convert with the configurable
 * USD→NGN rate, and upsert the cNGN value of ONE share. Called at borrow time (so a
 * limit is priced fresh) and by the loan-maintenance cron (so liquidation sees
 * current values). Needs a service-role client to write the shared cache.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

async function fetchUsdPrice(symbol: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 30 } })
    if (!res.ok) return null
    const j = await res.json()
    const price = Number(j?.chart?.result?.[0]?.meta?.regularMarketPrice)
    return Number.isFinite(price) && price > 0 ? price : null
  } catch {
    return null
  }
}

/** Refresh cached cNGN prices for `symbols`. Returns how many were updated. */
export async function refreshEquityPrices(admin: SupabaseClient, symbols: string[]): Promise<number> {
  const uniq = [...new Set(symbols.map((s) => String(s || '').toUpperCase()).filter((s) => /^[A-Z.\-^]{1,12}$/.test(s)))]
  if (uniq.length === 0) return 0

  const { data: rateRow } = await admin.from('platform_settings').select('value').eq('key', 'usd_ngn_rate').single()
  const rate = Number(rateRow?.value) || 1600 // cNGN is naira-pegged; configurable

  let updated = 0
  await Promise.all(
    uniq.map(async (symbol) => {
      const usd = await fetchUsdPrice(symbol)
      if (usd == null) return
      const priceNgnMicro = Math.floor(usd * rate * 1_000_000)
      const { error } = await admin
        .from('equity_prices')
        .upsert({ symbol, price_ngn_micro: priceNgnMicro, updated_at: new Date().toISOString() }, { onConflict: 'symbol' })
      if (!error) updated++
    }),
  )
  return updated
}

/** Symbols this user holds (shares > 0), for a targeted price refresh. */
export async function heldSymbols(admin: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await admin.from('portfolio_holdings').select('symbol').eq('user_id', userId).gt('shares', 0)
  return (data || []).map((r: any) => r.symbol)
}