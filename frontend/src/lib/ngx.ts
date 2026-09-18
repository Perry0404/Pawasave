/**
 * ngx.ts — NGX (Nigerian Exchange) market data for the Invest tab's "NGX" browse list.
 *
 * Source: NGN Market API (api.ngnmarket.com) — NGX equity prices refreshed every ~20 min, with a
 * hosted logo per company. Free tier is 3,000 calls/month, so we CACHE server-side (module-level,
 * 20-min TTL matching their refresh) and serve the cache to every viewer. That means a handful of
 * upstream calls a day regardless of traffic — nowhere near the quota — and no per-user fan-out.
 *
 * This is market-info only (no trading yet), so staleness is fine: on any upstream error we serve
 * the last good snapshot rather than failing the tab. Dark until NGNMARKET_API_KEY is set.
 */
const BASE = (process.env.NGNMARKET_BASE_URL || 'https://api.ngnmarket.com/v1').replace(/\/$/, '')
const KEY = process.env.NGNMARKET_API_KEY || ''

export const NGX_ENABLED = Boolean(KEY)

export type NgxStock = {
  symbol: string
  name: string
  sector: string | null
  price: number
  changePct: number
  logoUrl: string | null
  marketCap: number | null
}

const TTL_MS = 20 * 60_000 // matches NGN Market's 20-min refresh cadence
let cache: { at: number; data: NgxStock[] } | null = null

function normalize(rows: any[]): NgxStock[] {
  return (rows || [])
    .map((r: any): NgxStock => ({
      symbol: String(r?.symbol || '').toUpperCase(),
      name: r?.name || r?.company_name || r?.symbol || '',
      sector: r?.sector ?? null,
      price: Number(r?.price ?? r?.current_price ?? 0),
      changePct: Number(r?.price_change_percent ?? 0),
      logoUrl: r?.logo_url ?? null,
      marketCap: r?.market_cap != null ? Number(r.market_cap) : null,
    }))
    .filter((s) => s.symbol && Number.isFinite(s.price))
}

/**
 * Top NGX stocks by market cap, cached. Returns `cached:true` when served from the in-memory
 * snapshot (including a stale one kept after an upstream failure).
 */
export async function getNgxStocks(limit = 60): Promise<{ stocks: NgxStock[]; asOf: number; cached: boolean }> {
  if (!KEY) return { stocks: [], asOf: 0, cached: false }
  if (cache && Date.now() - cache.at < TTL_MS) return { stocks: cache.data, asOf: cache.at, cached: true }
  try {
    const res = await fetch(`${BASE}/companies?limit=${limit}&sort=market_cap&order=desc`, {
      headers: { Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`ngnmarket ${res.status}`)
    const j = await res.json()
    const rows = j?.data?.data ?? j?.data ?? []
    const stocks = normalize(rows)
    if (stocks.length) cache = { at: Date.now(), data: stocks }
    return { stocks, asOf: cache?.at ?? Date.now(), cached: false }
  } catch (e) {
    if (cache) return { stocks: cache.data, asOf: cache.at, cached: true } // serve stale rather than fail
    console.error('[ngx] fetch failed:', e instanceof Error ? e.message : e)
    return { stocks: [], asOf: 0, cached: false }
  }
}
