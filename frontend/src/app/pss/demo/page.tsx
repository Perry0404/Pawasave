'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ethers } from 'ethers'
import TryIt from './try-it'

/**
 * /pss/demo — live view of a PSS-1 NGX equity token on Base Sepolia (testnet).
 *
 * Reads everything straight from the chain, so what it shows is what the contract enforces:
 * backing (custodian-reported CSCS pool vs token supply), mint status, locked redemptions,
 * the corporate-action multiplier and the event trail. Token address comes from ?token=0x…
 * or NEXT_PUBLIC_PSS_DEMO_TOKEN. Read-only; no wallet needed.
 */

const RPC = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC || 'https://sepolia.base.org'
const EXPLORER = 'https://sepolia.basescan.org'

const ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function ngxSymbol() view returns (string)',
  'function isin() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function lockedSupply() view returns (uint256)',
  'function lastReserveShares() view returns (uint256)',
  'function lastReserveAt() view returns (uint64)',
  'function mintHalted() view returns (bool)',
  'function haltReason() view returns (string)',
  'function multiplier() view returns (uint256)',
  'function custodianSigner() view returns (address)',
  'function paused() view returns (bool)',
  'event MintedAgainstSettlement(address indexed to, uint256 amount, bytes32 indexed tradeRef)',
  'event ReserveReported(uint256 reserveShares, uint256 supply, bytes32 statementHash, bool shortfall)',
  'event MintHaltChanged(bool halted, string reason)',
  'event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 amount, uint8 kind)',
  'event RedemptionCompleted(uint256 indexed id, bytes32 settlementRef)',
  'event RedemptionCancelled(uint256 indexed id, string reason)',
  'event MultiplierChanged(uint256 multiplier, string corporateAction)',
  'event Verified(address indexed account, bool status)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]

type State = {
  name: string; symbol: string; ngx: string; isin: string
  supply: bigint; locked: bigint; reserve: bigint; reserveAt: number
  halted: boolean; haltReason: string; multiplier: bigint; custodian: string; paused: boolean
}
type Ev = { block: number; tx: string; label: string; detail: string; tone: 'ok' | 'warn' | 'info'; routine?: boolean }

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)

export default function PssDemo() {
  const [token, setToken] = useState<string>('')
  const [s, setS] = useState<State | null>(null)
  const [events, setEvents] = useState<Ev[]>([])
  const [err, setErr] = useState('')
  const [showAll, setShowAll] = useState(false)
  const provider = useMemo(() => new ethers.JsonRpcProvider(RPC), [])
  const deployBlock = useRef<number | null>(null)

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('token')
    setToken(q || process.env.NEXT_PUBLIC_PSS_DEMO_TOKEN || '')
  }, [])

  const load = useCallback(async () => {
    if (!ethers.isAddress(token)) return
    try {
      const c = new ethers.Contract(token, ABI, provider)
      const [name, symbol, ngx, isin, supply, locked, reserve, reserveAt, halted, haltReason, multiplier, custodian, paused] = await Promise.all([
        c.name(), c.symbol(), c.ngxSymbol(), c.isin(), c.totalSupply(), c.lockedSupply(), c.lastReserveShares(),
        c.lastReserveAt(), c.mintHalted(), c.haltReason(), c.multiplier(), c.custodianSigner(), c.paused(),
      ])
      setS({ name, symbol, ngx, isin, supply, locked, reserve, reserveAt: Number(reserveAt), halted, haltReason, multiplier, custodian, paused })

      // Public RPCs cap eth_getLogs at 500 blocks, so find the deployment block once (binary search
      // on code presence) and read the trail in 500-block chunks from there.
      const head = await provider.getBlockNumber()
      if (deployBlock.current == null) {
        let lo = Math.max(0, head - 2_000_000), hi = head
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          if ((await provider.getCode(token, mid)) === '0x') lo = mid + 1; else hi = mid
        }
        deployBlock.current = lo
      }
      const logs: ethers.Log[] = []
      for (let from = deployBlock.current; from <= head && logs.length < 500; from += 500) {
        logs.push(...await provider.getLogs({ address: token, fromBlock: from, toBlock: Math.min(head, from + 499) }))
      }
      const iface = new ethers.Interface(ABI)
      const out: Ev[] = []
      const kinds = new Map<string, number>()
      for (const l of logs) {
        let p: ethers.LogDescription | null = null
        try { p = iface.parseLog(l) } catch { continue }
        if (!p) continue
        const a = p.args
        const ev = (label: string, detail: string, tone: Ev['tone'] = 'info', routine = false) => out.push({ block: l.blockNumber, tx: l.transactionHash, label, detail, tone, routine })
        const shares = (n: bigint) => `${n} share${n === 1n ? '' : 's'}`
        switch (p.name) {
          case 'MintedAgainstSettlement': ev('Shares issued', `${shares(a.amount)} to ${short(a.to)}, each backed by a share the custodian confirmed`, 'ok'); break
          case 'ReserveReported':
            if (a.shortfall) ev('Shortfall detected: issuing stopped', `custodian holds ${a.reserveShares}, tokens out ${a.supply}`, 'warn')
            else ev('Custodian statement', `holds ${a.reserveShares} shares for ${a.supply} tokens: fully backed`, 'ok', true)
            break
          case 'MintHaltChanged': ev(a.halted ? 'Issuing stopped' : 'Issuing reopened', a.reason, a.halted ? 'warn' : 'ok'); break
          case 'RedemptionRequested':
            kinds.set(String(a.id), Number(a.kind))
            ev(Number(a.kind) === 0 ? 'Cash-out started' : 'Withdrawal to CSCS started', `${shares(a.amount)} locked from ${short(a.holder)}`); break
          case 'RedemptionCompleted': ev(kinds.get(String(a.id)) === 1 ? 'Delivered to CSCS account' : 'Cash-out paid', 'token burned after settlement', 'ok'); break
          case 'RedemptionCancelled': ev('Withdrawal failed: tokens returned', a.reason, 'warn'); break
          case 'MultiplierChanged': ev('Corporate action', `${a.corporateAction} · ${Number(a.multiplier) / 1e18} share(s) per token`); break
          case 'Verified': ev(a.status ? 'Investor verified (KYC)' : 'Investor removed', short(a.account), 'info', true); break
          case 'Transfer':
            if (a.from !== ethers.ZeroAddress && a.to !== ethers.ZeroAddress && a.from.toLowerCase() !== token.toLowerCase() && a.to.toLowerCase() !== token.toLowerCase())
              ev('Shares sent', `${shares(a.value)} · ${short(a.from)} → ${short(a.to)}, both verified`)
            break
        }
      }
      setEvents(out.reverse())
      setErr('')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message.slice(0, 160) : 'Could not read the token')
    }
  }, [token, provider])

  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t) }, [load])

  const backed = s ? (s.supply === 0n ? 100 : Math.min(100, Number((s.reserve * 10000n) / s.supply) / 100)) : 0
  const tone = { ok: '#0a7a3d', warn: '#b45309', info: '#334155' }

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '32px 16px 64px', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: '#0f172a' }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.08em', color: '#0052ff', textTransform: 'uppercase' }}>PSS-1 · Base Sepolia testnet</div>
      <h1 style={{ fontSize: 28, margin: '6px 0 4px' }}>Tokenized NGX equity: live backing</h1>
      <p style={{ color: '#475569', margin: '0 0 20px', lineHeight: 1.5 }}>
        Read directly from the contract. Tokens mint only against a custodian-signed attestation of settled shares, transfers are limited to verified wallets, and minting halts automatically if the custodian&apos;s CSCS pool is ever below supply.
      </p>

      {!ethers.isAddress(token) && <div style={{ padding: 14, background: '#f1f5f9', borderRadius: 10 }}>Add <code>?token=0x…</code> to the URL to load a deployed token.</div>}
      {err && <div style={{ padding: 12, background: '#fef2f2', color: '#991b1b', borderRadius: 10, marginBottom: 12 }}>{err}</div>}

      {s && (
        <>
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 14, padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{s.name} <span style={{ color: '#64748b', fontWeight: 500 }}>({s.symbol})</span></div>
                <div style={{ color: '#64748b', fontSize: 13 }}>NGX: {s.ngx} · ISIN {s.isin} · 1 token = 1 share</div>
              </div>
              <a href={`${EXPLORER}/address/${token}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#0052ff' }}>View on BaseScan ↗</a>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginTop: 18 }}>
              {[
                ['Tokens in issue', String(s.supply)],
                ['CSCS pool (custodian)', String(s.reserve)],
                ['Locked in redemption', String(s.locked)],
                ['Shares per token', String(Number(s.multiplier) / 1e18)],
              ].map(([k, v]) => (
                <div key={k} style={{ background: '#f8fafc', borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{k}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                <span>Backing (pool ÷ supply)</span>
                <b style={{ color: backed >= 100 ? tone.ok : tone.warn }}>{backed.toFixed(2)}%</b>
              </div>
              <div style={{ height: 10, background: '#e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ width: `${backed}%`, height: '100%', background: backed >= 100 ? tone.ok : tone.warn, transition: 'width .6s' }} />
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginTop: 12, color: '#334155' }}>
                <span>Minting: <b style={{ color: s.halted ? tone.warn : tone.ok }}>{s.halted ? `halted (${s.haltReason})` : 'open'}</b></span>
                <span>Transfers: <b style={{ color: s.paused ? tone.warn : tone.ok }}>{s.paused ? 'paused' : 'verified wallets only'}</b></span>
                <span>Custodian key: <code>{short(s.custodian)}</code></span>
                {s.reserveAt > 0 && <span>Last statement: {new Date(s.reserveAt * 1000).toLocaleString()}</span>}
              </div>
            </div>
          </div>

          <TryIt token={token} onChange={load} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '22px 0 8px', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 16, margin: 0 }}>Recent activity on-chain</h2>
            <span style={{ fontSize: 12, color: '#64748b' }}>every row is a public transaction · click to verify</span>
          </div>
          {(() => {
            const list = showAll ? events : events.filter((e) => !e.routine).slice(0, 5)
            return (
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 14, overflow: 'hidden' }}>
                {list.length === 0 ? <div style={{ padding: 16, color: '#64748b' }}>No activity yet.</div> : list.map((e, i) => (
                  <a key={e.tx + i} href={`${EXPLORER}/tx/${e.tx}`} target="_blank" rel="noreferrer"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '11px 14px', borderTop: i ? '1px solid #f1f5f9' : 'none', textDecoration: 'none', color: 'inherit', fontSize: 14 }}>
                    <span><b style={{ color: tone[e.tone] }}>{e.label}</b><span style={{ color: '#475569' }}> · {e.detail}</span></span>
                    <span style={{ color: '#0052ff', fontSize: 12, whiteSpace: 'nowrap' }}>receipt ↗</span>
                  </a>
                ))}
                {events.length > list.length || showAll ? (
                  <button onClick={() => setShowAll((v) => !v)}
                    style={{ width: '100%', padding: '10px 14px', border: 'none', borderTop: '1px solid #f1f5f9', background: '#f8fafc', color: '#0052ff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    {showAll ? 'Show less' : `Show full history (${events.length} events, incl. custodian statements)`}
                  </button>
                ) : null}
              </div>
            )
          })()}
          <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 14 }}>Testnet demonstration. No real securities are represented. Refreshes every 10 seconds.</p>
        </>
      )}
    </main>
  )
}
