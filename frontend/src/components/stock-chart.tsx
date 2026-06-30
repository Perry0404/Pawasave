'use client'

import { useEffect, useState } from 'react'

/**
 * Native, self-contained market UI for the Invest screen. No third-party widget
 * scripts (those failed to render and bled styles into the app), so every colour
 * here is ours and always legible. Data comes from /api/invest/quotes.
 */

export type Quote = {
  symbol: string
  price: number | null
  prevClose: number | null
  changePct: number | null
  currency: string
  spark: number[]
}

/** Fetch live quotes for a set of symbols; refreshes every 60s. */
export function useStockQuotes(symbols: string[]) {
  const key = symbols.join(',')
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!key) { setLoading(false); return }
    let alive = true
    const load = () =>
      fetch(`/api/invest/quotes?symbols=${encodeURIComponent(key)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d?.quotes) return
          const map: Record<string, Quote> = {}
          for (const q of d.quotes as Quote[]) map[q.symbol] = q
          setQuotes(map)
        })
        .catch(() => undefined)
        .finally(() => { if (alive) setLoading(false) })
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [key])

  return { quotes, loading }
}

function fmtPrice(q?: Quote): string {
  if (!q || q.price == null) return '—'
  const cur = q.currency === 'USD' ? '$' : ''
  return `${cur}${q.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(q?: Quote): string {
  if (!q || q.changePct == null) return '—'
  const sign = q.changePct >= 0 ? '+' : ''
  return `${sign}${q.changePct.toFixed(2)}%`
}

/**
 * Pure SVG sparkline that fills its container width. Green when up on the day,
 * red when down. The viewBox carries the coordinate math; the element renders at
 * 100% width with a non-scaling stroke so it stays crisp at any size.
 */
export function Sparkline({
  data, up, height = 28, strokeWidth = 1.5,
}: { data: number[]; up: boolean; height?: number; strokeWidth?: number }) {
  const W = 100 // logical width; viewBox scales it to the container
  if (!data || data.length < 2) {
    return <div style={{ height }} className="w-full rounded bg-slate-100" />
  }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const stepX = W / (data.length - 1)
  const pts = data.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / range) * (height - 2) - 1
    return [x, y] as const
  })
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${W},${height} L0,${height} Z`
  const color = up ? '#10b981' : '#ef4444'
  const gid = `sp-${up ? 'u' : 'd'}-${data.length}`
  return (
    <svg
      width="100%" height={height} viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none" className="block"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line} fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/** Coloured % change badge. */
export function ChangeBadge({ q }: { q?: Quote }) {
  const up = (q?.changePct ?? 0) >= 0
  const has = q?.changePct != null
  return (
    <span
      className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${
        !has ? 'bg-slate-100 text-slate-400' : up ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
      }`}
    >
      {fmtPct(q)}
    </span>
  )
}

/** Horizontal strip of live quote cards (image-2 style). */
export function MarketCards({
  stocks, quotes,
}: { stocks: { symbol: string; name: string; tv?: string }[]; quotes: Record<string, Quote> }) {
  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-4 px-4 snap-x">
      {stocks.map((s) => {
        const q = quotes[s.symbol]
        const up = (q?.changePct ?? 0) >= 0
        return (
          <div key={s.symbol} className="snap-start shrink-0 w-36 bg-white border border-slate-200 rounded-xl p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-slate-900">{s.symbol}</span>
              <ChangeBadge q={q} />
            </div>
            <p className="text-[11px] text-slate-400 truncate mb-1.5">{s.name}</p>
            <div className="h-7 mb-1.5">
              <Sparkline data={q?.spark ?? []} up={up} height={28} />
            </div>
            <p className="text-sm font-semibold text-slate-800">{fmtPrice(q)}</p>
          </div>
        )
      })}
    </div>
  )
}

/** Inline price + % + sparkline for a single stock (buy sheet header). */
export function StockQuotePanel({ quote }: { quote?: Quote }) {
  const up = (quote?.changePct ?? 0) >= 0
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-end justify-between mb-2">
        <div>
          <p className="text-2xl font-bold text-slate-900 leading-none">{fmtPrice(quote)}</p>
          <p className="text-[11px] text-slate-400 mt-1">Live price · {quote?.currency || 'USD'}</p>
        </div>
        <ChangeBadge q={quote} />
      </div>
      <div className="h-16">
        <Sparkline data={quote?.spark ?? []} up={up} height={64} strokeWidth={2} />
      </div>
    </div>
  )
}

export { fmtPrice, fmtPct }