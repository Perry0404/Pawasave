'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'

/**
 * "Try it live" panel for /pss/demo. The visitor gets a throwaway Base Sepolia wallet (kept in
 * this browser only), passes mock KYC, buys shares (the server plays broker + custodian + minting
 * service), sends some to Ada, attempts a send to an unverified wallet, and redeems for cash.
 * Every step is a real testnet transaction.
 */

const RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC || 'https://sepolia.base.org'
const EXPLORER = 'https://sepolia.basescan.org'
const ADA = '0xc943b344a66FE3D0FCa875c329120459CaA9A430'   // a verified demo investor
const KEY = 'pss_demo_wallet_v1'

const ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function verified(address) view returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function requestRedemption(uint256 amount, uint8 kind) returns (uint256)',
  'event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 amount, uint8 kind)',
]

type Log = { text: string; tone: 'ok' | 'warn' | 'info'; tx?: string }

async function api(body: Record<string, unknown>) {
  const res = await fetch('/api/pss/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || 'Request failed')
  return d
}

export default function TryIt({ token, onChange }: { token: string; onChange: () => void }) {
  const provider = useMemo(() => new ethers.JsonRpcProvider(RPC, 84532, { staticNetwork: true }), [])
  const [wallet, setWallet] = useState<ethers.Wallet | null>(null)
  const [isVerified, setIsVerified] = useState(false)
  const [balance, setBalance] = useState<bigint>(0n)
  const [qty, setQty] = useState('10')
  const [busy, setBusy] = useState('')
  const [log, setLog] = useState<Log[]>([])

  const add = (l: Log) => setLog((x) => [l, ...x].slice(0, 30))

  useEffect(() => {
    try {
      const k = localStorage.getItem(KEY)
      if (k) setWallet(new ethers.Wallet(k, provider))
    } catch { /* storage blocked: the visitor can still create a wallet for this session */ }
  }, [provider])

  const refresh = useCallback(async () => {
    if (!wallet || !ethers.isAddress(token)) return
    const t = new ethers.Contract(token, ABI, provider)
    const [b, v] = await Promise.all([t.balanceOf(wallet.address), t.verified(wallet.address)])
    setBalance(b); setIsVerified(v)
  }, [wallet, token, provider])

  // Poll while a wallet is loaded: public RPC nodes can lag the transaction that just landed.
  useEffect(() => {
    refresh()
    const t = setInterval(() => { refresh().catch(() => {}) }, 5_000)
    return () => clearInterval(t)
  }, [refresh])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try { await fn() } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      add({ text: m.match(/execution reverted:\s*"?([^"\n(]+)/)?.[1]?.trim() || m.slice(0, 140), tone: 'warn' })
    } finally { setBusy(''); refresh(); onChange() }
  }

  const create = () => run('Creating wallet', async () => {
    const w = ethers.Wallet.createRandom().connect(provider)
    try { localStorage.setItem(KEY, w.privateKey) } catch { /* session only */ }
    setWallet(w as unknown as ethers.Wallet)
    add({ text: `Test wallet created: ${w.address.slice(0, 10)}…`, tone: 'info' })
    const r = await api({ action: 'onboard', address: w.address })
    add({ text: 'KYC passed: wallet added to the issuer\'s verified register and given test gas', tone: 'ok', tx: r.txs?.[0] })
  })

  const buy = () => run('Buying', async () => {
    const q = Math.floor(Number(qty))
    add({ text: `Order: buy ${q} MTNN. Broker executes on NGX, CSCS settles, custodian signs…`, tone: 'info' })
    const r = await api({ action: 'buy', address: wallet!.address, quantity: q })
    add({ text: `Custodian's pool reported on-chain (${r.tradeId})`, tone: 'info', tx: r.reserveTx })
    add({ text: `Minted ${q} pMTNN to you against the custodian's signature`, tone: 'ok', tx: r.mintTx })
  })

  const send = (to: string, label: string) => run('Sending', async () => {
    const t = new ethers.Contract(token, ABI, wallet!)
    const tx = await t.transfer(to, 1n)
    await tx.wait(1)
    add({ text: `Sent 1 share to ${label}, instantly, with no broker sale`, tone: 'ok', tx: tx.hash })
  })

  const redeem = () => run('Redeeming', async () => {
    const t = new ethers.Contract(token, ABI, wallet!)
    const tx = await t.requestRedemption(1n, 0)
    const rc = await tx.wait(1)
    const ev = rc!.logs.map((l: ethers.Log) => { try { return t.interface.parseLog(l) } catch { return null } }).find((p: ethers.LogDescription | null) => p?.name === 'RedemptionRequested')
    const id = Number(ev!.args.id)
    add({ text: `Redemption #${id}: 1 share locked (not burned) while the sale settles`, tone: 'info', tx: tx.hash })
    const r = await api({ action: 'settle', address: wallet!.address, id })
    add({ text: 'Sale settled and cNGN paid, so the locked token is burned and the pool reduced', tone: 'ok', tx: r.burnTx })
  })

  const reset = () => { try { localStorage.removeItem(KEY) } catch { /* ignore */ } setWallet(null); setLog([]); setBalance(0n) }

  const btn = (label: string, onClick: () => void, disabled = false, ghost = false) => (
    <button onClick={onClick} disabled={!!busy || disabled}
      style={{ padding: '9px 14px', borderRadius: 10, border: ghost ? '1px solid #cbd5e1' : 'none', background: ghost ? '#fff' : '#0052ff', color: ghost ? '#0f172a' : '#fff', fontWeight: 600, fontSize: 14, cursor: busy || disabled ? 'default' : 'pointer', opacity: busy || disabled ? 0.5 : 1 }}>
      {label}
    </button>
  )
  const tone = { ok: '#0a7a3d', warn: '#b45309', info: '#334155' }

  return (
    <div style={{ border: '2px solid #0052ff', borderRadius: 14, padding: 20, marginBottom: 16 }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Try it live</div>
      <p style={{ color: '#475569', fontSize: 14, margin: '0 0 14px', lineHeight: 1.5 }}>
        Every step below is a real transaction on Base Sepolia. This page plays the broker, the custodian and the minting service, so you can see the rules enforced by the contract.
      </p>

      {!wallet ? (
        btn(busy || 'Get a test wallet and pass KYC', create)
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14, marginBottom: 14 }}>
            <span>Your wallet: <a href={`${EXPLORER}/address/${wallet.address}`} target="_blank" rel="noreferrer" style={{ color: '#0052ff' }}>{wallet.address.slice(0, 10)}…</a></span>
            <span>KYC: <b style={{ color: isVerified ? tone.ok : tone.warn }}>{isVerified ? 'verified' : 'pending'}</b></span>
            <span>You hold: <b>{String(balance)} pMTNN</b></span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
              style={{ width: 64, padding: '8px 10px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 14 }} />
            {btn(busy === 'Buying' ? 'Buying…' : 'Buy MTNN', buy, !isVerified || !(Number(qty) >= 1 && Number(qty) <= 50))}
            {btn('Send 1 to Ada (verified)', () => send(ADA, 'Ada'), balance < 1n, true)}
            {btn('Send 1 to an unverified wallet', () => send(ethers.Wallet.createRandom().address, 'a stranger'), balance < 1n, true)}
            {btn('Redeem 1 for cash', redeem, balance < 1n, true)}
            {btn('Reset', reset, false, true)}
          </div>
          {busy && <div style={{ fontSize: 13, color: '#64748b', marginTop: 10 }}>{busy}… waiting for Base Sepolia</div>}
        </>
      )}

      {log.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>
          {log.map((l, i) => (
            <div key={i} style={{ fontSize: 13, padding: '4px 0', color: tone[l.tone] }}>
              {l.tone === 'warn' ? '✖ Blocked: ' : l.tone === 'ok' ? '✔ ' : '• '}{l.text}
              {l.tx && <> · <a href={`${EXPLORER}/tx/${l.tx}`} target="_blank" rel="noreferrer" style={{ color: '#0052ff' }}>tx ↗</a></>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
