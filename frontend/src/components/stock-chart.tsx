'use client'

import { useEffect, useRef } from 'react'

/**
 * StockChart — live price chart via TradingView's free mini-symbol-overview
 * widget (no API key). `tvSymbol` is an exchange-qualified ticker, e.g.
 * "NASDAQ:AAPL". Only used for public tickers; pre-IPO names have no symbol.
 */
export function StockChart({ tvSymbol, height = 200 }: { tvSymbol: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = ref.current
    if (!host) return
    host.innerHTML = ''
    const widget = document.createElement('div')
    widget.className = 'tradingview-widget-container__widget'
    host.appendChild(widget)

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js'
    script.async = true
    script.innerHTML = JSON.stringify({
      symbol: tvSymbol,
      width: '100%',
      height,
      locale: 'en',
      dateRange: '3M',
      colorTheme: 'light',
      isTransparent: true,
      autosize: true,
    })
    host.appendChild(script)

    return () => { host.innerHTML = '' }
  }, [tvSymbol, height])

  return <div ref={ref} className="tradingview-widget-container w-full" style={{ height }} />
}