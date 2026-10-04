'use client'

import { useState, useEffect, useCallback } from 'react'
import { CircleNotch, CaretRight, Bank, Check, Copy, ArrowDown, ArrowUp, TrendUp, UserCircle } from '@phosphor-icons/react'
import { formatCngn, timeAgo } from '@/lib/format'
import { getApySettings } from '@/hooks/use-data'
import { useConfirm } from '@/components/confirm-dialog'

/**
 * Cooperative societies (migration 116): recurring dues, a shared fund that earns while it
 * sits, and payouts that need officer approvals. Everything goes through /api/coop/*.
 */

type Period = 'weekly' | 'monthly' | 'quarterly' | 'yearly'
type Role = 'chairman' | 'treasurer' | 'secretary' | 'officer' | 'member'

interface CoopSummary { id: string; name: string; duesMicro: number; period: Period; fundMicro: number; members: number; role: Role; owingMicro: number }
interface CoopDetail {
  coop: { id: string; name: string; description: string | null; joinCode: string; duesMicro: number; period: Period; entranceMicro: number
    approvalsRequired: number; fundMicro: number; interestMicro: number; nextDuesAt: string; status: string }
  me: { userId: string; role: Role; autoPay: boolean; totalPaidMicro: number; owingMicro: number }
  members: { userId: string; name: string; role: Role; totalPaidMicro: number; owingMicro: number }[]
  charges: { id: number; kind: 'entrance' | 'dues' | 'levy'; label: string; memo: string | null; amountMicro: number; status: string; dueAt: string; paidAt: string | null }[]
  payouts: { id: number; amountMicro: number; reason: string; status: string; recipient: string; proposedBy: string; mine: boolean
    approvals: number; rejections: number; iVoted: boolean; createdAt: string; expiresAt: string }[]
  ledger: { id: number; kind: string; amountMicro: number; who: string | null; memo: string | null; at: string }[]
}

const PERIOD_LABEL: Record<Period, string> = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' }
const ROLE_LABEL: Record<Role, string> = { chairman: 'Chairman', treasurer: 'Treasurer', secretary: 'Secretary', officer: 'Officer', member: 'Member' }
const isOfficer = (r: Role) => r !== 'member'
const initialsOf = (n?: string) => (n || 'M').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase()

async function api<T = any>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || 'Something went wrong')
  return d as T
}

export default function CooperativeView({ onBack }: { onBack: () => void }) {
  const confirm = useConfirm()
  const [screen, setScreen] = useState<'list' | 'create' | 'join' | { id: string }>('list')
  const [coops, setCoops] = useState<CoopSummary[] | null>(null)
  const [detail, setDetail] = useState<CoopDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [rate, setRate] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  // create form
  const [fName, setFName] = useState(''); const [fDesc, setFDesc] = useState('')
  const [fDues, setFDues] = useState(''); const [fPeriod, setFPeriod] = useState<Period>('monthly')
  const [fEntrance, setFEntrance] = useState(''); const [fApprovals, setFApprovals] = useState(2)
  // join
  const [code, setCode] = useState('')
  // officer forms
  const [pAmount, setPAmount] = useState(''); const [pTag, setPTag] = useState(''); const [pReason, setPReason] = useState('')
  const [lAmount, setLAmount] = useState(''); const [lMemo, setLMemo] = useState('')
  const [openPanel, setOpenPanel] = useState<'payout' | 'levy' | null>(null)
  const [memberMenu, setMemberMenu] = useState<string | null>(null)

  useEffect(() => { getApySettings().then((s) => setRate(s.backed ? s.ajo : null)) }, [])

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000) }

  const loadList = useCallback(async () => {
    try { setCoops((await api<{ coops: CoopSummary[] }>('/api/coop')).coops) } catch (e: any) { setCoops([]); flash(false, e.message) }
  }, [])
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api<CoopDetail>(`/api/coop/${id}`)) } catch (e: any) { flash(false, e.message); setScreen('list') }
  }, [])

  useEffect(() => {
    if (screen === 'list') loadList()
    else if (typeof screen === 'object') { setDetail(null); loadDetail(screen.id) }
  }, [screen, loadList, loadDetail])

  const act = async (body: Record<string, unknown>, okText?: string) => {
    if (typeof screen !== 'object') return
    setBusy(true)
    try {
      const r = await api(`/api/coop/${screen.id}`, body)
      if (okText) flash(true, typeof okText === 'string' ? okText : 'Done')
      await loadDetail(screen.id)
      return r
    } catch (e: any) { flash(false, e.message) } finally { setBusy(false) }
  }

  const create = async () => {
    setBusy(true)
    try {
      const r = await api<{ id: string }>('/api/coop', {
        action: 'create', name: fName, description: fDesc || undefined, duesNgn: Number(fDues), period: fPeriod,
        entranceNgn: fEntrance ? Number(fEntrance) : 0, approvals: fApprovals,
      })
      setFName(''); setFDesc(''); setFDues(''); setFEntrance('')
      setScreen({ id: r.id })
    } catch (e: any) { flash(false, e.message) } finally { setBusy(false) }
  }

  const join = async () => {
    setBusy(true)
    try {
      const r = await api<{ id: string }>('/api/coop', { action: 'join', code })
      setCode(''); setScreen({ id: r.id })
    } catch (e: any) { flash(false, e.message) } finally { setBusy(false) }
  }

  const msgBlock = msg && <div className={`flash ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>

  // ══ CREATE ══
  if (screen === 'create') {
    return (
      <div className="b">
        <button className="back" onClick={() => setScreen('list')}>← Back</button>
        <div className="h2">Start a cooperative</div>
        <p className="p">For staff co-ops, unions, estate and alumni associations: members pay dues, officers run the fund together.</p>

        <label className="lab" style={{ marginTop: 10 }}>Society name</label>
        <input className="field" value={fName} maxLength={80} onChange={(e) => setFName(e.target.value)} placeholder="Unity Staff Cooperative" />

        <label className="lab" style={{ marginTop: 14 }}>What is it for? (optional)</label>
        <input className="field" value={fDesc} maxLength={300} onChange={(e) => setFDesc(e.target.value)} placeholder="Welfare and savings for staff of …" />

        <label className="lab" style={{ marginTop: 14 }}>Dues (₦)</label>
        <input className="field" type="number" inputMode="numeric" value={fDues} onChange={(e) => setFDues(e.target.value)} placeholder="5000" />

        <label className="lab" style={{ marginTop: 14 }}>Paid every</label>
        <div className="terms" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
          {(['weekly', 'monthly', 'quarterly', 'yearly'] as const).map((p) => (
            <button key={p} className={`term${fPeriod === p ? ' on' : ''}`} onClick={() => setFPeriod(p)} style={{ textTransform: 'capitalize' }}>{PERIOD_LABEL[p]}</button>
          ))}
        </div>

        <label className="lab" style={{ marginTop: 14 }}>Entrance fee (₦, optional, paid once by new members)</label>
        <input className="field" type="number" inputMode="numeric" value={fEntrance} onChange={(e) => setFEntrance(e.target.value)} placeholder="0" />

        <label className="lab" style={{ marginTop: 14 }}>Officer approvals needed to pay money out</label>
        <div className="terms" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
          {[1, 2, 3, 4].map((n) => <button key={n} className={`term${fApprovals === n ? ' on' : ''}`} onClick={() => setFApprovals(n)}>{n}</button>)}
        </div>
        <p className="p" style={{ margin: '6px 3px 0', color: fApprovals === 1 ? 'var(--amber)' : 'var(--muted)' }}>
          {fApprovals === 1 ? 'One officer alone could move the fund. 2 or more is safer.' : `No payout leaves the fund until ${fApprovals} officers approve it.`}
        </p>

        {msgBlock}
        <button className="cta" onClick={create} disabled={busy || fName.trim().length < 2 || !(Number(fDues) >= 100)}>{busy ? 'Creating…' : 'Create cooperative'}</button>
      </div>
    )
  }

  // ══ JOIN ══
  if (screen === 'join') {
    return (
      <div className="b">
        <button className="back" onClick={() => setScreen('list')}>← Back</button>
        <div className="h2">Join a cooperative</div>
        <p className="p">Enter the 7-character code your society&apos;s officers shared.</p>
        <input className="field" value={code} maxLength={7} autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-F]/g, ''))} placeholder="3F9A2C1"
          style={{ letterSpacing: '.2em', fontWeight: 700, textAlign: 'center', fontSize: 'var(--t-xl)' }} />
        {msgBlock}
        <button className="cta" onClick={join} disabled={busy || code.length !== 7}>{busy ? 'Joining…' : 'Join'}</button>
      </div>
    )
  }

  // ══ DETAIL ══
  if (typeof screen === 'object') {
    if (!detail) return <div style={{ display: 'grid', placeItems: 'center', padding: '64px 0' }}><CircleNotch className="w-6 h-6 animate-spin" style={{ color: 'var(--muted)' }} /></div>
    const { coop, me, members, charges, payouts, ledger } = detail
    const officer = isOfficer(me.role)
    const chair = me.role === 'chairman'
    const officerCount = members.filter((m) => isOfficer(m.role)).length
    const pending = payouts.filter((p) => p.status === 'pending')
    const settledPayouts = payouts.filter((p) => p.status !== 'pending').slice(0, 5)
    const owingCharges = charges.filter((c) => c.status === 'owing')
    const paidCount = members.filter((m) => m.owingMicro === 0).length

    const share = async () => {
      const text = `Join "${coop.name}" on PawaSave. Code: ${coop.joinCode}`
      if (typeof navigator.share === 'function') { try { await navigator.share({ title: coop.name, text }); return } catch { /* dismissed */ } }
      await navigator.clipboard?.writeText(coop.joinCode); setCopied(true); setTimeout(() => setCopied(false), 2000)
    }

    return (
      <div className="b">
        <div className="ajohead">
          <div>
            <div className="t">{coop.name}</div>
            <div className="s">{members.length} member{members.length === 1 ? '' : 's'} · {formatCngn(coop.duesMicro)} a {PERIOD_LABEL[coop.period]} · {ROLE_LABEL[me.role]}</div>
          </div>
          <button className="cyclechip" onClick={share} style={{ border: 0, cursor: 'pointer' }}>{copied ? 'Copied!' : <>Code {coop.joinCode} <Copy style={{ verticalAlign: '-2px' }} /></>}</button>
        </div>
        {coop.description && <p className="p" style={{ margin: '0 3px 12px' }}>{coop.description}</p>}

        {/* Fund */}
        <div className="pool">
          <div className="l">Society fund</div>
          <div className="v num">{formatCngn(coop.fundMicro)}</div>
          <span className="apy">
            {rate != null ? `Earning ${rate}% a year` : 'Held for the society'}
            {coop.interestMicro > 0 ? ` · +${formatCngn(coop.interestMicro)} earned so far` : ''}
          </span>
        </div>

        {msgBlock}

        {/* My dues */}
        <div className="sect"><span className="h">My dues</span><span style={{ fontSize: 12, color: 'var(--muted)' }}>Paid {formatCngn(me.totalPaidMicro)} in total</span></div>
        <div className="info">
          {me.owingMicro > 0 ? (
            <>
              <div className="l">You owe</div>
              <div className="num" style={{ fontSize: 'var(--t-2xl)', fontWeight: 'var(--w-bold)', color: 'var(--ink)', margin: '2px 0 6px' }}>{formatCngn(me.owingMicro)}</div>
              {owingCharges.map((c) => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', padding: '2px 0' }}>
                  <span>{c.kind === 'dues' ? `Dues from ${c.label}` : c.kind === 'entrance' ? 'Entrance fee' : `Levy: ${c.memo || ''}`}</span>
                  <span className="num">{formatCngn(c.amountMicro)}</span>
                </div>
              ))}
              <button className="cta" style={{ marginTop: 10 }} disabled={busy} onClick={() => act({ action: 'pay' }, 'Payment sent to the society')}>{busy ? 'Paying…' : `Pay ${formatCngn(me.owingMicro)}`}</button>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--green)', fontWeight: 600 }}><Check /> You&apos;re up to date</div>
          )}
          <div style={{ fontSize: 'var(--t-2xs)', color: 'var(--muted)', marginTop: 10 }}>Next dues: {new Date(coop.nextDuesAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13, color: 'var(--ink)', cursor: 'pointer' }}>
            <input type="checkbox" checked={me.autoPay} disabled={busy} onChange={(e) => act({ action: 'autopay', on: e.target.checked })} />
            Pay my dues automatically from my balance
          </label>
        </div>

        {/* Payouts awaiting approval */}
        <div className="sect"><span className="h">Payouts</span>{officer && <button className="m" onClick={() => setOpenPanel(openPanel === 'payout' ? null : 'payout')}>{openPanel === 'payout' ? 'Close' : 'Propose'}</button>}</div>
        <p className="p" style={{ margin: '-4px 3px 8px' }}>Money only leaves the fund after {coop.approvalsRequired} officer{coop.approvalsRequired === 1 ? '' : 's'} approve{coop.approvalsRequired === 1 ? 's' : ''}. Every member can see every request.</p>

        {officer && openPanel === 'payout' && (
          <div className="rows" style={{ padding: 15, marginBottom: 10 }}>
            {officerCount < coop.approvalsRequired && (
              <div className="flash err" style={{ marginTop: 0 }}>Payouts need {coop.approvalsRequired} officers. {chair ? 'Appoint officers from the member list below.' : 'Ask the chairman to appoint more officers.'}</div>
            )}
            <label className="lab">Amount (₦)</label>
            <input className="field" type="number" inputMode="numeric" value={pAmount} onChange={(e) => setPAmount(e.target.value)} placeholder="0" />
            <label className="lab" style={{ marginTop: 10 }}>Pay to (@tag)</label>
            <input className="field" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={pTag}
              onChange={(e) => setPTag(e.target.value.replace(/[^a-zA-Z0-9_@]/g, '').toLowerCase())} placeholder="@treasurer" />
            <label className="lab" style={{ marginTop: 10 }}>Reason</label>
            <input className="field" value={pReason} maxLength={300} onChange={(e) => setPReason(e.target.value)} placeholder="Welfare support for a bereaved member" />
            <button className="cta" disabled={busy || !(Number(pAmount) > 0) || !pTag || pReason.trim().length < 3}
              onClick={async () => {
                const r = await act({ action: 'propose', amountNgn: Number(pAmount), recipientTag: pTag, reason: pReason })
                if (r) { setPAmount(''); setPTag(''); setPReason(''); setOpenPanel(null); flash(true, r.executed ? 'Paid out' : 'Sent to officers for approval') }
              }}>Propose payout</button>
          </div>
        )}

        {pending.length === 0 && settledPayouts.length === 0 && <div className="empty"><div className="es">No payouts yet</div></div>}
        {pending.map((p) => (
          <div key={p.id} className="rows" style={{ padding: 15, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div className="nm" style={{ color: 'var(--ink)', fontWeight: 600 }}>{p.reason}</div>
              <div className="num" style={{ color: 'var(--amber)', fontWeight: 700 }}>{formatCngn(p.amountMicro)}</div>
            </div>
            <p className="p" style={{ margin: '4px 0 0' }}>To {p.recipient} · proposed by {p.proposedBy} · {timeAgo(p.createdAt)}</p>
            <p className="p" style={{ margin: '2px 0 0' }}>{p.approvals} of {coop.approvalsRequired} approvals{p.rejections ? ` · ${p.rejections} against` : ''}</p>
            {officer && !p.iVoted && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="cta" style={{ marginTop: 0 }} disabled={busy} onClick={() => act({ action: 'vote', payoutId: p.id, approve: true }, 'Approval recorded')}>Approve</button>
                <button className="cta ghost" style={{ marginTop: 0 }} disabled={busy}
                  onClick={async () => { if (await confirm({ title: 'Reject payout?', message: `Reject ${formatCngn(p.amountMicro)} to ${p.recipient}?`, confirmText: 'Reject', danger: true })) act({ action: 'vote', payoutId: p.id, approve: false }, 'Rejection recorded') }}>Reject</button>
              </div>
            )}
            {p.mine && <button className="cta ghost" style={{ marginTop: 8, color: 'var(--muted)' }} disabled={busy} onClick={() => act({ action: 'cancel', payoutId: p.id }, 'Payout withdrawn')}>Withdraw my proposal</button>}
          </div>
        ))}
        {settledPayouts.length > 0 && (
          <div className="feedcard">
            {settledPayouts.map((p) => (
              <div key={p.id} className="tx">
                <span className="ic"><ArrowUp /></span>
                <div className="mid"><div className="nm">{p.reason}</div><div className="sub">To {p.recipient} · {p.status} · {timeAgo(p.createdAt)}</div></div>
                <div className="rt"><div className="amt num" style={{ color: p.status === 'executed' ? 'var(--ink)' : 'var(--faint)', textDecoration: p.status === 'executed' ? 'none' : 'line-through' }}>{formatCngn(p.amountMicro)}</div></div>
              </div>
            ))}
          </div>
        )}

        {/* Levy */}
        {officer && (
          <>
            <div className="sect"><span className="h">Levy</span><button className="m" onClick={() => setOpenPanel(openPanel === 'levy' ? null : 'levy')}>{openPanel === 'levy' ? 'Close' : 'Raise a levy'}</button></div>
            {openPanel === 'levy' && (
              <div className="rows" style={{ padding: 15 }}>
                <p className="p" style={{ margin: '0 0 8px' }}>A one-off amount every member owes, on top of dues.</p>
                <label className="lab">Amount per member (₦)</label>
                <input className="field" type="number" inputMode="numeric" value={lAmount} onChange={(e) => setLAmount(e.target.value)} placeholder="2000" />
                <label className="lab" style={{ marginTop: 10 }}>What is it for?</label>
                <input className="field" value={lMemo} maxLength={140} onChange={(e) => setLMemo(e.target.value)} placeholder="End of year party" />
                <button className="cta" disabled={busy || !(Number(lAmount) >= 100) || lMemo.trim().length < 3}
                  onClick={async () => {
                    if (!(await confirm({ title: 'Raise levy?', message: `Every member (${members.length}) will owe ${formatCngn(Number(lAmount) * 1_000_000)} for "${lMemo}".`, confirmText: 'Raise levy' }))) return
                    const r = await act({ action: 'levy', amountNgn: Number(lAmount), memo: lMemo })
                    if (r) { setLAmount(''); setLMemo(''); setOpenPanel(null); flash(true, `Levy raised on ${r.members} members`) }
                  }}>Raise levy</button>
              </div>
            )}
          </>
        )}

        {/* Members */}
        <div className="sect"><span className="h">Members ({members.length})</span><span style={{ fontSize: 12, color: 'var(--muted)' }}>{paidCount} up to date</span></div>
        <div className="rows" style={{ padding: '2px 12px' }}>
          {members.map((m) => (
            <div key={m.userId} style={{ borderTop: '1px solid var(--line)' }}>
              <button onClick={() => chair && m.userId !== me.userId && setMemberMenu(memberMenu === m.userId ? null : m.userId)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 4px', width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: chair && m.userId !== me.userId ? 'pointer' : 'default' }}>
                <span style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--green-soft)', color: 'var(--green)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12, flex: 'none' }}>{initialsOf(m.name)}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                  {m.name}{isOfficer(m.role) && <span style={{ color: 'var(--green)', fontWeight: 600 }}> · {ROLE_LABEL[m.role]}</span>}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--faint)', fontWeight: 500 }}>Paid {formatCngn(m.totalPaidMicro)}</span>
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: m.owingMicro > 0 ? 'var(--amber)' : 'var(--green)' }}>{m.owingMicro > 0 ? `Owes ${formatCngn(m.owingMicro)}` : 'Paid up'}</span>
              </button>
              {chair && memberMenu === m.userId && (
                <div style={{ padding: '0 4px 12px' }}>
                  <div className="terms" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
                    {(['treasurer', 'secretary', 'officer', 'member', 'chairman'] as Role[]).map((r) => (
                      <button key={r} className={`term${m.role === r ? ' on' : ''}`} disabled={busy}
                        onClick={async () => {
                          if (r === m.role) return
                          if (r === 'chairman' && !(await confirm({ title: 'Hand over the chair?', message: `${m.name} becomes chairman and you become an officer.`, confirmText: 'Hand over' }))) return
                          await act({ action: 'role', userId: m.userId, role: r }, `${m.name} is now ${ROLE_LABEL[r].toLowerCase()}`); setMemberMenu(null)
                        }}>{ROLE_LABEL[r]}</button>
                    ))}
                    <button className="term" disabled={busy} style={{ color: 'var(--red, #c0392b)' }}
                      onClick={async () => {
                        if (!(await confirm({ title: 'Remove member?', message: `Remove ${m.name}? What they still owe is cancelled; dues they paid stay in the fund.`, confirmText: 'Remove', danger: true }))) return
                        await act({ action: 'remove', userId: m.userId }, `${m.name} removed`); setMemberMenu(null)
                      }}>Remove</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {chair && <p className="p" style={{ margin: '6px 3px 0' }}>Tap a member to appoint officers or remove them.</p>}

        {/* Fund ledger */}
        <div className="sect"><span className="h">Fund activity</span></div>
        {ledger.length === 0 ? (
          <div className="empty"><div className="es">Nothing yet</div></div>
        ) : (
          <div className="feedcard">
            {ledger.map((l) => (
              <div key={l.id} className="tx">
                <span className="ic">{l.kind === 'interest' ? <TrendUp /> : l.amountMicro < 0 ? <ArrowUp /> : <ArrowDown />}</span>
                <div className="mid">
                  <div className="nm">{l.kind === 'interest' ? 'Interest' : l.kind === 'payout' ? `Paid to ${l.who}` : `${l.who || 'Member'} · ${l.kind === 'dues' ? 'dues' : l.kind}`}</div>
                  <div className="sub">{l.memo ? `${l.memo} · ` : ''}{timeAgo(l.at)}</div>
                </div>
                <div className="rt"><div className={`amt num${l.amountMicro > 0 ? ' pos' : ''}`}>{l.amountMicro > 0 ? '+' : '−'}{formatCngn(Math.abs(l.amountMicro))}</div></div>
              </div>
            ))}
          </div>
        )}

        {!chair && (
          <button className="cta ghost" style={{ marginTop: 16, color: 'var(--muted)' }} disabled={busy}
            onClick={async () => {
              if (!(await confirm({ title: 'Leave society?', message: 'What you still owe is cancelled. Dues you have paid stay with the society.', confirmText: 'Leave', danger: true }))) return
              try { await api(`/api/coop/${coop.id}`, { action: 'leave' }); setScreen('list') } catch (e: any) { flash(false, e.message) }
            }}>Leave society</button>
        )}
        <button className="cta ghost" style={{ marginTop: 10, color: 'var(--muted)' }} onClick={() => setScreen('list')}>← All cooperatives</button>
      </div>
    )
  }

  // ══ LIST ══
  return (
    <div className="b">
      <button className="back" onClick={onBack}>← Circles</button>
      <div className="ajohead">
        <div><div className="t">Cooperatives</div><div className="s">Dues, a shared fund, officers who approve every payout</div></div>
        <button className="cyclechip" onClick={() => setScreen('create')} style={{ border: 0, cursor: 'pointer' }}>+ New</button>
      </div>
      {msgBlock}
      {coops === null ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: '48px 0' }}><CircleNotch className="w-6 h-6 animate-spin" style={{ color: 'var(--muted)' }} /></div>
      ) : coops.length === 0 ? (
        <div className="empty" style={{ marginTop: 14 }}>
          <div className="eh">No cooperatives yet</div>
          <div className="es">Start one for your union, staff, estate or alumni group, or join with a code.</div>
          <button className="cta" style={{ maxWidth: 240, margin: '14px auto 0' }} onClick={() => setScreen('create')}>Start a cooperative</button>
        </div>
      ) : (
        <div className="rows" style={{ marginTop: 8 }}>
          {coops.map((c) => (
            <button key={c.id} className="opt" onClick={() => setScreen({ id: c.id })}>
              <span className="ic"><Bank /></span>
              <div className="mid">
                <div className="nm">{c.name}</div>
                <div className="sub">{formatCngn(c.fundMicro)} fund · {c.members} members{c.owingMicro > 0 ? ` · you owe ${formatCngn(c.owingMicro)}` : ''}</div>
              </div>
              <span className="chev"><CaretRight /></span>
            </button>
          ))}
        </div>
      )}
      <button className="cta ghost" style={{ marginTop: 14 }} onClick={() => setScreen('join')}><UserCircle style={{ verticalAlign: '-3px', marginRight: 6 }} />Join with a code</button>
      {rate != null && <p className="p" style={{ margin: '14px 3px 0' }}>Society funds earn {rate}% a year while they sit.</p>}
    </div>
  )
}
