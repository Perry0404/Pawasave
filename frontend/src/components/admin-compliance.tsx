'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Admin → Compliance (migration 119, /api/admin/compliance).
 * Laid out around the jobs: (1) anything needing attention, (2) find a customer and act,
 * (3) flags explained in plain language, (4) accounts on hold, (5) health numbers, (6) audit log.
 * Auth rides the admin cookie.
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

// What each flag means and what to do about it, in plain words.
const RULES: Record<string, { title: string; meaning: string; todo: string }> = {
  pass_through: {
    title: 'Money in and straight out',
    meaning: 'Over ₦200,000 came in and most of it left again within 24 hours. This is how "mule" accounts move stolen or laundered money.',
    todo: 'Open the customer. If the deposits and withdrawals have a normal explanation, clear them. If not, keep the hold and consider filing an STR.',
  },
  structuring: {
    title: 'Deposits split to stay under the limit',
    meaning: 'Three or more deposits of ₦18,000–₦20,000 in one day, just under the ₦20,000 tier limit. Splitting money to dodge limits is a classic laundering sign.',
    todo: 'Ask the customer to complete full KYC. If the pattern continues, consider an STR.',
  },
  ctr_threshold: {
    title: 'Over ₦5 million in a day',
    meaning: 'Large cash-equivalent movement that usually has to be reported to the NFIU as a currency transaction report.',
    todo: 'File the CTR on goAML, then press "Record CTR filed". Clear the hold once you are satisfied the money is legitimate.',
  },
  large_transaction: {
    title: 'Single transaction over ₦1 million',
    meaning: 'One large deposit or withdrawal. Usually fine, but worth a look for a new or lightly verified customer.',
    todo: 'Check the customer is fully verified and the amount fits who they are. Dismiss if it looks normal.',
  },
  new_account_large_inflow: {
    title: 'Big money into a brand-new account',
    meaning: 'Over ₦500,000 came into an account less than a week old.',
    todo: 'Check KYC is complete and the source is plausible. Dismiss if it looks normal.',
  },
  velocity: {
    title: 'Unusually many transactions',
    meaning: 'Ten or more deposits or withdrawals in one day.',
    todo: 'Look at the transactions. Often a trader or Ajo collector, which is fine. Dismiss if so.',
  },
  p2p_fan_out: {
    title: 'Paying many different people',
    meaning: 'This account sent money to 15 or more different people in one day.',
    todo: 'Could be payroll or an Ajo payout, or money being scattered. Open the customer and decide.',
  },
  pin_lockout: {
    title: 'PIN locked after wrong tries',
    meaning: 'Someone entered the wrong transaction PIN five times. Either the customer forgot it, or someone else is trying to get in.',
    todo: 'If the customer contacts support, verify them and reset the PIN. Otherwise dismiss.',
  },
}
const ACTIONS: Record<string, string> = {
  review: 'Paused money leaving', freeze: 'Froze everything', clear: 'Set back to normal', pin_reset: 'Reset PIN', note: 'Note',
  str_filed: 'STR filed with NFIU', ctr_filed: 'CTR filed with NFIU', auto_review: 'Automatic pause',
}
const STATUS_LABEL: Record<string, string> = { clear: 'Normal', review: 'Money leaving paused', frozen: 'Frozen' }
const STATUS_STYLE: Record<string, string> = { clear: 'bg-emerald-100 text-emerald-700', review: 'bg-amber-100 text-amber-700', frozen: 'bg-red-100 text-red-700' }
const SEV_STYLE = { high: 'bg-red-100 text-red-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-slate-100 text-slate-600' }
const SEV_LABEL = { high: 'High risk', medium: 'Check', low: 'FYI' }

const naira = (kobo?: number | null) => `₦${((kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
const when = (s?: string | null) => (s ? new Date(s).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—')

async function call(body: Record<string, unknown>) {
  const res = await fetch('/api/admin/compliance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const d = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(d?.error || 'Request failed')
  return d
}

function Section({ step, title, hint, right, children }: { step?: string; title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{step && <span className="text-slate-400 mr-1">{step}</span>}{title}</p>
          {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
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
  const [showLog, setShowLog] = useState(false)

  const load = useCallback(async () => {
    try { setData(await call({ action: 'overview' })); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'Could not load') }
  }, [])
  useEffect(() => { load() }, [load])

  const open = async (addr: string) => {
    if (!addr) return
    setEmail(addr); setBusy('lookup'); setNotice(''); setReason('')
    try { setLookup(await call({ action: 'lookup', email: addr.trim() })); setError('') } catch (e) { setLookup(null); setError(e instanceof Error ? e.message : 'Lookup failed') }
    setBusy('')
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const run = async (key: string, body: Record<string, unknown>, done: string, needsReason = true) => {
    if (needsReason && !reason.trim()) { setError('First write why, in the "Why?" box. It is saved to the audit log.'); return }
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
  const highFlags = data?.flags.filter((f) => f.severity === 'high') || []
  const attention = highFlags.length + (data?.held.length || 0)
  const btn = 'text-xs font-semibold px-3 py-2 rounded-lg border transition disabled:opacity-50'
  const pct = (a?: number | null, b?: number | null) => (b ? `${Math.round(((a || 0) / b) * 100)}%` : '—')

  return (
    <>
      {error && <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700">✓ {notice}</div>}

      {/* At a glance */}
      {data && (
        <div className={`mb-4 px-4 py-3 rounded-xl border text-sm ${attention ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {attention
            ? <><b>Needs your attention:</b> {highFlags.length} high-risk flag{highFlags.length === 1 ? '' : 's'} and {data.held.length} account{data.held.length === 1 ? '' : 's'} with money leaving paused. Work through them below.</>
            : <><b>All clear.</b> No high-risk flags and no accounts on hold. {data.flags.length ? `${data.flags.length} lower-risk flag${data.flags.length === 1 ? '' : 's'} to glance at below.` : ''}</>}
        </div>
      )}

      {/* 1. Find a customer */}
      <Section step="1" title="Find a customer" hint="Type their email to see their account and take action: support requests, investigations, PIN resets.">
        <div className="flex gap-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open(email)}
            placeholder="customer@email.com" className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2" />
          <button onClick={() => open(email)} disabled={!email || busy === 'lookup'} className={`${btn} bg-slate-900 text-white border-slate-900`}>
            {busy === 'lookup' ? 'Looking…' : 'Look up'}
          </button>
        </div>

        {lookup && (() => {
          const u = lookup.user
          const pinLocked = !!u.pin_locked_until && new Date(u.pin_locked_until) > new Date()
          return (
            <div className="mt-4 space-y-4 text-sm">
              {/* Who */}
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900 text-base">{u.name || u.email}</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[u.compliance_status] || STATUS_STYLE.clear}`}>{STATUS_LABEL[u.compliance_status] || u.compliance_status}</span>
                  {u.deleted && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">Deleted</span>}
                </div>
                {u.compliance_reason && <p className="text-xs text-amber-700 mt-1">Why it&apos;s paused: {u.compliance_reason}</p>}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-2">
                  <span className="text-slate-500">Email</span><span className="text-slate-800 break-all">{u.email}</span>
                  <span className="text-slate-500">Joined</span><span className="text-slate-800">{when(u.joined)}</span>
                  <span className="text-slate-500">Identity</span>
                  <span className="text-slate-800">{u.kyc_status === 'verified' ? 'Fully verified' : u.bvn_account ? 'BVN only (lite)' : 'Not verified'}</span>
                  <span className="text-slate-500">Transaction PIN</span>
                  <span className={!u.pin_set || pinLocked ? 'text-red-600 font-semibold' : 'text-slate-800'}>
                    {!u.pin_set ? 'Not set' : pinLocked ? `Locked until ${when(u.pin_locked_until)}` : 'Set'}
                    {u.pin_set && u.pin_format === 'legacy' ? ' (from signup, old format: still works if they remember it)' : ''}
                    {u.pin_failed_attempts ? ` · ${u.pin_failed_attempts} wrong tr${u.pin_failed_attempts === 1 ? 'y' : 'ies'}` : ''}
                  </span>
                  <span className="text-slate-500">Balance</span>
                  <span className="text-slate-800">{naira(lookup.wallet?.naira_balance_kobo)} naira · ₦{((lookup.wallet?.cngn_pool_micro || 0) / 1e6).toLocaleString('en-NG')} cNGN</span>
                </div>
              </div>

              {/* Why */}
              <div className="border-t border-slate-100 pt-3">
                <label className="text-xs font-semibold text-slate-700">Why? <span className="font-normal text-slate-500">(needed for every action below; saved to the audit log)</span></label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder='e.g. "Customer forgot PIN; verified by email"'
                  className="mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2" />
              </div>

              {/* Account status */}
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-2">Account status</p>
                <div className="grid sm:grid-cols-3 gap-2">
                  {([
                    ['clear', 'Normal', 'Everything works.', 'border-emerald-300 hover:bg-emerald-50'],
                    ['review', 'Pause money leaving', 'Deposits still arrive. Withdrawals, transfers, payments and new loans are blocked until you set it back to normal.', 'border-amber-300 hover:bg-amber-50'],
                    ['frozen', 'Freeze everything', 'As above, and investing is blocked too. For serious cases.', 'border-red-300 hover:bg-red-50'],
                  ] as const).map(([s, label, desc, style]) => {
                    const current = u.compliance_status === s
                    return (
                      <button key={s} disabled={!!busy || current}
                        onClick={() => run(s, { action: 'set_status', userId: u.id, status: s }, s === 'clear' ? 'Account set back to normal. Its open flags are marked handled.' : s === 'review' ? 'Money leaving is now paused for this customer.' : 'Account frozen.')}
                        className={`text-left p-3 rounded-lg border transition disabled:cursor-default ${current ? 'bg-slate-50 border-slate-400' : style}`}>
                        <p className="text-sm font-semibold text-slate-900">{label}{current ? ' (current)' : ''}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{desc}</p>
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">The customer only sees: &quot;Your account is under a routine review.&quot; Never tell a customer they are suspected or reported; that is illegal tipping-off.</p>
              </div>

              {/* Support */}
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-2">Support</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button disabled={!!busy} onClick={() => run('pin', { action: 'pin_reset', userId: u.id }, 'PIN reset. The customer has been emailed and will create a new PIN next time they open the app.')}
                    className={`${btn} border-slate-300 text-slate-800 hover:bg-slate-50`}>Reset PIN</button>
                  <span className="text-xs text-slate-500">For a customer who forgot their PIN. Make sure it is really them first.</span>
                </div>
              </div>

              {/* Reports */}
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-2">Reports to the NFIU</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button disabled={!!busy} onClick={() => run('str', { action: 'log', userId: u.id, kind: 'str_filed' }, 'STR filing recorded.')} className={`${btn} border-slate-300 text-slate-800 hover:bg-slate-50`}>I filed an STR</button>
                  <button disabled={!!busy} onClick={() => run('ctr', { action: 'log', userId: u.id, kind: 'ctr_filed' }, 'CTR filing recorded.')} className={`${btn} border-slate-300 text-slate-800 hover:bg-slate-50`}>I filed a CTR</button>
                  <button disabled={!!busy} onClick={() => run('note', { action: 'log', userId: u.id, kind: 'note' }, 'Note saved.')} className={`${btn} border-slate-300 text-slate-800 hover:bg-slate-50`}>Just add a note</button>
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">These only record that you filed on goAML; they don&apos;t file anything. STR = suspicious transaction report. CTR = currency transaction report (large amounts).</p>
              </div>

              {/* History */}
              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold text-slate-700 mb-1">Recent transactions</p>
                {lookup.transactions.length === 0 ? <p className="text-xs text-slate-400">None</p> : (
                  <div className="max-h-56 overflow-y-auto divide-y divide-slate-50">
                    {lookup.transactions.map((t, i) => (
                      <div key={i} className="flex justify-between gap-2 py-1 text-xs">
                        <span className="text-slate-500 shrink-0">{when(t.created_at)}</span>
                        <span className="text-slate-700 truncate">{t.type.replace(/_/g, ' ')}{t.status && t.status !== 'completed' ? ` (${t.status})` : ''}</span>
                        <span className={`tabular-nums shrink-0 ${t.direction === 'credit' ? 'text-emerald-600' : 'text-slate-800'}`}>{t.direction === 'credit' ? '+' : '−'}{naira(t.amount_kobo)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {(lookup.flags.length > 0 || lookup.actions.length > 0) && (
                <div className="border-t border-slate-100 pt-3 space-y-1">
                  <p className="text-xs font-semibold text-slate-700">Compliance history</p>
                  {lookup.flags.map((f) => (
                    <p key={`f${f.id}`} className="text-xs text-slate-700">
                      <span className={`font-semibold px-1.5 rounded ${SEV_STYLE[f.severity]}`}>{SEV_LABEL[f.severity]}</span> {RULES[f.rule]?.title || f.rule} · {f.status === 'open' ? 'open' : f.status === 'dismissed' ? 'looked fine' : 'handled'} · {when(f.created_at)}
                    </p>
                  ))}
                  {lookup.actions.map((a, i) => (
                    <p key={`a${i}`} className="text-xs text-slate-700">{when(a.created_at)} · <b>{ACTIONS[a.action] || a.action}</b>{a.reason ? `: ${a.reason}` : ''} <span className="text-slate-400">({a.actor})</span></p>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
      </Section>

      {/* 2. Flags */}
      <Section step="2" title={`Flags to review (${data?.flags.length ?? 0})`}
        hint="The system checks every transaction hourly. High-risk flags pause the account automatically."
        right={<button disabled={!!busy} onClick={() => run('scan', { action: 'scan' }, 'Checked all recent transactions.', false)} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0`}>{busy === 'scan' ? 'Checking…' : 'Check now'}</button>}>
        {!data ? <p className="text-sm text-slate-400">Loading…</p> : data.flags.length === 0 ? <p className="text-sm text-slate-500">Nothing to review.</p> : (
          <div className="space-y-3">
            {data.flags.map((f) => {
              const r = RULES[f.rule]
              return (
                <div key={f.id} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${SEV_STYLE[f.severity]}`}>{SEV_LABEL[f.severity]}</span>
                    <span className="text-sm font-semibold text-slate-900">{r?.title || f.rule}</span>
                  </div>
                  <p className="text-xs text-slate-700 mt-1 break-all"><b>{f.email || 'Unknown customer'}</b> · {when(f.created_at)}</p>
                  {r && <p className="text-xs text-slate-600 mt-1"><b>What it means:</b> {r.meaning}</p>}
                  {r && <p className="text-xs text-slate-600 mt-0.5"><b>What to do:</b> {r.todo}</p>}
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => open(f.email)} disabled={!f.email} className={`${btn} border-slate-900 bg-slate-900 text-white`}>Open customer</button>
                    <button disabled={!!busy} onClick={() => run(`d${f.id}`, { action: 'resolve_flag', flagId: f.id, outcome: 'dismissed', note: 'Reviewed: looks fine' }, 'Flag closed as fine.', false)} className={`${btn} border-slate-300 text-slate-600 hover:bg-slate-50`}>Looks fine</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {/* 3. Held accounts */}
      <Section step="3" title={`Accounts with money leaving paused (${data?.held.length ?? 0})`} hint="Open one, check it, and set it back to Normal once you're satisfied.">
        {!data || data.held.length === 0 ? <p className="text-sm text-slate-500">None.</p> : data.held.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-2 py-2 text-sm border-b border-slate-50 last:border-0">
            <div className="min-w-0">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full mr-2 ${STATUS_STYLE[h.compliance_status]}`}>{STATUS_LABEL[h.compliance_status]}</span>
              <span className="text-slate-800 break-all">{h.email || h.display_name}</span>
              <p className="text-xs text-slate-500 mt-0.5">{h.compliance_reason} · since {when(h.compliance_updated_at)}</p>
            </div>
            <button onClick={() => open(h.email)} disabled={!h.email} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0`}>Open</button>
          </div>
        ))}
      </Section>

      {/* 4. Health numbers */}
      <Section title="Compliance health" hint="The numbers a regulator or partner will ask about.">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {[
            ['Customers verified (BVN or full)', `${Math.max(m.users_bvn_onboarded || 0, m.users_kyc_verified || 0)} of ${m.users_total ?? '—'} (${pct(Math.max(m.users_bvn_onboarded || 0, m.users_kyc_verified || 0), m.users_total)})`],
            ['Fully verified (biometric)', `${m.users_kyc_verified ?? '—'} (${pct(m.users_kyc_verified, m.users_total)})`],
            ['Money moved by verified customers (30 days)', pct(m.volume_30d_verified_naira, m.volume_30d_naira)],
            ['Flags raised (7 days)', String(m.flags_7d ?? '—')],
            ['Typical time to handle a flag', m.median_hours_to_resolve != null ? `${m.median_hours_to_resolve} hours` : '—'],
            ['Flags that turned out fine (30 days)', pct(m.flags_dismissed_30d, (m.flags_dismissed_30d || 0) + (m.flags_actioned_30d || 0))],
            ['STRs filed (30 days)', String(m.str_filed_30d ?? '—')],
            ['CTRs filed (30 days)', String(m.ctr_filed_30d ?? '—')],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-slate-500">{k}</span><span className="text-slate-900 font-semibold tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* 5. Audit log */}
      <Section title="Audit log" hint="Every action taken, by whom and why."
        right={<button onClick={() => setShowLog((v) => !v)} className={`${btn} border-slate-300 text-slate-700 hover:bg-slate-50 shrink-0`}>{showLog ? 'Hide' : `Show (${data?.actions.length ?? 0})`}</button>}>
        {showLog && (!data || data.actions.length === 0 ? <p className="text-sm text-slate-500">Nothing yet.</p> : data.actions.map((a) => (
          <p key={a.id} className="text-xs text-slate-700 py-0.5 break-all">
            {when(a.created_at)} · <b>{ACTIONS[a.action] || a.action}</b> · {a.email || a.user_id}{a.reason ? `: ${a.reason}` : ''} <span className="text-slate-400">({a.actor})</span>
          </p>
        )))}
      </Section>
    </>
  )
}
