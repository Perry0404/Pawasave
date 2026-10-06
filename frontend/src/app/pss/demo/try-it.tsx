'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'

/**
 * "Try it live" for /pss/demo: a guided, four-step walkthrough on Base Sepolia.
 * The visitor gets a throwaway test wallet (kept in this browser), passes mock KYC, then
 * buys, gifts, tries to break the rules, and cashes out. Every step is a real testnet
 * transaction; the server plays broker, custodian and minting service (lib/pss-demo.ts).
 */

const RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC || 'https://sepolia.base.org'
const EXPLORER = 'https://sepolia.basescan.org'
const ADA = '0xc943b344a66FE3D0FCa875c329120459CaA9A430' // a verified demo investor
const KEY = 'pss_demo_wallet_v1'

const ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function verified(address) view returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function requestRedemption(uint256 amount, uint8 kind) returns (uint256)',
  'function redemptionCount() view returns (uint256)',
  'function redemptions(uint256) view returns (address holder, uint256 amount, uint8 kind, uint8 status, uint64 createdAt)',
  'event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 amount, uint8 kind)',
]

type StepKey = 'buy' | 'gift' | 'protect' | 'cashout'
type Status = { state: 'idle' | 'working' | 'done' | 'protected' | 'error'; text?: string; txs?: { label: string; hash: string }[] }

const C = {
  blue: '#0052ff', ink: '#0f172a', muted: '#64748b', line: '#e2e8f0', soft: '#f8fafc',
  green: '#0a7a3d', greenSoft: '#ecfdf3', amber: '#b45309', amberSoft: '#fff7ed', blueSoft: '#eef3ff',
}

async function api(body: Record<string, unknown>) {
  const res = await fetch('/api/pss/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || 'Request failed')
  return d
}

/** Never show raw RPC errors to a visitor. */
function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/not configured/i.test(m)) return 'The live demo is being switched on. Please try again in a few minutes.'
  if (/limit reached/i.test(m)) return 'You have reached the demo limit for now. Please try again later.'
  if (/insufficient funds/i.test(m)) return 'The demo wallet needs a gas top-up. Please try again shortly.'
  return 'The test network was busy. Please try again.'
}

async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2500)) }
  }
  throw last
}

export default function TryIt({ token, onChange }: { token: string; onChange: () => void }) {
  const provider = useMemo(() => new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true }), [])
  const [wallet, setWallet] = useState<ethers.Wallet | null>(null)
  const [verified, setVerified] = useState(false)
  const [balance, setBalance] = useState<bigint>(0n)
  const [qty, setQty] = useState(5)
  const [starting, setStarting] = useState<Status>({ state: 'idle' })
  const [steps, setSteps] = useState<Record<StepKey, Status>>({
    buy: { state: 'idle' }, gift: { state: 'idle' }, protect: { state: 'idle' }, cashout: { state: 'idle' },
  })
  const busy = starting.state === 'working' || Object.values(steps).some((s) => s.state === 'working')
  const set = (k: StepKey, s: Status) => setSteps((x) => ({ ...x, [k]: s }))

  useEffect(() => {
    try { const k = localStorage.getItem(KEY); if (k) setWallet(new ethers.Wallet(k, provider)) } catch { /* session only */ }
  }, [provider])

  const refresh = useCallback(async () => {
    if (!wallet || !ethers.isAddress(token)) return
    const t = new ethers.Contract(token, ABI, provider)
    const [b, v] = await Promise.all([t.balanceOf(wallet.address), t.verified(wallet.address)])
    setBalance(b); setVerified(v)
  }, [wallet, token, provider])

  useEffect(() => {
    refresh().catch(() => {})
    const i = setInterval(() => { refresh().catch(() => {}) }, 5000)
    return () => clearInterval(i)
  }, [refresh])

  // Finish any cash-out this wallet left half-done (e.g. the tab closed mid-way).
  useEffect(() => {
    if (!wallet || !ethers.isAddress(token)) return
    ;(async () => {
      try {
        const t = new ethers.Contract(token, ABI, provider)
        const n = Number(await t.redemptionCount())
        for (let id = Math.max(0, n - 25); id < n; id++) {
          const r = await t.redemptions(id)
          if (String(r.holder).toLowerCase() === wallet.address.toLowerCase() && Number(r.status) === 0) {
            await api({ action: 'settle', address: wallet.address, id }).catch(() => {})
          }
        }
        refresh().catch(() => {}); onChange()
      } catch { /* best effort */ }
    })()
  }, [wallet, token, provider, refresh, onChange])

  const start = async () => {
    setStarting({ state: 'working', text: 'Creating your test investor wallet and running KYC…' })
    try {
      const w = ethers.Wallet.createRandom().connect(provider) as unknown as ethers.Wallet
      try { localStorage.setItem(KEY, w.privateKey) } catch { /* session only */ }
      const r = await api({ action: 'onboard', address: w.address })
      setWallet(w)
      setStarting({ state: 'done', text: 'KYC passed. Your wallet is on the issuer\'s verified register.', txs: r.txs?.[0] ? [{ label: 'KYC', hash: r.txs[0] }] : [] })
    } catch (e) { setStarting({ state: 'error', text: friendly(e) }) }
  }

  const buy = async () => {
    set('buy', { state: 'working', text: `Broker buys ${qty} MTN shares on NGX → CSCS settles → custodian confirms…` })
    try {
      const r = await api({ action: 'buy', address: wallet!.address, quantity: qty })
      set('buy', { state: 'done', text: `${qty} tokens minted to you, each backed by a share the custodian confirmed.`,
        txs: [{ label: 'Custodian pool', hash: r.reserveTx }, { label: 'Mint', hash: r.mintTx }] })
    } catch (e) { set('buy', { state: 'error', text: friendly(e) }) }
    refresh().catch(() => {}); onChange()
  }

  const gift = async () => {
    set('gift', { state: 'working', text: 'Sending 1 share to Ada…' })
    try {
      const t = new ethers.Contract(token, ABI, wallet!)
      const tx = await retry(() => t.transfer(ADA, 1n))
      await tx.wait(1)
      set('gift', { state: 'done', text: 'Ada received 1 share in seconds, with no broker and no sale.', txs: [{ label: 'Transfer', hash: tx.hash }] })
    } catch (e) { set('gift', { state: 'error', text: friendly(e) }) }
    refresh().catch(() => {}); onChange()
  }

  const protect = async () => {
    set('protect', { state: 'working', text: 'Trying to send 1 share to a stranger who has not done KYC…' })
    try {
      const t = new ethers.Contract(token, ABI, wallet!)
      await t.transfer.staticCall(ethers.Wallet.createRandom().address, 1n)
      set('protect', { state: 'error', text: 'Unexpected: the transfer was not refused.' })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (/unverified/i.test(m)) set('protect', { state: 'protected', text: 'Refused by the smart contract: only verified investors can hold this token.' })
      else set('protect', { state: 'error', text: friendly(e) })
    }
  }

  const cashout = async () => {
    set('cashout', { state: 'working', text: 'Locking 1 share while the broker sells it…' })
    try {
      const t = new ethers.Contract(token, ABI, wallet!)
      const tx = await retry(() => t.requestRedemption(1n, 0))
      const rc = await tx.wait(1)
      const ev = rc!.logs.map((l: ethers.Log) => { try { return t.interface.parseLog(l) } catch { return null } })
        .find((p: ethers.LogDescription | null) => p?.name === 'RedemptionRequested')
      const id = Number(ev!.args.id)
      set('cashout', { state: 'working', text: 'Share locked. Sale settling and cNGN paying out…', txs: [{ label: 'Lock', hash: tx.hash }] })
      const r = await retry(() => api({ action: 'settle', address: wallet!.address, id }), 3)
      set('cashout', { state: 'done', text: 'Paid out, then the token was burned. You were never without the share or the money.',
        txs: [{ label: 'Lock', hash: tx.hash }, ...(r.burnTx ? [{ label: 'Burn', hash: r.burnTx }] : [])] })
    } catch (e) { set('cashout', { state: 'error', text: friendly(e) }) }
    refresh().catch(() => {}); onChange()
  }

  const reset = () => {
    try { localStorage.removeItem(KEY) } catch { /* ignore */ }
    setWallet(null); setBalance(0n); setVerified(false); setStarting({ state: 'idle' })
    setSteps({ buy: { state: 'idle' }, gift: { state: 'idle' }, protect: { state: 'idle' }, cashout: { state: 'idle' } })
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  const Button = ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={busy || disabled}
      style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: 'none', background: C.blue, color: '#fff', fontWeight: 600, fontSize: 14,
        cursor: busy || disabled ? 'not-allowed' : 'pointer', opacity: busy || disabled ? 0.45 : 1 }}>
      {children}
    </button>
  )

  const Result = ({ s }: { s: Status }) => {
    if (s.state === 'idle') return null
    const palette = {
      working: { bg: C.blueSoft, fg: C.blue, icon: '◌' },
      done: { bg: C.greenSoft, fg: C.green, icon: '✓' },
      protected: { bg: C.greenSoft, fg: C.green, icon: '🛡' },
      error: { bg: C.amberSoft, fg: C.amber, icon: '!' },
    }[s.state]
    return (
      <div style={{ marginTop: 12, background: palette.bg, color: palette.fg, borderRadius: 10, padding: '10px 12px', fontSize: 13, lineHeight: 1.45 }}>
        <span style={{ fontWeight: 700, marginRight: 6 }}>{palette.icon}</span>{s.text}
        {s.txs && s.txs.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {s.txs.map((t) => <a key={t.hash} href={`${EXPLORER}/tx/${t.hash}`} target="_blank" rel="noreferrer" style={{ color: C.blue, fontSize: 12, fontWeight: 600 }}>{t.label} receipt ↗</a>)}
          </div>
        )}
      </div>
    )
  }

  const Card = ({ n, title, desc, children, status }: { n: number; title: string; desc: string; children: React.ReactNode; status: Status }) => (
    <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ width: 26, height: 26, borderRadius: 13, background: status.state === 'done' || status.state === 'protected' ? C.green : C.blue, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700, flex: 'none' }}>
          {status.state === 'done' || status.state === 'protected' ? '✓' : n}
        </span>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
      </div>
      <p style={{ color: C.muted, fontSize: 13, margin: '0 0 12px', lineHeight: 1.45, flex: 1 }}>{desc}</p>
      {children}
      <Result s={status} />
    </div>
  )

  return (
    <section style={{ background: C.soft, border: `1px solid ${C.line}`, borderRadius: 18, padding: 20, marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 20, margin: 0 }}>Try it live</h2>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.blue, background: C.blueSoft, padding: '3px 10px', borderRadius: 999 }}>Real transactions · Base Sepolia testnet</span>
      </div>
      <p style={{ color: C.muted, fontSize: 14, margin: '6px 0 16px', lineHeight: 1.5 }}>
        Act as an investor. This page plays the broker, the custodian and PawaSave, while the smart contract enforces every rule.
      </p>

      {!wallet ? (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 14, padding: 20, textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Start as a new investor</div>
          <p style={{ color: C.muted, fontSize: 13, margin: '0 auto 14px', maxWidth: 440 }}>We&apos;ll create a test wallet for you in this browser and run KYC, adding you to the issuer&apos;s verified register.</p>
          <div style={{ maxWidth: 280, margin: '0 auto' }}><Button onClick={start}>{starting.state === 'working' ? 'Setting up…' : 'Start the demo'}</Button></div>
          <Result s={starting} />
        </div>
      ) : (
        <>
          <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: C.muted }}>Your holdings</div>
              <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{String(balance)} <span style={{ fontSize: 15, fontWeight: 600, color: C.muted }}>MTN shares</span></div>
              <div style={{ fontSize: 12, color: C.muted }}>held for you by the custodian, as pMTNN tokens</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 13 }}>
              <div><span style={{ color: C.muted }}>KYC </span><b style={{ color: verified ? C.green : C.amber }}>{verified ? 'Verified' : 'Pending…'}</b></div>
              <a href={`${EXPLORER}/address/${wallet.address}`} target="_blank" rel="noreferrer" style={{ color: C.blue, fontSize: 12 }}>{wallet.address.slice(0, 6)}…{wallet.address.slice(-4)} ↗</a>
              <div><button onClick={reset} disabled={busy} style={{ background: 'none', border: 'none', color: C.muted, fontSize: 12, cursor: 'pointer', padding: 0, marginTop: 4, textDecoration: 'underline' }}>Start over</button></div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            <Card n={1} title="Buy shares" desc="The broker buys real shares, the custodian confirms it holds them, and only then are tokens created." status={steps.buy}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {[1, 5, 10].map((q) => (
                  <button key={q} onClick={() => setQty(q)} disabled={busy}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: `1px solid ${qty === q ? C.blue : C.line}`, background: qty === q ? C.blueSoft : '#fff', color: qty === q ? C.blue : C.ink, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    {q}
                  </button>
                ))}
              </div>
              <Button onClick={buy} disabled={!verified}>{steps.buy.state === 'working' ? 'Buying…' : `Buy ${qty} MTN`}</Button>
            </Card>

            <Card n={2} title="Gift a share" desc="Send a share to Ada, another verified investor. It arrives instantly, with no broker and no sale." status={steps.gift}>
              <Button onClick={gift} disabled={balance < 1n}>{steps.gift.state === 'working' ? 'Sending…' : 'Send 1 share to Ada'}</Button>
            </Card>

            <Card n={3} title="Try to break the rules" desc="Try sending to a stranger who hasn't done KYC. The contract itself should refuse." status={steps.protect}>
              <Button onClick={protect} disabled={balance < 1n}>{steps.protect.state === 'working' ? 'Trying…' : 'Send to an unverified wallet'}</Button>
            </Card>

            <Card n={4} title="Cash out" desc="The share is locked, sold and paid out in cNGN, and only then is the token burned." status={steps.cashout}>
              <Button onClick={cashout} disabled={balance < 1n}>{steps.cashout.state === 'working' ? 'Cashing out…' : 'Cash out 1 share'}</Button>
            </Card>
          </div>
        </>
      )}
    </section>
  )
}
