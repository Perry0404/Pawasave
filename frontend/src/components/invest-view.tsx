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
// Buyable today (verified on-chain route) listed first; the rest launched on Base but have
// no DEX liquidity yet, so they render as "Soon — verification pending" until we add a route.
const STOCKS: Asset[] = [
  { symbol: 'AAPL', name: 'Apple', tv: 'NASDAQ:AAPL' },
  { symbol: 'NVDA', name: 'NVIDIA', tv: 'NASDAQ:NVDA' },
  { symbol: 'GOOGL', name: 'Alphabet', tv: 'NASDAQ:GOOGL' },
  { symbol: 'META', name: 'Meta', tv: 'NASDAQ:META' },
  { symbol: 'TSLA', name: 'Tesla', tv: 'NASDAQ:TSLA' },
  { symbol: 'MSFT', name: 'Microsoft', tv: 'NASDAQ:MSFT' },
  { symbol: 'AMZN', name: 'Amazon', tv: 'NASDAQ:AMZN' },
  { symbol: 'SNDK', name: 'SanDisk', tv: 'NASDAQ:SNDK' },
  { symbol: 'COIN', name: 'Coinbase', tv: 'NASDAQ:COIN' },
  { symbol: 'INTC', name: 'Intel', tv: 'NASDAQ:INTC' },
  { symbol: 'MSTR', name: 'Strategy (MicroStrategy)', tv: 'NASDAQ:MSTR' },
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
interface Props { wallet: Wallet | null; profile: { kyc_status?: string; strails_onboard_status?: string | null; strails_va_account_number?: string | null } | null; refresh: () => void; onStartKyc: () => void }

const IconLock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>

export default function InvestView({ wallet, profile, refresh, onStartKyc }: Props) {
  const [cat, setCat] = useState<Cat>('naira')
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [brokerLive, setBrokerLive] = useState(false)
  const [supported, setSupported] = useState<string[]>([])
  const [rate, setRate] = useState(1600)
  const [nairaAssets, setNairaAssets] = useState<Asset[]>([])
  const [nairaLive, setNairaLive] = useState(false)
  const [selected, setSelected] = useState<Asset | null>(null)
  const [selectedHolding, setSelectedHolding] = useState<Holding | null>(null)
  const [sellBusy, setSellBusy] = useState(false)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const { quotes } = useStockQuotes(STOCK_SYMBOLS)

  const loadHoldings = () =>
    fetch('/api/invest/equity')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) { setHoldings(d.holdings || []); setBrokerLive(!!d.broker?.live); setSupported((d.supportedSymbols || []).map((s: string) => s.toUpperCase())); setRate(Number(d.rate) || 1600) } })
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
  // A tokenized stock is buyable only if the broker verified an on-chain route for it.
  // Everything else in the catalog is shown as "coming soon — verification pending".
  const stockLive = (sym: string) => brokerLive && supported.includes(String(sym || '').toUpperCase())
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 6000) }
  const isErr = (m: string) => /minimum|verify|could not|wrong|went|didn’t|refund/i.test(m)

  // Poll a background stock buy until it fills or refunds (~2.5 min cap).
  const pollOrder = (orderId: number, symbol: string) => {
    let tries = 0
    const iv = setInterval(async () => {
      tries++
      const d = await fetch('/api/invest/equity').then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (d) {
        setHoldings(d.holdings || []); setBrokerLive(!!d.broker?.live); setSupported((d.supportedSymbols || []).map((s: string) => s.toUpperCase())); setRate(Number(d.rate) || 1600)
        const o = (d.orders || []).find((x: any) => Number(x.id) === orderId)
        if (o && o.status === 'filled') { clearInterval(iv); flash(`Bought ${symbol}! ${Number(o.shares || 0).toFixed(4)} shares now in your portfolio.`); refresh(); return }
        if (o && (o.status === 'failed' || o.status === 'refunded')) { clearInterval(iv); flash(`${symbol} didn’t fill — your cNGN was refunded.`); refresh(); return }
      }
      if (tries >= 20) clearInterval(iv)
    }, 8000)
  }

  // Poll a background sell until it settles (filled → cNGN credited, or failed → shares back).
  const pollSale = (saleId: number, symbol: string) => {
    let tries = 0
    const iv = setInterval(async () => {
      tries++
      const d = await fetch('/api/invest/equity').then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (d) {
        setHoldings(d.holdings || []); setBrokerLive(!!d.broker?.live); setRate(Number(d.rate) || 1600)
        const s = (d.sales || []).find((x: any) => Number(x.id) === saleId)
        if (s && s.status === 'filled') {
          clearInterval(iv)
          flash(`Sold ${symbol} — ₦${(Number(s.cngn_net_micro || 0) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} credited (after ₦500 fee).`)
          refresh(); return
        }
        if (s && s.status === 'failed') { clearInterval(iv); flash(`${symbol} sale didn’t complete — your shares are unchanged.`); refresh(); return }
      }
      if (tries >= 20) clearInterval(iv)
    }, 8000)
  }

  async function buy() {
    // Unverified tokenized stock → coming soon; never debit (mirrors the API guard).
    if (selected && !selected.naira && (cat === 'tokenized_stock' || cat === 'pre_ipo') && !stockLive(selected.symbol)) {
      flash(`${selected.name} isn't buyable yet — verification pending. We'll notify you when it goes live.`)
      return
    }
    const naira = parseFloat(amount)
    if (!naira || naira < 1000) { flash('Minimum investment is ₦1,000'); return }
    // Identity check for investing: BVN onboarding via Strails IS the verification (it's
    // required to get a NUBAN), so a completed onboarding is enough. Full Sense biometric
    // is only needed to lift withdrawal caps — not to buy. Sense-verified also passes.
    const identityOk = profile?.kyc_status === 'verified'
      || profile?.strails_onboard_status === 'completed'
      || !!profile?.strails_va_account_number
    if (!identityOk) {
      flash('Add your BVN to set up your account, then you can invest.')
      onStartKyc()
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
      if (data.status === 'processing') {
        // Stock buys settle in the background (~1–2 min for the solver auction + swaps).
        flash(`${selected!.symbol} order placed — processing (~1–2 min). Your portfolio updates when it fills.`)
        const sym = selected!.symbol
        setAmount(''); setSelected(null)
        pollOrder(Number(data.orderId), sym)
        return
      }
      flash(`Bought ${selected!.symbol}!`)
      setAmount(''); setSelected(null); refresh(); loadHoldings()
    } catch {
      flash('Something went wrong — try again')
    } finally {
      setBusy(false)
    }
  }

  // Current cNGN value of a holding from its live USD quote (null when no market price).
  const holdingValue = (h: Holding): number | null => {
    const q = quotes[h.symbol]
    if (!q?.price || !rate) return null
    return Number(h.shares) * q.price * rate
  }

  async function sell(h: Holding) {
    setSellBusy(true)
    try {
      const res = await fetch('/api/invest/equity/sell', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: h.symbol, shares: h.shares }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 503) { flash('Selling is launching soon.'); return }
      if (!res.ok) { flash(data.error || 'Could not sell'); return }
      if (data.status === 'processing') {
        // Sells settle in the background (stock→USDC→cNGN, ~1–2 min) — poll for the outcome.
        flash(`Selling ${h.symbol} — processing (~1–2 min). Your cNGN is credited when it settles.`)
        setSelectedHolding(null); refresh(); loadHoldings()
        pollSale(Number(data.saleId), h.symbol)
        return
      }
      const net = Number(data.cngnCredited || 0) / 1e6
      flash(`Sold ${h.symbol} — ₦${net.toLocaleString(undefined, { maximumFractionDigits: 2 })} credited`)
      setSelectedHolding(null); refresh(); loadHoldings()
    } catch {
      flash('Something went wrong — try again')
    } finally {
      setSellBusy(false)
    }
  }

  // ── Sell sheet ──
  if (selectedHolding) {
    const h = selectedHolding
    const cost = Number(h.invested_cngn_micro) / 1e6
    const val = holdingValue(h)
    const gain = val != null ? val - cost : null
    const gpct = gain != null && cost > 0 ? (gain / cost) * 100 : null
    const sellable = h.asset_type === 'tokenized_stock'
    const net = val != null ? Math.max(0, val - 500) : null
    return (
      <div className="b">
        <button className="back" onClick={() => setSelectedHolding(null)}>← Back</button>
        <div className="h2">{h.symbol}</div>
        <p className="p">{h.asset_type === 'pre_ipo' ? 'Pre-IPO holding' : h.asset_type === 'rwa' ? 'Naira asset' : 'Tokenized stock'} · {Number(h.shares).toFixed(4)} {h.asset_type === 'rwa' ? 'units' : 'shares'}</p>

        <div className="pool rise" style={{ marginTop: 12 }}>
          <div className="l">Current value</div>
          <div className="v" style={{ fontSize: 24 }}>{val != null ? `₦${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `₦${cost.toLocaleString()} invested`}</div>
          {gain != null && (
            <span className="apy" style={{ color: gain >= 0 ? 'var(--green)' : '#e5484d' }}>
              {gain >= 0 ? '▲' : '▼'} ₦{Math.abs(gain).toLocaleString(undefined, { maximumFractionDigits: 2 })} ({gpct != null ? `${gpct >= 0 ? '+' : ''}${gpct.toFixed(1)}%` : '—'}) · cost ₦{cost.toLocaleString()}
            </span>
          )}
        </div>

        {sellable ? (
          <>
            <div className="note" style={{ marginTop: 14 }}>
              Selling all {Number(h.shares).toFixed(4)} shares. A flat <b>₦500</b> fee applies{net != null ? ` — you'll receive about ₦${net.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}.
            </div>
            {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}
            <button className="cta" onClick={() => sell(h)} disabled={sellBusy}>{sellBusy ? 'Selling…' : `Sell ${h.symbol}`}</button>
          </>
        ) : (
          <div className="note" style={{ marginTop: 14 }}>Selling this asset from the app is coming soon.</div>
        )}
      </div>
    )
  }

  // ── Buy sheet ──
  if (selected) {
    const live = selected.naira ? nairaLive : stockLive(selected.symbol)
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

        {!live && (
          <div className="note">
            {!selected.naira && (cat === 'tokenized_stock' || cat === 'pre_ipo') && brokerLive
              ? `${selected.name} is coming soon — verification pending. Register interest and we’ll notify you the moment it’s buyable.`
              : `Trading is launching soon. Register interest now — we’ll notify you when ${selected.symbol} goes live.`}
          </div>
        )}
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
            {holdings.map(h => {
              const cost = Number(h.invested_cngn_micro) / 1e6
              const val = holdingValue(h)
              const gain = val != null ? val - cost : null
              return (
                <button key={`${h.symbol}-${h.provider}`} className="coll" onClick={() => { setSelectedHolding(h); setMsg('') }}
                  style={{ width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                  <span className="dot" style={{ background: 'var(--surface-2)', color: 'var(--muted)', fontWeight: 700, fontSize: 11 }}>{h.symbol.slice(0, 2)}</span>
                  <div className="mid"><div className="nm">{h.symbol}</div><div className="sub">{h.asset_type === 'pre_ipo' ? 'Pre-IPO' : h.asset_type === 'rwa' ? 'Naira asset' : 'Stock'} · {Number(h.shares).toFixed(4)} {h.asset_type === 'rwa' ? 'units' : 'shares'}</div></div>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div className="v num">₦{(val ?? cost).toLocaleString(undefined, { maximumFractionDigits: val != null ? 2 : 0 })}</div>
                    {gain != null && <div style={{ fontSize: 11, fontWeight: 600, color: gain >= 0 ? 'var(--green)' : '#e5484d' }}>{gain >= 0 ? '+' : '−'}₦{Math.abs(gain).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="sect"><span className="h">{cat === 'tokenized_stock' ? 'Stocks' : cat === 'pre_ipo' ? 'Pre-IPO companies' : 'Regulated Naira assets'}</span></div>
      <div className="rows">
        {list.map(a => {
          const q = a.tv ? quotes[a.symbol] : undefined
          const up = (q?.changePct ?? 0) >= 0
          // Only tokenized stocks are gated per-symbol; naira/pre-IPO keep their own flows.
          const soon = (cat === 'tokenized_stock' || cat === 'pre_ipo') && !stockLive(a.symbol)
          return (
            <button key={a.symbol} className="coll" style={{ width: '100%', background: 'none', border: 0, borderTop: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', opacity: soon ? 0.72 : 1 }} onClick={() => { setSelected(a); setAmount(''); setMsg('') }}>
              <span className="dot" style={{ background: 'var(--surface-2)', color: 'var(--muted)', fontWeight: 700, fontSize: 11 }}>{a.symbol.slice(0, 2)}</span>
              <div className="mid"><div className="nm">{a.name}</div><div className="sub">{a.blurb || a.symbol}</div></div>
              {q && <div style={{ width: 48, height: 28, flex: 'none' }}><Sparkline data={q.spark} up={up} height={28} /></div>}
              {soon ? (
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 999, flex: 'none' }}>Soon</span>
              ) : q ? (
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