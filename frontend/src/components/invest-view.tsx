'use client'

import { useEffect, useState } from 'react'
import { TrendingUp, Loader2, ArrowLeft, Sparkles, ShieldCheck, Lock } from 'lucide-react'
import type { Wallet } from '@/lib/types'
import { StockChart, MarketTickers } from './stock-chart'

/**
 * InvestView — buy tokenized stocks (xStocks) and pre-IPO tokens with cNGN.
 * The buy flow is real (POST /api/invest/equity); it surfaces "coming soon"
 * until the broker (Coinbase Tokenize) is enabled server-side. Catalogue is
 * curated here for now; it can move to an API once the broker is live.
 */
type Cat = 'tokenized_stock' | 'pre_ipo'

type Asset = { symbol: string; name: string; tv?: string }
const STOCKS: Asset[] = [
  { symbol: 'AAPL', name: 'Apple', tv: 'NASDAQ:AAPL' },
  { symbol: 'NVDA', name: 'NVIDIA', tv: 'NASDAQ:NVDA' },
  { symbol: 'TSLA', name: 'Tesla', tv: 'NASDAQ:TSLA' },
  { symbol: 'MSFT', name: 'Microsoft', tv: 'NASDAQ:MSFT' },
  { symbol: 'GOOGL', name: 'Alphabet', tv: 'NASDAQ:GOOGL' },
  { symbol: 'AMZN', name: 'Amazon', tv: 'NASDAQ:AMZN' },
  { symbol: 'META', name: 'Meta', tv: 'NASDAQ:META' },
  { symbol: 'SPY', name: 'S&P 500 ETF', tv: 'AMEX:SPY' },
]
const PREIPO: Asset[] = [
  { symbol: 'SPCX', name: 'SpaceX' },
  { symbol: 'STRIPE', name: 'Stripe' },
  { symbol: 'OPENAI', name: 'OpenAI' },
  { symbol: 'ANTHROPIC', name: 'Anthropic' },
  { symbol: 'DATABRICKS', name: 'Databricks' },
]
// Stable reference (module-level) for the live ticker cards.
const STOCK_TICKERS = STOCKS.filter(s => s.tv).map(s => ({ proName: s.tv as string, title: s.name }))

interface Holding { symbol: string; asset_type: Cat; provider: string; invested_cngn_micro: number; shares: number }
interface Props { wallet: Wallet | null; profile: { kyc_status?: string } | null; refresh: () => void; onStartKyc: () => void }

export default function InvestView({ wallet, profile, refresh, onStartKyc }: Props) {
  const [cat, setCat] = useState<Cat>('tokenized_stock')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [brokerLive, setBrokerLive] = useState(false)
  const [selected, setSelected] = useState<Asset | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const loadHoldings = () =>
    fetch('/api/invest/equity')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) { setHoldings(d.holdings || []); setBrokerLive(!!d.broker?.live) } })
      .catch(() => undefined)

  useEffect(() => { loadHoldings() }, [])

  const list = cat === 'tokenized_stock' ? STOCKS : PREIPO
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000) }

  async function buy() {
    const naira = parseFloat(amount)
    if (!naira || naira < 1000) { flash('Minimum investment is ₦1,000'); return }
    if (profile?.kyc_status !== 'verified') { flash('Verify your identity (KYC) to invest.'); onStartKyc(); return }
    setBusy(true)
    try {
      const res = await fetch('/api/invest/equity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetType: cat,
          symbol: selected!.symbol,
          amountCngnMicro: Math.floor(naira * 1_000_000).toString(),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 503) { flash(`${selected!.name} is launching soon — we'll notify you when it's buyable.`); return }
      if (res.status === 403) { flash('Verify your identity (KYC) to invest.'); onStartKyc(); return }
      if (!res.ok) { flash(data.error || 'Could not complete purchase'); return }
      flash(`Bought ${selected!.symbol}!`)
      setAmount(''); setSelected(null); refresh(); loadHoldings()
    } catch {
      flash('Something went wrong — try again')
    } finally {
      setBusy(false)
    }
  }

  // ── Buy sheet ──────────────────────────────────────────────────────────────
  if (selected) {
    return (
      <div className="px-4 pt-5">
        <button onClick={() => { setSelected(null); setAmount('') }} className="flex items-center gap-1 text-sm text-slate-500 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-lg font-bold text-slate-900 mb-1">Buy {selected.name}</h2>
        <p className="text-sm text-slate-400 mb-4">
          {cat === 'pre_ipo' ? 'Pre-IPO exposure' : 'Tokenized stock'} · paid from your cNGN balance
        </p>

        {/* Live price chart for public tickers; pre-IPO has no public market. */}
        {selected.tv ? (
          <div className="mb-5 rounded-xl border border-slate-200 overflow-hidden bg-white">
            <StockChart tvSymbol={selected.tv} height={200} />
          </div>
        ) : (
          <div className="mb-5 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-500">
            <Lock className="w-4 h-4 flex-shrink-0" />
            <span>{selected.name} is a private company — no public market price. Valued at each funding round.</span>
          </div>
        )}

        <label className="text-xs text-slate-500">Amount (cNGN)</label>
        <div className="relative mt-1 mb-2">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg font-medium">₦</span>
          <input
            type="number" inputMode="numeric" value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="0"
            className="w-full pl-10 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
            autoFocus
          />
        </div>
        <p className="text-[11px] text-slate-400 mb-4">
          Minimum ₦1,000 · Available ₦{((wallet?.usdc_balance_micro || 0) / 1_000_000).toLocaleString()}
        </p>

        {!brokerLive && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
            <p className="text-xs text-amber-700">Trading is launching soon. You can place interest now — we’ll notify you when {selected.symbol} goes live.</p>
          </div>
        )}
        {msg && <p className="text-sm text-emerald-700 mb-3">{msg}</p>}

        <button onClick={buy} disabled={busy || !amount}
          className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition active:scale-[0.98]">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />}
          {brokerLive ? `Buy ${selected.symbol}` : `Notify me about ${selected.symbol}`}
        </button>
      </div>
    )
  }

  // ── Market list ──────────────────────────────────────────────────────────────
  return (
    <div className="px-4 pt-5 pb-6">
      <div className="flex items-center gap-2 mb-1">
        <TrendingUp className="w-5 h-5 text-emerald-600" />
        <h2 className="text-lg font-bold text-slate-900">Global Markets</h2>
      </div>
      <p className="text-sm text-slate-400 mb-4">Own US stocks and pre-IPO companies with your cNGN.</p>

      {!brokerLive && (
        <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4">
          <Sparkles className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-emerald-700">Tokenized stocks &amp; pre-IPO are launching soon. Browse and register interest now.</p>
        </div>
      )}

      {/* Category toggle */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 mb-4">
        {([['tokenized_stock', 'Stocks'], ['pre_ipo', 'Pre-IPO']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setCat(id)}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${cat === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Live quotes (price + % change) for the public tickers. */}
      {cat === 'tokenized_stock' && (
        <div className="mb-4">
          <MarketTickers symbols={STOCK_TICKERS} />
        </div>
      )}

      {msg && <p className="text-sm text-emerald-700 mb-3">{msg}</p>}

      {/* Holdings */}
      {holdings.length > 0 && (
        <div className="mb-5">
          <p className="text-xs font-semibold text-slate-500 mb-2">Your portfolio</p>
          <div className="space-y-2">
            {holdings.map(h => (
              <div key={`${h.symbol}-${h.provider}`} className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-900">{h.symbol}</p>
                  <p className="text-[11px] text-slate-400">{h.asset_type === 'pre_ipo' ? 'Pre-IPO' : 'Stock'} · {Number(h.shares).toFixed(4)} shares</p>
                </div>
                <p className="text-sm font-semibold text-slate-700">₦{(Number(h.invested_cngn_micro) / 1e6).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Catalogue */}
      <div className="space-y-2">
        {list.map(a => (
          <button key={a.symbol} onClick={() => { setSelected(a); setAmount(''); setMsg('') }}
            className="w-full flex items-center justify-between bg-white border border-slate-200 hover:border-emerald-400 rounded-xl px-4 py-3.5 transition text-left">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-700">
                {a.symbol.slice(0, 2)}
              </div>
              <div>
                <p className="text-sm font-bold text-slate-900">{a.name}</p>
                <p className="text-[11px] text-slate-400">{a.symbol}</p>
              </div>
            </div>
            <span className="text-xs font-semibold text-emerald-600">Buy →</span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 mt-5 text-[11px] text-slate-400">
        <ShieldCheck className="w-3.5 h-3.5" />
        <span>Tokenized equities are backed 1:1 and require identity verification (KYC).</span>
      </div>
    </div>
  )
}