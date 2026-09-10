'use client'

import { useState } from 'react'
import { formatNaira, formatCngn, koboToMicroUsdc, microUsdcToKobo } from '@/lib/format'
import {
  useSavingsLocks, lockSavings, withdrawLock,
  useSavingsGoals, createSavingsGoal, contributeToGoal, completeSavingsGoal, breakSavingsGoal,
} from '@/hooks/use-data'
import type { Wallet, SavingsLock, SavingsGoal } from '@/lib/types'
import { useConfirm } from '@/components/confirm-dialog'

interface Props {
  wallet: Wallet | null
  refresh: () => void
}

const LOCK_DURATIONS = [
  { days: 30, label: '30 days', apy: 15 },
  { days: 90, label: '90 days', apy: 22 },
  { days: 180, label: '6 months', apy: 30 },
  { days: 365, label: '1 year', apy: 40 },
]
const FREQ = ['daily', 'weekly', 'monthly'] as const
const FREQ_LABELS: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

const IconLock = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="9" width="16" height="12" rx="2" /><path d="M8 9V7a4 4 0 0 1 8 0v2" /></svg>
const IconPlus = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
const Chevron = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>

type Screen = 'main' | 'lock' | 'goal-new' | { goal: SavingsGoal }

export default function SaveView({ wallet, refresh }: Props) {
  const { locks, refresh: refreshLocks } = useSavingsLocks()
  const { goals, refresh: refreshGoals } = useSavingsGoals()
  const confirm = useConfirm()
  const [screen, setScreen] = useState<Screen>('main')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // lock form
  const [lockAmt, setLockAmt] = useState('')
  const [lockDays, setLockDays] = useState(90)
  const [lockAgree, setLockAgree] = useState(false)

  // goal form
  const [gTitle, setGTitle] = useState('')
  const [gTarget, setGTarget] = useState('')
  const [gContrib, setGContrib] = useState('')
  const [gFreq, setGFreq] = useState<typeof FREQ[number]>('monthly')
  const [gAgree, setGAgree] = useState(false)

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000) }
  const isErr = (m: string) => /insufficient|minimum|failed|cannot|enter|could not/i.test(m)

  if (!wallet) return <div className="b" />

  const poolMicro = (wallet.cngn_pool_micro || 0) + (wallet.cngn_yield_earned_micro || 0)
  const poolKobo = microUsdcToKobo(poolMicro)
  const spendableKobo = microUsdcToKobo(wallet.usdc_balance_micro || 0)
  const activeLocks = locks.filter((l) => l.status === 'active')
  const activeGoals = goals.filter((g) => g.status === 'active')

  // ── create a fixed deposit ──
  const submitLock = async () => {
    const naira = parseFloat(lockAmt)
    if (!naira || naira < 100) { flash('Minimum ₦100'); return }
    if (!lockAgree) { flash('Please accept the lock terms'); return }
    const kobo = Math.round(naira * 100)
    const usdc = koboToMicroUsdc(kobo)
    const apy = LOCK_DURATIONS.find((d) => d.days === lockDays)?.apy || 15
    setBusy(true)
    try {
      await lockSavings(usdc, kobo, lockDays, apy, true)
      flash(`Locked ${formatNaira(kobo)} for ${lockDays} days at ${apy}% APY`)
      setLockAmt(''); setLockAgree(false)
      refreshLocks(); refresh()
      setScreen('main')
    } catch (e: any) { flash(e.message || 'Failed to lock') } finally { setBusy(false) }
  }

  const doWithdrawLock = async (lock: SavingsLock) => {
    const matured = new Date(lock.unlocks_at) <= new Date()
    if (!matured && !(await confirm({ title: 'Early withdrawal', message: 'Early withdrawal forfeits all interest and incurs a 0.5% penalty on principal.', confirmText: 'Withdraw anyway', danger: true }))) return
    setBusy(true)
    try {
      await withdrawLock(lock.id, !matured)
      flash(matured ? 'Matured lock withdrawn with interest' : 'Lock withdrawn early (principal only)')
      refreshLocks(); refresh()
    } catch (e: any) { flash(e.message || 'Failed to withdraw') } finally { setBusy(false) }
  }

  // ── create a goal ──
  const submitGoal = async () => {
    const target = parseFloat(gTarget), contrib = parseFloat(gContrib)
    if (!gTitle.trim()) { flash('Enter a goal title'); return }
    if (!target || target < 1000) { flash('Minimum target ₦1,000'); return }
    if (!contrib || contrib < 100) { flash('Minimum contribution ₦100'); return }
    if (contrib > target) { flash('Contribution cannot exceed target'); return }
    if (!gAgree) { flash('Please accept the goal terms'); return }
    const targetKobo = Math.round(target * 100), contribKobo = Math.round(contrib * 100)
    setBusy(true)
    try {
      await createSavingsGoal({
        title: gTitle.trim(), targetKobo, targetUsdc: koboToMicroUsdc(targetKobo),
        frequency: gFreq, contribKobo, contribUsdc: koboToMicroUsdc(contribKobo), userConsentAccepted: true,
      })
      flash('Goal created')
      setGTitle(''); setGTarget(''); setGContrib(''); setGAgree(false)
      refreshGoals()
      setScreen('main')
    } catch (e: any) { flash(e.message || 'Failed to create goal') } finally { setBusy(false) }
  }

  const doContribute = async (g: SavingsGoal) => {
    setBusy(true)
    try {
      const ok = await contributeToGoal(g.id, g.contribution_naira_kobo, g.contribution_usdc_micro)
      if (!ok) { flash('Insufficient balance'); return }
      flash(`Saved ${formatNaira(g.contribution_naira_kobo)} toward "${g.title}"`)
      refreshGoals(); refresh()
    } catch (e: any) { flash(e.message || 'Contribution failed') } finally { setBusy(false) }
  }

  const doComplete = async (g: SavingsGoal) => {
    setBusy(true)
    try {
      const interest = await completeSavingsGoal(g.id)
      flash(`Goal complete! Earned ${formatCngn(interest)} interest`)
      refreshGoals(); refresh(); setScreen('main')
    } catch (e: any) { flash(e.message || 'Could not complete') } finally { setBusy(false) }
  }

  const doBreak = async (g: SavingsGoal) => {
    if (!(await confirm({ title: 'Break goal early?', message: 'You only get your principal back — no interest.', confirmText: 'Break goal', danger: true }))) return
    setBusy(true)
    try {
      await breakSavingsGoal(g.id)
      flash('Goal broken. Principal returned.')
      refreshGoals(); refresh(); setScreen('main')
    } catch (e: any) { flash(e.message || 'Could not break') } finally { setBusy(false) }
  }

  // ══ LOCK FORM ══
  if (screen === 'lock') {
    const naira = parseFloat(lockAmt) || 0
    const apy = LOCK_DURATIONS.find((d) => d.days === lockDays)?.apy || 15
    const interest = Math.floor(koboToMicroUsdc(Math.round(naira * 100)) * (apy / 100) * (lockDays / 365))
    return (
      <div className="b">
        <button className="back" onClick={() => setScreen('main')}>← Back</button>
        <div className="h2">Start a fixed deposit</div>
        <p className="p">Lock cNGN for a set term and earn a higher, guaranteed rate.</p>

        <label className="lab">Amount to lock (₦)</label>
        <input className="field" type="number" inputMode="numeric" value={lockAmt} onChange={(e) => setLockAmt(e.target.value)} placeholder="0" autoFocus />
        <p className="p" style={{ margin: '6px 3px 0' }}>Available in savings: {formatNaira(poolKobo)}</p>

        <label className="lab" style={{ marginTop: 16 }}>Term</label>
        <div className="terms" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
          {LOCK_DURATIONS.map((d) => (
            <button key={d.days} className={`term${lockDays === d.days ? ' on' : ''}`} onClick={() => setLockDays(d.days)}>
              {d.label} · {d.apy}%
            </button>
          ))}
        </div>

        {naira >= 100 && (
          <div className="info" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="l">At maturity you get</span>
              <span className="code">{formatCngn(koboToMicroUsdc(Math.round(naira * 100)) + interest)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span className="l">Interest ({apy}% · {lockDays}d)</span>
              <span className="code" style={{ color: 'var(--green)' }}>+{formatCngn(interest)}</span>
            </div>
          </div>
        )}

        <label style={{ display: 'flex', gap: 9, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
          <input type="checkbox" checked={lockAgree} onChange={(e) => setLockAgree(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand my funds are locked until maturity. Early withdrawal forfeits all interest and incurs a 0.5% penalty on principal.</span>
        </label>

        {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}
        <button className="cta" onClick={submitLock} disabled={busy || !lockAmt}>Lock {lockAmt ? formatNaira(Math.round(parseFloat(lockAmt) * 100)) : ''}</button>
      </div>
    )
  }

  // ══ NEW GOAL FORM ══
  if (screen === 'goal-new') {
    const target = parseFloat(gTarget) || 0, contrib = parseFloat(gContrib) || 0
    const periods = contrib > 0 ? Math.ceil(target / contrib) : null
    return (
      <div className="b">
        <button className="back" onClick={() => setScreen('main')}>← Back</button>
        <div className="h2">New savings goal</div>
        <p className="p">Save toward a target and earn while you do. Break early and you keep principal only.</p>

        <label className="lab">What are you saving for?</label>
        <input className="field" value={gTitle} onChange={(e) => setGTitle(e.target.value)} placeholder="e.g. New laptop, Rent, Emergency fund" maxLength={100} />

        <label className="lab" style={{ marginTop: 14 }}>Target amount (₦)</label>
        <input className="field" type="number" inputMode="numeric" value={gTarget} onChange={(e) => setGTarget(e.target.value)} placeholder="0" />

        <label className="lab" style={{ marginTop: 14 }}>Contribution frequency</label>
        <div className="terms">
          {FREQ.map((f) => <button key={f} className={`term${gFreq === f ? ' on' : ''}`} onClick={() => setGFreq(f)}>{FREQ_LABELS[f]}</button>)}
        </div>

        <label className="lab" style={{ marginTop: 14 }}>Amount per {gFreq === 'daily' ? 'day' : gFreq === 'weekly' ? 'week' : 'month'} (₦)</label>
        <input className="field" type="number" inputMode="numeric" value={gContrib} onChange={(e) => setGContrib(e.target.value)} placeholder="0" />
        {periods !== null && periods > 0 && <p className="p" style={{ margin: '6px 3px 0' }}>≈ {periods} {gFreq === 'daily' ? 'days' : gFreq === 'weekly' ? 'weeks' : 'months'} to reach your goal</p>}

        <label style={{ display: 'flex', gap: 9, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
          <input type="checkbox" checked={gAgree} onChange={(e) => setGAgree(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand contributions are locked until I reach my target, and breaking early forfeits all accrued interest.</span>
        </label>

        {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}
        <button className="cta" onClick={submitGoal} disabled={busy}>Create goal</button>
      </div>
    )
  }

  // ══ GOAL DETAIL ══
  if (typeof screen === 'object') {
    const g = activeGoals.find((x) => x.id === screen.goal.id) || screen.goal
    const pct = Math.min(100, Math.round((g.saved_usdc_micro / g.target_usdc_micro) * 100))
    const met = g.saved_usdc_micro >= g.target_usdc_micro
    return (
      <div className="b">
        <button className="back" onClick={() => setScreen('main')}>← All goals</button>
        <div className="pool">
          <div className="l">{g.title}</div>
          <div className="v num">{formatNaira(g.saved_naira_kobo)}</div>
          <span className="apy">of {formatNaira(g.target_naira_kobo)} · {FREQ_LABELS[g.frequency]}</span>
          <div className="bar" style={{ marginTop: 14, background: 'rgba(255,255,255,.2)' }}><i style={{ width: `${pct}%`, background: '#fff' }} /></div>
        </div>
        {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}
        {g.status === 'active' && (
          <>
            {!met ? (
              <button className="cta" onClick={() => doContribute(g)} disabled={busy}>Save {formatNaira(g.contribution_naira_kobo)} now</button>
            ) : (
              <button className="cta" onClick={() => doComplete(g)} disabled={busy}>Claim goal + interest 🎉</button>
            )}
            <button className="cta ghost" onClick={() => doBreak(g)} disabled={busy} style={{ marginTop: 10 }}>Break goal early (no interest)</button>
          </>
        )}
      </div>
    )
  }

  // ══ MAIN ══
  return (
    <div className="b">
      <div className="h2">Save</div>
      <p className="p">Grow steadily, or lock in for a higher rate.</p>

      <div className="pool rise">
        <div className="l">Savings pool</div>
        <div className="v num">{formatNaira(poolKobo)}</div>
        <span className="apy">Up to 40% a year · paid daily</span>
      </div>

      <div className="sect"><span className="h">Fixed deposits</span><button className="m" onClick={() => setScreen('lock')}>New</button></div>
      <div className="rows">
        {activeLocks.map((l) => {
          const days = Math.max(0, Math.ceil((new Date(l.unlocks_at).getTime() - Date.now()) / 86400000))
          const matured = days === 0
          return (
            <button key={l.id} className="opt" onClick={() => doWithdrawLock(l)} disabled={busy}>
              <span className="ic"><IconLock /></span>
              <div className="mid">
                <div className="nm">{formatNaira(l.amount_kobo)} locked</div>
                <div className="sub">{l.apy_percent}% · {matured ? 'matured — tap to withdraw' : `matures in ${days} days`}</div>
              </div>
              <span className="chev"><Chevron /></span>
            </button>
          )
        })}
        <button className="opt" onClick={() => setScreen('lock')}>
          <span className="ic"><IconPlus /></span>
          <div className="mid"><div className="nm">Start a fixed deposit</div><div className="sub">Lock 30–365 days · up to 40%</div></div>
          <span className="chev"><Chevron /></span>
        </button>
      </div>

      <div className="sect"><span className="h">Goals</span><button className="m" onClick={() => setScreen('goal-new')}>Add</button></div>
      {activeGoals.length === 0 ? (
        <div className="rows">
          <button className="opt" onClick={() => setScreen('goal-new')}>
            <span className="ic"><IconPlus /></span>
            <div className="mid"><div className="nm">Create your first goal</div><div className="sub">Save toward a target, earn as you go</div></div>
            <span className="chev"><Chevron /></span>
          </button>
        </div>
      ) : (
        <div className="rows">
          {activeGoals.map((g) => {
            const pct = Math.min(100, Math.round((g.saved_usdc_micro / g.target_usdc_micro) * 100))
            return (
              <div key={g.id} className="goal" onClick={() => setScreen({ goal: g })} style={{ cursor: 'pointer' }}>
                <div className="t"><span>{g.title}</span><span className="g num">{formatNaira(g.saved_naira_kobo)} / {formatNaira(g.target_naira_kobo)}</span></div>
                <div className="bar"><i style={{ width: `${pct}%` }} /></div>
              </div>
            )
          })}
        </div>
      )}

      {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}
      {spendableKobo > 0 && <p className="p" style={{ margin: '14px 3px 0' }}>Spendable balance: {formatNaira(spendableKobo)}</p>}
    </div>
  )
}