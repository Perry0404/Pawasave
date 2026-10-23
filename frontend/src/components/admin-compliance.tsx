'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Admin → Compliance (migration 119, /api/admin/compliance).
 * Metrics, the open-flag queue, accounts on hold, a customer lookup with actions (hold, freeze,
 * clear, reset PIN, record an STR/CTR filing) and the audit trail. Auth rides the admin cookie.
 */

type Metrics = Record<string, number | null>
type Flag = { id: number; user_id: string; email: string; rule: string; severity: 'high' | 'medium' | 'low'; details: Record<string, unknown>; status: string; created_at: string; note?: string }
type Action = { id?: number; user_id?: string; email?: string; action: string; reason: string | null; actor: string; created_at: string }
type Held = { id: string; email: string; display_name: string; compliance_status: string; compliance_reason: string | null; compliance_updated_at: string | null }
type Lookup = {
  user: { id: string; email: string; name: string; joined: string; kyc_status: string; kyc_tier: string | null; bvn_account: boolean
    compliance_status: string; compliance_reason: string | null; pin_set: boolean; pin_format: string; pin_locked_until: string | null
    pin_failed_attempts: number; deleted: boolean }
  wallet: { naira_balance_kobo?: number; usdc_balance_micro?: number; cngn_pool_micro?: number } | null
  transactions: { created_at: string; type: string; direction: string; amount_kobo: number; status: string; description: string }[]
  flags: Flag[]
  actions: Action[]
}

const RULES: Record<string, string> = {
  large_transaction: 'Large transaction',
  ctr_threshold: 'Over ₦5m in a day (CTR)',
  velocity: 'Unusually many transactions',
  pass_through: 'Money in and straight out',
  structuring: 'Deposits split just under the limit',
  new_account_large_inflow: 'Large inflow to a new account',
  p2p_fan_out: 'Paying many different people',
  pin_lockout: 'PIN lockout',
}
const ACTIONS: Record<string, string> = {
  review: 'Put on review', freeze: 'Frozen', clear: 'Cleared', pin_reset: 'PIN reset', note: 'Note',
  str_filed: 'STR filed with NFIU', ctr_filed: 'CTR filed with NFIU', auto_review: 'Automatic hold',
}
const SEV = { high: 'bg-red-100 text-red-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-slate-100 text-slate-600' }
const STATUS: Record<string, string> = { clear: 'bg-emerald-100 text-emerald-700', review: 'bg-amber-100 text-amber-700', frozen: 'bg-red-100 text-red-700' }

const naira = (kobo?: number | null) => `₦${((kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
const when = (s?: string | null) => (s ? new Date(s).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
const details = (d: Record<string, unknown>) => Object.entries(d || {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'number' && /naira/.test(k) ? `₦${v.toLocaleString('en-NG')}` : v}`).join(' · ')

async function call(body: Record<string, unknown>) {
  const res = await fetch('/api/admin/compliance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || 'Request failed')
  return d
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {right}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value, tone = 'text-slate-800' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <p className="text-[11px] text-slate-500 leading-tight">{label}</p>
      <p className={`text-lg font-bold tabular-nums mt-0.5 ${tone}`}>{value}</p>
    </div>
  )
}

export default function AdminCompliance() {
  const [data, setData] = useState<{ metrics: Metrics; flags: Flag[]; actions: Action[]; held: Held[] } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [email, setEmail] = useState('')
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try { setData(await call({ action: 'overview' })); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'Could not load') }
  }, [])
  useEffect(() => { load() }, [load])

  const open = async (addr: string) => {
    setEmail(addr); setBusy('lookup'); setNotice('')
    try { setLookup(await call({ action: 'lookup', email: addr })); setError('') } catch (e) { setLookup(null); setError(e instanceof Error ? e.message : 'Lookup failed') }
    setBusy('')
  }

  const run = async (key: string, body: Record<string, unknown>, done: string, needsReason = true) => {
    if (needsReason && !reason.trim()) { setError('Write a reason first: it goes in the audit log.'); return }
    setBusy(key); setError(''); setNotice('')
    try {
      await call({ ...body, reason: reason.trim() })
      setNotice(done); setReason('')
      await load()
      if (lookup) setLookup(await call({ action: 'lookup', email: lookup.user.email }))
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed') }
    setBusy('')
  }

  const m = data?.metrics || {}
  const pct = (a?: number | null, b?: number | null) => (b ? `${Math.round(((a || 0) / b) * 100)}%` : '—')
  const btn = 'text-xs font-semibold px-3 py-1.5 rounded-lg border transition disabled:opacity-50'

  return (
    <>
      {error && <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700">{notice}</div>}

      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
        <Stat label="Open high-risk flags" value={String(m.flags_open_high ?? '—')} tone={(m.flags_open_high || 0) > 0 ? 'text-red-600' : 'text-slate-800'} />
        <Stat label="Open medium / low flags" value={`${m.flags_open_medium ?? '—'} / ${m.flags_open_low ?? '—'}`} />
        <Stat label="Accounts on review / frozen" value={`${m.users_in_review ?? '—'} / ${m.users_frozen ?? '—'}`} tone="text-amber-600" />
        <Stat label="Flags in the last 7 days" value={String(m.flags_7d ?? '—')} />
        <Stat label="Median time to resolve" value={m.median_hours_to_resolve != null ? `${m.median_hours_to_resolve} h` : '—'} />
        <Stat label="False-positive rate (30d)" value={pct(m.flags_dismissed_30d, (m.flags_dismissed_30d || 0) + (m.flags_actioned_30d || 0))} />
        <Stat label="KYC verified" value={`${m.users_kyc_verified ?? '—'} (${pct(m.users_kyc_verified, m.users_total)})`} />
        <Stat label="BVN account opened" value={`${m.users_bvn_onboarded ?? '—'} (${pct(m.users_bvn_onboarded, m.users_total)})`} />
        <Stat label="Volume from verified users (30d)" value={pct(m.volume_30d_verified_naira, m.volume_30d_naira)} />
        <Stat label="STRs filed (30d)" value={String(m.str_filed_30d ?? '—')} />
        <Stat label="CTRs filed (30d)" value={String(m.ctr_filed_30d ?? '—')} />
        <Stat label="Deposits + withdrawals (30d)" value={m.volume_30d_naira != null ? `₦${Number(m.volume_30d_naira).toLocaleString('en-NG')}` : '—'} />
      </div>

      {/* Customer lookup */}
      <Card title="Look up a customer">
        <div className="flex gap-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open(email)}
            placeholder="customer@email.com" className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2" />
          <button onClick={() => open(email)} disabled={!email || busy === 'lookup'} className={`${btn} bg-slate-900 text-white border-slate-900`}>
            {busy === 'lookup' ? 'Looking…' : 'Look up'}
          </button>
        </div>

        {lookup && (
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">{lookup.user.name || lookup.user.email}</span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS[lookup.user.compliance_status] || STATUS.clear}`}>{lookup.user.compliance_status}</span>
              {lookup.user.deleted && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">deleted</span>}
            </div>
            {lookup.user.compliance_reason && <p className="text-xs text-amber-700">Hold reason: {lookup.user.compliance_reason}</p>}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-500">Email</span><span className="text-slate-800 break-all">{lookup.user.email}</span>
              <span className="text-slate-500">Joined</span><span className="text-slate-800">{when(lookup.user.joined)}</span>
              <span className="text-slate-500">KYC</span><span className="text-slate-800">{lookup.user.kyc_status}{lookup.user.kyc_tier ? ` · tier ${lookup.user.kyc_tier}` : ''}</span>
              <span className="text-slate-500">BVN account</span><span className="text-slate-800">{lookup.user.bvn_account ? 'Yes' : 'No'}</span>
              <span className="text-slate-500">Transaction PIN</span>
              <span className={lookup.user.pin_set ? 'text-slate-800' : 'text-red-600 font-semibold'}>
                {lookup.user.pin_set ? `Set (${lookup.user.pin_format === 'legacy' ? 'old format' : 'current format'})` : 'Not set'}
                {lookup.user.pin_locked_until && new Date(lookup.user.pin_locked_until) > new Date() ? ` · locked until ${when(lookup.user.pin_locked_until)}` : ''}
                {lookup.user.pin_failed_attempts ? ` · ${lookup.user.pin_failed_attempts} failed tries` : ''}
              </span>
              <span className="text-slate-500">Balances</span>
              <span className="text-slate-800">
                {naira(lookup.wallet?.naira_balance_kobo)} naira · ₦{((lookup.wallet?.cngn_pool_micro || 0) / 1e6).toLocaleString('en-NG')} cNGN
              </span>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <label className="text-xs font-semibold text-slate-600">Reason (required, saved to the audit log)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Pass-through pattern under investigation"
                className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
              <div className="flex flex-wrap gap-2 mt-2">
                <button disabled={!!busy} onClick={() => run('review', { action: 'set_status', userId: lookup.user.id, status: 'review' }, 'Account put on review: outflows paused.')} className={`${btn} border-amber-300 text-amber-700 hover:bg-amber-50`}>Put on review</button>
                <button disabled={!!busy} onClick={() => run('freeze', { action: 'set_status', userId: lookup.user.id, status: 'frozen' }, 'Account frozen: outflows and investing paused.')} className={`${btn} border-red-300 text-red-700 hover:bg-red-50`}>Freeze</button>
                <button disabled={!!busy} onClick={() => run('clear', { action: 'set_status', userId: lookup.user.id, status: 'clear' }, 'Account cleared. Open flags marked actioned.')} className={`${btn} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}>Clear</button>
                <button disabled={!!busy} onClick={() => run('pin', { action: 'pin_reset', userId: lookup.user.id }, 'PIN reset. The customer will be asked to create a new one when they sign in, and has been emailed.')} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50`}>Reset PIN</button>
                <button disabled={!!busy} onClick={() => run('str', { action: 'log', userId: lookup.user.id, kind: 'str_filed' }, 'STR filing recorded.')} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50`}>Record STR filed</button>
                <button disabled={!!busy} onClick={() => run('ctr', { action: 'log', userId: lookup.user.id, kind: 'ctr_filed' }, 'CTR filing recorded.')} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50`}>Record CTR filed</button>
                <button disabled={!!busy} onClick={() => run('note', { action: 'log', userId: lookup.user.id, kind: 'note' }, 'Note saved.')} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50`}>Add note</button>
              </div>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <p className="text-xs font-semibold text-slate-600 mb-1">Recent transactions</p>
              {lookup.transactions.length === 0 ? <p className="text-xs text-slate-400">None</p> : (
                <div className="max-h-56 overflow-y-auto divide-y divide-slate-50">
                  {lookup.transactions.map((t, i) => (
                    <div key={i} className="flex justify-between gap-2 py-1 text-xs">
                      <span className="text-slate-500 shrink-0">{when(t.created_at)}</span>
                      <span className="text-slate-700 truncate">{t.type}{t.status && t.status !== 'completed' ? ` (${t.status})` : ''}</span>
                      <span className={`tabular-nums shrink-0 ${t.direction === 'credit' ? 'text-emerald-600' : 'text-slate-800'}`}>{t.direction === 'credit' ? '+' : '−'}{naira(t.amount_kobo)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {lookup.flags.length > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">Flags</p>
                {lookup.flags.map((f) => (
                  <p key={f.id} className="text-xs text-slate-700 py-0.5">
                    <span className={`font-semibold px-1.5 rounded ${SEV[f.severity]}`}>{f.severity}</span> {RULES[f.rule] || f.rule} · {f.status} · {when(f.created_at)}
                  </p>
                ))}
              </div>
            )}

            {lookup.actions.length > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">History</p>
                {lookup.actions.map((a, i) => (
                  <p key={i} className="text-xs text-slate-700 py-0.5">{when(a.created_at)} · <b>{ACTIONS[a.action] || a.action}</b>{a.reason ? `: ${a.reason}` : ''} <span className="text-slate-400">({a.actor})</span></p>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Flag queue */}
      <Card title={`Open flags (${data?.flags.length ?? 0})`}
        right={<button disabled={!!busy} onClick={() => run('scan', { action: 'scan' }, 'Scan complete.', false)} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50`}>{busy === 'scan' ? 'Scanning…' : 'Run scan now'}</button>}>
        {!data ? <p className="text-sm text-slate-400">Loading…</p> : data.flags.length === 0 ? <p className="text-sm text-slate-400">No open flags.</p> : (
          <div className="divide-y divide-slate-100">
            {data.flags.map((f) => (
              <div key={f.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${SEV[f.severity]}`}>{f.severity}</span>
                  <span className="text-sm font-semibold text-slate-800">{RULES[f.rule] || f.rule}</span>
                  <span className="text-xs text-slate-400">{when(f.created_at)}</span>
                </div>
                <p className="text-xs text-slate-600 mt-0.5 break-all">{f.email || f.user_id} · {details(f.details)}</p>
                <div className="flex gap-2 mt-1.5">
                  <button onClick={() => open(f.email)} disabled={!f.email} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50`}>Open customer</button>
                  <button disabled={!!busy} onClick={() => run(`d${f.id}`, { action: 'resolve_flag', flagId: f.id, outcome: 'dismissed', note: reason.trim() || 'Reviewed: not suspicious' }, 'Flag dismissed.', false)} className={`${btn} border-slate-300 text-slate-500 hover:bg-slate-50`}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Held accounts */}
      <Card title={`Accounts on hold (${data?.held.length ?? 0})`}>
        {!data || data.held.length === 0 ? <p className="text-sm text-slate-400">None.</p> : data.held.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
            <div className="min-w-0">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full mr-2 ${STATUS[h.compliance_status]}`}>{h.compliance_status}</span>
              <span className="text-slate-800 break-all">{h.email || h.display_name}</span>
              <p className="text-xs text-slate-500">{h.compliance_reason} · {when(h.compliance_updated_at)}</p>
            </div>
            <button onClick={() => open(h.email)} disabled={!h.email} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0`}>Open</button>
          </div>
        ))}
      </Card>

      {/* Audit trail */}
      <Card title="Recent compliance actions">
        {!data || data.actions.length === 0 ? <p className="text-sm text-slate-400">None yet.</p> : data.actions.map((a) => (
          <p key={a.id} className="text-xs text-slate-700 py-0.5 break-all">
            {when(a.created_at)} · <b>{ACTIONS[a.action] || a.action}</b> · {a.email || a.user_id}{a.reason ? `: ${a.reason}` : ''} <span className="text-slate-400">({a.actor})</span>
          </p>
        ))}
      </Card>
    </>
  )
}
