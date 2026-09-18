import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/invest/quotes?symbols=AAPL,NVDA,...
 * Live price, % change and an intraday sparkline for each symbol, sourced from
 * Yahoo's public v8 chart endpoint (no API key). Used by the Invest screen to
 * render our OWN quote cards + sparklines — no third-party widget, so the colours
 * are ours and nothing bleeds into the app UI.
 */
export const dynamic = 'force-dynamic'

type Quote = {
  symbol: string
  price: number | null
  prevClose: number | null
  changePct: number | null
  currency: string
  spark: number[]
}

async function fetchQuote(symbol: string): Promise<Quote> {
  const empty: Quote = { symbol, price: null, prevClose: null, changePct: null, currency: 'USD', spark: [] }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 30 },
    })
    if (!res.ok) return empty
    const json = await res.json()
    const r = json?.chart?.result?.[0]
    if (!r) return empty
    const meta = r.meta || {}
    const price = Number(meta.regularMarketPrice)
    const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose)
    const closes: unknown[] = r.indicators?.quote?.[0]?.close ?? []
    const spark = closes
      .map(Number)
      .filter((n) => Number.isFinite(n))
    const changePct =
      Number.isFinite(price) && Number.isFinite(prevClose) && prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : null
    return {
      symbol,
      price: Number.isFinite(price) ? price : null,
      prevClose: Number.isFinite(prevClose) ? prevClose : null,
      changePct,
      currency: meta.currency || 'USD',
      // keep the sparkline light — ~40 points is plenty for a row chart
      spark: spark.length > 40 ? spark.filter((_, i) => i % Math.ceil(spark.length / 40) === 0) : spark,
    }
  } catch {
    return empty
  }
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('symbols') || ''
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z.\-^]{1,12}$/.test(s))
    .slice(0, 16)

  if (symbols.length === 0) return NextResponse.json({ quotes: [] })

  const quotes = await Promise.all(symbols.map(fetchQuote))
  return NextResponse.json(
    { quotes },
    { headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=120' } },
  )
}