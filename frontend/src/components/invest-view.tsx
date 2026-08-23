'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Wallet } from '@/lib/types'
import { useStockQuotes, MarketCards, StockQuotePanel, ChangeBadge, Sparkline } from './stock-chart'

/**
 * InvestView — buy tokenized stocks (xStocks) and pre-IPO tokens with cNGN.
 * The buy flow is real (POST /api/invest/equity); it surfaces "coming soon"
 * until the broker (Coinbase Tokenize) is enabled server-side.
 */
type Cat = 'tokenized_stock' | 'pre_ipo' | 'naira'

type Asset = {
  symbol: string; name: string; tv?: string
  // Naira/GetEquity assets carry these instead of a TradingView chart:
  blurb?: string; kind?: 'term' | 'fund' | 'equity'; token?: string | null; naira?: boolean
}
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
const STOCK_SYMBOLS = STOCKS.map(s => s.symbol)

interface Holding { symbol: string; asset_type: string; provider: string; invested_cngn_micro: number; shares: number }
interface Props { wallet: Wallet | null; profile: { kyc_status?: string } | null; refresh: () => void; onStartKyc: () => void }

const IconLock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>

export default function InvestView({ wallet, profile, refresh, onStartKyc }: Props) {
  const [cat, setCat] = useState<Cat>('naira')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [brokerLive, setBrokerLive] = useState(false)
  const [nairaAssets, setNairaAssets] = useState<Asset[]>([])
  const [nairaLive, setNairaLive] = useState(false)
  const [selected, setSelected] = useState<Asset | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const { quotes } = useStockQuotes(STOCK_SYMBOLS)

  const loadHoldings = () =>
    fetch('/api/invest/equity')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) { setHoldings(d.holdings || []); setBrokerLive(!!d.broker?.live) } })
      .catch(() => undefined)

  const loadNaira = () =>
    fetch('/api/invest/getequity')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return
        setNairaAssets((d.assets || []).map((a: any) => ({
          symbol: a.symbol, name: a.name, blurb: a.blurb, kind: a.kind, token: a.token, naira: true,
        })))
        setNairaLive(!!d.live)
      })
      .catch(() => undefined)

  useEffect(() => { loadHoldings(); loadNaira() }, [])

  const list: Asset[] = cat === 'tokenized_stock' ? STOCKS : cat === 'pre_ipo' ? PREIPO : nairaAssets
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000) }
  const isErr = (m: string) => /minimum|verify|could not|wrong|went/i.test(m)

  async function buy() {
    const naira = parseFloat(amount)
    if (!naira || naira < 1000) { flash('Minimum investment is ₦1,000'); return }
    if (profile?.kyc_status !== 'verified') {
      const kycOn = process.env.NEXT_PUBLIC_KYC_ENABLED === 'true'
      flash(kycOn ? 'Verify your identity (KYC) to invest.' : 'Investing needs identity verification — coming soon.')
      if (kycOn) onStartKyc()
      return
    }
    setBusy(true)
    try {
      const micro = Math.floor(naira * 1_000_000).toString()
      const res = selected!.naira
        ? await fetch('/api/invest/getequity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: selected!.symbol, token: selected!.token, amountCngnMicro: micro }),
          })
        : await fetch('/api/invest/equity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetType: cat, symbol: selected!.symbol, amountCngnMicro: micro }),
          })
      const data = await res.json().catch(() => ({}))
      if (res.status === 503) { flash(`${selected!.name} is launching soon — we'll notify you when it's buyable.`); return }
      if (res.status === 403) {
        const kycOn = process.env.NEXT_PUBLIC_KYC_ENABLED === 'true'
        flash(kycOn ? 'Verify your identity (KYC) to invest.' : 'Investing needs identity verification — coming soon.')
        if (kycOn) onStartKyc()
        return
      }
      if (!res.ok) { flash(data.error || 'Could not complete purchase'); return }
      flash(`Bought ${selected!.symbol}!`)
      setAmount(''); setSelected(null); refresh(); loadHoldings()
    } catch {
      flash('Something went wrong — try again')
    } finally {
      setBusy(false)
    }
  }

  // ── Buy sheet ──
  if (selected) {
    const live = selected.naira ? nairaLive : brokerLive
    const nairaNote = selected.kind === 'term'
      ? `${selected.blurb || 'Fixed income'} — earns yield to maturity; sell any time at market price.`
      : selected.kind === 'fund'
      ? `${selected.blurb || 'Income fund'} — earns yield; sell any time at market price.`
      : `${selected.blurb || 'Regulated Nigerian investment'} — sell any time at market price.`
    return (
      <div className="b">
        <button className="back" onClick={() => { setSelected(null); setAmount('') }}>← Back</button>
        <div className="h2">Buy {selected.name}</div>
        <p className="p">{selected.naira ? 'Regulated investment (Naira)' : cat === 'pre_ipo' ? 'Pre-IPO exposure' : 'Tokenized stock'} · paid from your cNGN balance</p>

        {selected.naira ? (
          <div className="note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--muted)' }}><IconLock /></span>
            <span>{nairaNote}</span>
          </div>
        ) : selected.tv ? (
          <div style={{ marginBottom: 16 }}><StockQuotePanel quote={quotes[selected.symbol]} /></div>
        ) : (
          <div className="note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--muted)' }}><IconLock /></span>
            <span>{selected.name} is a private company — no public market price. Valued at each funding round.</span>
          </div>
        )}

        <label className="lab" style={{ marginTop: 14 }}>Amount (cNGN)</label>
        <input className="field" type="number" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" autoFocus />
        <p className="p" style={{ margin: '6px 3px 0' }}>Minimum ₦1,000 · Available ₦{((wallet?.usdc_balance_micro || 0) / 1_000_000).toLocaleString()}</p>

        {!live && <div className="note">Trading is launching soon. Register interest now — we’ll notify you when {selected.symbol} goes live.</div>}
        {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}

        <button className="cta" onClick={buy} disabled={busy || !amount}>{busy ? 'Processing…' : live ? `Buy ${selected.symbol}` : `Notify me about ${selected.symbol}`}</button>
      </div>
    )
  }

  // ── Market list ──
  return (
    <div className="b">
      <div className="pool rise">
        <div className="l">{cat === 'naira' ? 'Naira markets' : 'Global markets'}</div>
        <div className="v" style={{ fontSize: 20 }}>{cat === 'naira' ? 'T-bills, funds & IPOs' : 'Own US stocks & pre-IPO'}</div>
        <span className="apy">Buy with your cNGN · {cat === 'naira' ? 'regulated & on-chain' : 'backed 1:1'}</span>
      </div>

      {cat !== 'naira' && !brokerLive && <div className="note">Tokenized stocks &amp; pre-IPO are launching soon. Browse and register interest now.</div>}
      {cat === 'naira' && !nairaLive && <div className="note">Regulated Naira investments (T-bills, funds, REITs) are launching soon. Browse and register interest now.</div>}

      <div className="terms" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 14 }}>
        {([['naira', 'Naira assets'], ['tokenized_stock', 'Stocks'], ['pre_ipo', 'Pre-IPO']] as const).map(([id, label]) => (
          <button key={id} className={`term${cat === id ? ' on' : ''}`} onClick={() => setCat(id)}>{label}</button>
        ))}
      </div>

      {cat === 'tokenized_stock' && <div style={{ marginTop: 14 }}><MarketCards stocks={STOCKS} quotes={quotes} /></div>}

      {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}

      {holdings.length > 0 && (
        <>
          <div className="sect"><span className="h">Your portfolio</span></div>
          <div className="rows">
            {holdings.map(h => (
              <div key={`${h.symbol}-${h.provider}`} className="coll">
                <span className="dot" style={{ background: 'var(--surface-2)', color: 'var(--muted)', fontWeight: 700, fontSize: 11 }}>{h.symbol.slice(0, 2)}</span>
                <div className="mid"><div className="nm">{h.symbol}</div><div className="sub">{h.asset_type === 'pre_ipo' ? 'Pre-IPO' : h.asset_type === 'rwa' ? 'Naira asset' : 'Stock'} · {Number(h.shares).toFixed(4)} {h.asset_type === 'rwa' ? 'units' : 'shares'}</div></div>
                <span className="v num">₦{(Number(h.invested_cngn_micro) / 1e6).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sect"><span className="h">{cat === 'tokenized_stock' ? 'Stocks' : cat === 'pre_ipo' ? 'Pre-IPO companies' : 'Regulated Naira assets'}</span></div>
      <div className="rows">
        {list.map(a => {
          const q = a.tv ? quotes[a.symbol] : undefined
          const up = (q?.changePct ?? 0) >= 0
          return (
            <button key={a.symbol} className="coll" style={{ width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }} onClick={() => { setSelected(a); setAmount(''); setMsg('') }}>
              <span className="dot" style={{ background: 'var(--surface-2)', color: 'var(--muted)', fontWeight: 700, fontSize: 11 }}>{a.symbol.slice(0, 2)}</span>
              <div className="mid"><div className="nm">{a.name}</div><div className="sub">{a.blurb || a.symbol}</div></div>
              {q && <div style={{ width: 48, height: 28, flex: 'none' }}><Sparkline data={q.spark} up={up} height={28} /></div>}
              {q ? (
                <div style={{ textAlign: 'right', flex: 'none', minWidth: 62 }}>
                  <div className="v num">{q.price != null ? `${q.currency === 'USD' ? '$' : ''}${q.price.toFixed(2)}` : '—'}</div>
                  <ChangeBadge q={q} />
                </div>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--green)', flex: 'none' }}>Buy →</span>
              )}
            </button>
          )
        })}
      </div>

      <p className="p" style={{ margin: '14px 3px 0' }}>Tokenized equities are backed 1:1 and require identity verification (KYC).</p>
    </div>
  )
}