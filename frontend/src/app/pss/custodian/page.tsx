'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * /pss/custodian — the custodian & trustee console for the PSS-1 testnet demo.
 *
 * What the custodian's operations team and the trustee would see: settled CSCS credits waiting to
 * be confirmed and signed (no token is minted without that signature), the daily pool statement,
 * and dividends waiting for the trustee's approval. Everything after their click is automatic.
 * Server side: lib/pss-console.ts via /api/pss/console.
 */

const EXPLORER = 'https://sepolia.basescan.org'
const C = {
  blue: '#0052ff', ink: '#0f172a', muted: '#64748b', line: '#e2e8f0', soft: '#f8fafc',
  green: '#0a7a3d', greenSoft: '#ecfdf3', amber: '#b45309', amberSoft: '#fff7ed', blueSoft: '#eef3ff',
}

type Tx = { label: string; hash: string }
type Settlement = {
  id: string; kind: 'trade' | 'transfer_in'; investor: string; investorName: string; quantity: number
  cscsRef: string; source: string; receivedAt: number; status: 'pending' | 'confirmed' | 'rejected'
  reason?: string; signed?: { tradeRef: string; deadline: number; signature: string }; txs?: Tx[]
}
type Dividend = { id: number; snapshotId: number; total: number; supplyAt: number; approved: boolean; paid?: { name: string; amount: number }[]; txs: Tx[] }
type Status = {
  supply: number; required: number; reserve: number; reserveAt: number; halted: boolean
  custodian: string; trustee: string; queue: Settlement[]; dividend: Dividend | null
}

const REJECT_REASONS = [
  'Shares not received in the pool account',
  "Name or CSCS details do not match the investor's KYC",
  'Duplicate settlement reference',
]

const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)

async function call(body: Record<string, unknown>) {
  const res = await fetch('/api/pss/console', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || 'Request failed')
  return d
}

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/not configured/i.test(m)) return 'The live demo is being switched on. Please try again in a few minutes.'
  if (/limit reached/i.test(m)) return 'You have reached the demo limit for now. Please try again later.'
  if (/shortfall/i.test(m)) return 'On the public demo a short statement is not posted, so the shared token stays open. The scripted walkthrough shows minting halting on a shortfall.'
  if (/not pending|nothing to approve/i.test(m)) return 'Already handled. Refreshing.'
  return 'The test network was busy. Please try again.'
}

function Receipts({ txs }: { txs?: Tx[] }) {
  if (!txs?.length) return null
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
      {txs.map((t) => <a key={t.hash} href={`${EXPLORER}/tx/${t.hash}`} target="_blank" rel="noreferrer" style={{ color: C.blue, fontSize: 12, fontWeight: 600 }}>{t.label} receipt ↗</a>)}
    </div>
  )
}

export default function CustodianConsole() {
  const [s, setS] = useState<Status | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string>('')
  const [open, setOpen] = useState<string>('')
  const [reason, setReason] = useState(REJECT_REASONS[0])
  const [stmt, setStmt] = useState<string>('')
  const [edited, setEdited] = useState(false) // the statement field follows the required figure until typed in
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string; txs?: Tx[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/pss/console', { cache: 'no-store' })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error || 'error')
      setS(d); setErr('')
    } catch (e) { setErr(friendly(e)) }
  }, [])

  useEffect(() => { load(); const i = setInterval(load, 6000); return () => clearInterval(i) }, [load])
  useEffect(() => { if (s && !edited) setStmt(String(s.required)) }, [s, edited])

  const act = async (key: string, body: Record<string, unknown>, done?: (r: any) => void) => {
    setBusy(key); setNote(null)
    try { const r = await call(body); done?.(r) } catch (e) { setNote({ tone: 'warn', text: friendly(e) }) }
    setBusy(''); load()
  }

  const Btn = ({ children, onClick, kind = 'primary', disabled }: { children: React.ReactNode; onClick: () => void; kind?: 'primary' | 'ghost'; disabled?: boolean }) => (
    <button onClick={onClick} disabled={!!busy || disabled}
      style={{ padding: '9px 14px', borderRadius: 9, fontWeight: 600, fontSize: 13, cursor: busy || disabled ? 'not-allowed' : 'pointer', opacity: busy || disabled ? 0.5 : 1,
        border: kind === 'primary' ? 'none' : `1px solid ${C.line}`, background: kind === 'primary' ? C.blue : '#fff', color: kind === 'primary' ? '#fff' : C.ink }}>
      {children}
    </button>
  )

  const panel = (title: string, sub: string, children: React.ReactNode) => (
    <section style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 16, padding: 18, marginBottom: 16 }}>
      <h2 style={{ fontSize: 17, margin: 0 }}>{title}</h2>
      <p style={{ color: C.muted, fontSize: 13, margin: '4px 0 14px', lineHeight: 1.5 }}>{sub}</p>
      {children}
    </section>
  )

  const pending = s?.queue.filter((q) => q.status === 'pending') || []
  const handled = s?.queue.filter((q) => q.status !== 'pending') || []
  const stmtN = Math.floor(Number(stmt))
  const short_ = s && Number.isFinite(stmtN) && stmtN < s.required

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '32px 16px 64px', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', color: C.ink, background: C.soft, minHeight: '100vh' }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.08em', color: C.blue, textTransform: 'uppercase' }}>PSS-1 · Base Sepolia testnet</div>
      <h1 style={{ fontSize: 28, margin: '6px 0 4px' }}>Custodian &amp; trustee console</h1>
      <p style={{ color: '#475569', margin: '0 0 6px', lineHeight: 1.5 }}>
        The screen the custodian&apos;s operations team and the trustee use. No token can be created until the custodian confirms the shares are in the pool and signs. Everything after their click is automatic: minting, reconciliation and dividend payments.
      </p>
      <p style={{ fontSize: 13, margin: '0 0 18px' }}><a href="/pss/demo" style={{ color: C.blue }}>← Investor view</a></p>

      {err && <div style={{ padding: 12, background: C.amberSoft, color: C.amber, borderRadius: 10, marginBottom: 12, fontSize: 14 }}>{err}</div>}
      {note && <div style={{ padding: 12, background: note.tone === 'ok' ? C.greenSoft : C.amberSoft, color: note.tone === 'ok' ? C.green : C.amber, borderRadius: 10, marginBottom: 12, fontSize: 14 }}>{note.text}<Receipts txs={note.txs} /></div>}

      {s && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
          {[
            ['Tokens in issue', String(s.supply)],
            ['Shares the pool must hold', String(s.required)],
            ['Last CSCS statement', String(s.reserve)],
            ['Position', s.halted ? 'Minting halted' : s.reserve >= s.required ? 'Fully backed' : 'Statement due'],
          ].map(([k, v]) => (
            <div key={k} style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12, color: C.muted }}>{k}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: k === 'Position' ? (s.halted ? C.amber : C.green) : C.ink }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {panel('1. Settlements awaiting your confirmation', 'Each row is a credit CSCS has made to the pool account. Check it against your records, then confirm and sign. Your signature is the only thing that lets the matching tokens be created, for this investor, this quantity and this reference, once.', <>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Btn kind="ghost" onClick={() => act('credit', { action: 'credit', kind: 'trade' }, (r) => setOpen(r.id))}>+ Simulate: NGX purchase settles</Btn>
          <Btn kind="ghost" onClick={() => act('credit', { action: 'credit', kind: 'transfer_in' }, (r) => setOpen(r.id))}>+ Simulate: transfer in from another broker</Btn>
        </div>

        {pending.length === 0 && <div style={{ color: C.muted, fontSize: 13, padding: '10px 0' }}>Nothing waiting. Simulate a CSCS credit above to see what arrives.</div>}

        {pending.map((q) => (
          <div key={q.id} style={{ border: `1px solid ${open === q.id ? C.blue : C.line}`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{q.quantity} MTNN · {q.investorName} <span style={{ color: C.green, fontSize: 12, fontWeight: 600 }}>KYC verified ✓</span></div>
                <div style={{ fontSize: 12, color: C.muted }}>{q.source} · {q.cscsRef}</div>
              </div>
              {open !== q.id && <Btn kind="ghost" onClick={() => setOpen(q.id)}>Review</Btn>}
            </div>
            {open === q.id && (
              <div style={{ marginTop: 12 }}>
                <div style={{ background: C.soft, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, fontSize: 13 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>You are signing</div>
                  {[
                    ['Beneficiary', `${q.investorName} · ${short(q.investor)}`],
                    ['Shares', `${q.quantity} MTN Nigeria (ISIN NGMTNN000002)`],
                    ['Settlement reference', q.cscsRef],
                    ['Valid for', '10 minutes, and usable once'],
                    ['Effect', s ? `Pool statement rises to ${s.supply + q.quantity} shares; ${q.quantity} tokens issued to ${q.investorName}` : ''],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
                      <span style={{ color: C.muted, minWidth: 150 }}>{k}</span><span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <Btn onClick={() => act('confirm', { action: 'confirm', id: q.id }, (r) => setNote({ tone: 'ok', text: `Signed. ${r.quantity} tokens issued to ${r.investorName}, backed by the shares you confirmed.`, txs: r.txs }))}>
                    {busy === 'confirm' ? 'Signing and minting…' : 'Confirm & sign'}
                  </Btn>
                  <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={!!busy}
                    style={{ padding: '8px 10px', borderRadius: 9, border: `1px solid ${C.line}`, fontSize: 13, maxWidth: 320 }}>
                    {REJECT_REASONS.map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <Btn kind="ghost" onClick={() => act('reject', { action: 'reject', id: q.id, reason }, () => setNote({ tone: 'ok', text: 'Rejected. No tokens were created.' }))}>Reject</Btn>
                </div>
              </div>
            )}
          </div>
        ))}

        {handled.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Handled</div>
            {handled.map((q) => (
              <div key={q.id} style={{ borderTop: `1px solid ${C.line}`, padding: '8px 0', fontSize: 13 }}>
                <b style={{ color: q.status === 'confirmed' ? C.green : C.muted }}>{q.status === 'confirmed' ? '✓ Confirmed & signed' : '✕ Rejected'}</b>
                <span style={{ color: '#475569' }}> · {q.quantity} MTNN · {q.investorName} · {q.cscsRef}{q.reason ? ` · ${q.reason}` : ''}</span>
                {q.signed && <div style={{ fontSize: 11, color: C.muted, fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>signature {q.signed.signature.slice(0, 22)}…</div>}
                <Receipts txs={q.txs} />
              </div>
            ))}
          </div>
        )}
      </>)}

      {panel('2. Daily pool statement', 'At the end of each business day, enter the balance of the pool account from your CSCS statement. It is posted on-chain against the tokens in issue. If the pool ever holds fewer shares than required, new minting stops automatically until it is corrected.', <>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: C.muted }}>Shares in the pool account</label>
          <input value={stmt} onChange={(e) => { setEdited(true); setStmt(e.target.value.replace(/[^0-9]/g, '')) }} inputMode="numeric"
            style={{ width: 120, padding: '8px 10px', borderRadius: 9, border: `1px solid ${short_ ? C.amber : C.line}`, fontSize: 14, fontWeight: 600 }} />
          <Btn onClick={() => act('statement', { action: 'statement', shares: stmtN }, (r) => { setEdited(false); setNote({ tone: 'ok', text: `Statement posted: ${stmtN} shares held for ${s?.supply} tokens. Fully backed.`, txs: [{ label: 'Statement', hash: r.tx }] }) })}>
            {busy === 'statement' ? 'Posting…' : 'Post statement'}
          </Btn>
        </div>
        {short_ && <div style={{ marginTop: 10, fontSize: 13, color: C.amber }}>This is {s!.required - stmtN} short of the {s!.required} shares required. Posting it would stop all new minting automatically until a corrected statement is posted.</div>}
      </>)}

      {panel('3. Trustee: dividend approval', "When the registrar's payment reaches the pool account, it is converted to cNGN and the issuer declares the dividend against a record date fixed on-chain. Nothing is paid until the trustee approves, and the contract refuses approval unless the full amount is already in it. The contract then works out and pays each holder's share.", <>
        {!s?.dividend || s.dividend.approved ? (
          <div>
            {s?.dividend?.approved && (
              <div style={{ background: C.greenSoft, color: C.green, borderRadius: 10, padding: 12, fontSize: 13, marginBottom: 12 }}>
                ✓ Approved and paid: ₦{s.dividend.total.toLocaleString()} across {s.dividend.supplyAt} shares.
                {s.dividend.paid?.map((p) => ` ${p.name} ₦${p.amount.toLocaleString()}.`)} Every other holder is paid by the same contract.
                <Receipts txs={s.dividend.txs} />
              </div>
            )}
            <Btn kind="ghost" onClick={() => act('declare', { action: 'declare' })}>{busy === 'declare' ? 'Recording and declaring…' : '+ Simulate: registrar pays an MTN dividend of ₦10 a share'}</Btn>
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.blue}`, borderRadius: 12, padding: 14 }}>
            {[
              ['Dividend', `₦${s.dividend.total.toLocaleString()} (₦10 × ${s.dividend.supplyAt} shares), net of withholding tax`],
              ['Record date', `Snapshot #${s.dividend.snapshotId}, fixed on-chain`],
              ['Funds', 'Received and held by the distribution contract ✓'],
              ['Payment', 'Each holder pro-rata, in cNGN, calculated by the contract'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 10, padding: '3px 0', fontSize: 13 }}>
                <span style={{ color: C.muted, minWidth: 110 }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
            <Receipts txs={s.dividend.txs} />
            <div style={{ marginTop: 12 }}>
              <Btn onClick={() => act('approve', { action: 'approve' }, () => setNote({ tone: 'ok', text: 'Approved. The contract has paid the holders.' }))}>{busy === 'approve' ? 'Approving and paying…' : 'Approve as trustee'}</Btn>
            </div>
          </div>
        )}
      </>)}

      {s && (
        <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          In production the custodian signs with its own key ({short(s.custodian)} here) held in its own hardware security module, and the trustee approves with its own key ({short(s.trustee)} here). PawaSave never holds either. On this testnet demonstration both are played by a demo key. No real securities are represented.
        </p>
      )}
    </main>
  )
}
