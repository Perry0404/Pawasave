'use client'

import { useEffect, useState } from 'react'
import { Lock, Plus, CaretRight } from '@phosphor-icons/react'
import { formatNaira, formatCngn, koboToMicroUsdc, microUsdcToKobo } from '@/lib/format'
import {
  useSavingsLocks, lockSavings, withdrawLock,
  useSavingsGoals, createSavingsGoal, contributeToGoal, completeSavingsGoal, breakSavingsGoal,
  getApySettings, type ApySettings, setGoalAutoContribute,
  getFixedOffer, openFixedSavings, type FixedOffer,
} from '@/hooks/use-data'
import type { Wallet, SavingsLock, SavingsGoal } from '@/lib/types'
import { useConfirm } from '@/components/confirm-dialog'

interface Props {
  wallet: Wallet | null
  refresh: () => void
}

// Display only: the rate is set server-side (platform_settings.fixed_user_apy_percent) and
// lock_savings ignores any APY the client sends. Fixed deposits open only when
// fixed_savings_enabled is on (gated until GetEquity's CP fund is live).
const LOCK_DURATIONS = [
  { days: 30, label: '30 days', apy: 20 },
  { days: 90, label: '90 days', apy: 20 },
  { days: 180, label: '6 months', apy: 20 },
  { days: 365, label: '1 year', apy: 20 },
]
const FREQ = ['daily', 'weekly', 'monthly'] as const
const FREQ_LABELS: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

const fmtDate = (d: string | number | Date) =>
  new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })

const IconLock = () => <Lock />
const IconPlus = () => <Plus />
const Chevron = () => <CaretRight />

type Screen = 'main' | 'lock' | 'goal-new' | { goal: SavingsGoal }

export default function SaveView({ wallet, refresh }: Props) {
  const { locks, refresh: refreshLocks } = useSavingsLocks()
  const { goals, refresh: refreshGoals } = useSavingsGoals()
  const confirm = useConfirm()
  const [screen, setScreen] = useState<Screen>('main')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [apy, setApy] = useState<ApySettings | null>(null)
  const [offer, setOffer] = useState<FixedOffer | null>(null)
  useEffect(() => {
    getApySettings().then(setApy)
    getFixedOffer().then((o) => {
      setOffer(o)
      // Start on an offered term (the default 90 may not be one).
      if (o?.enabled && o.terms.length && !o.terms.some((t) => t.days === 90)) setLockDays(o.terms[0].days)
    })
  }, [])
  // Fixed Savings v2 replaces v1 once switched on: no early exit, paid out automatically.
  const V2 = !!offer?.enabled
  const FIXED_LIVE = V2 ? !!offer?.open : !!apy?.fixedEnabled
  const fixedRate = V2 ? offer!.ratePercent : (apy?.fixed ?? 20)

  // lock form
  const [lockAmt, setLockAmt] = useState('')
  const [lockDays, setLockDays] = useState(90)
  const [lockAgree, setLockAgree] = useState(false)
  const [lockPin, setLockPin] = useState('')

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

  const submitFixedV2 = async () => {
    const naira = parseFloat(lockAmt)
    const minNaira = (offer?.minAmountMicro ?? 1e9) / 1e6
    if (!naira || naira < minNaira) { flash(`Minimum ${formatNaira(Math.round(minNaira * 100))}`); return }
    if (!lockAgree) { flash('Please confirm you understand you cannot withdraw before the payout date'); return }
    if (!/^\d{4}$/.test(lockPin)) { flash('Enter your 4-digit transaction PIN'); return }
    setBusy(true)
    try {
      const l = await openFixedSavings({ amountMicro: Math.round(naira * 1e6), durationDays: lockDays, consent: true, pin: lockPin })
      flash(`Saved ${formatNaira(Math.round(naira * 100))}. ${formatCngn(l.amount_usdc_micro + l.projected_interest_micro)} pays out on ${fmtDate(l.unlocks_at)}`)
      setLockAmt(''); setLockAgree(false); setLockPin('')
      refreshLocks(); refresh()
      setScreen('main')
    } catch (e: any) { flash(e.message || 'Could not open fixed savings') } finally { setBusy(false) }
  }

  const doWithdrawLock = async (lock: SavingsLock) => {
    if (lock.breakable === false) {
      flash(`Locked until ${fmtDate(lock.unlocks_at)}. It pays out to your balance automatically on that day.`)
      return
    }
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

  // ══ FIXED SAVINGS v2 FORM ══
  if (screen === 'lock' && V2 && offer) {
    const naira = parseFloat(lockAmt) || 0
    const principal = Math.round(naira * 1e6)
    const days = lockDays
    const payoutDate = offer.terms.find((t) => t.days === days)?.payoutDate
    const interest = Math.floor(principal * (offer.ratePercent / 100) * (days / 365))
    const minNaira = offer.minAmountMicro / 1e6
    const label = (d: number) => d % 365 === 0 ? `${d / 365} year${d > 365 ? 's' : ''}` : d % 30 === 0 ? `${d / 30} months` : `${d} days`
    return (
      <div className="b">
        <button className="back" onClick={() => setScreen('main')}>← Back</button>
        <div className="h2">Start a fixed savings</div>
        <p className="p">Earn {offer.ratePercent}% a year. Your money stays locked until the payout date, then lands in your balance automatically.</p>

        <label className="lab">Amount (₦)</label>
        <input className="field" type="number" inputMode="numeric" value={lockAmt} onChange={(e) => setLockAmt(e.target.value)} placeholder={`From ${formatNaira(Math.round(minNaira * 100))}`} autoFocus />
        <p className="p" style={{ margin: '6px 3px 0' }}>Available in savings: {formatNaira(poolKobo)}</p>

        <label className="lab" style={{ marginTop: 16 }}>Term</label>
        <div className="terms" style={{ gridTemplateColumns: `repeat(${Math.min(3, offer.terms.length || 1)},1fr)` }}>
          {offer.terms.map((t) => (
            <button key={t.days} className={`term${days === t.days ? ' on' : ''}`} onClick={() => setLockDays(t.days)}>{label(t.days)}</button>
          ))}
        </div>

        {naira >= minNaira && payoutDate && (
          <div className="info" style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="l">You get</span>
              <span className="code">{formatCngn(principal + interest)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span className="l">Interest ({offer.ratePercent}% a year)</span>
              <span className="code" style={{ color: 'var(--green)' }}>+{formatCngn(interest)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span className="l">Paid to your balance on</span>
              <span className="code">{fmtDate(payoutDate)}</span>
            </div>
          </div>
        )}
        <p className="p" style={{ margin: '10px 3px 0', fontSize: 12 }}>Backed by {offer.backingName}.</p>

        <label style={{ display: 'flex', gap: 9, marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
          <input type="checkbox" checked={lockAgree} onChange={(e) => setLockAgree(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand I <b>cannot withdraw this money before {payoutDate ? fmtDate(payoutDate) : 'the payout date'}</b>, for any reason. On that day it is paid to my PawaSave balance automatically.</span>
        </label>

        <label className="lab" style={{ marginTop: 14 }}>Transaction PIN</label>
        <input className="field" type="password" inputMode="numeric" maxLength={4} value={lockPin} onChange={(e) => setLockPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />

        {msg && <div className={`flash ${isErr(msg) ? 'err' : 'ok'}`}>{msg}</div>}
        <button className="cta" onClick={submitFixedV2} disabled={busy || !lockAmt || !lockAgree || lockPin.length !== 4}>
          Save {lockAmt ? formatNaira(Math.round(naira * 100)) : ''}
        </button>
      </div>
    )
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
          {(g.interest_earned_micro > 0 || apy?.backed) && (
            <span className="apy" style={{ display: 'block', marginTop: 4 }}>
              {apy?.backed ? `Earning ${apy.goals}% a year` : 'Interest paused'}{g.interest_earned_micro > 0 ? ` · +${formatCngn(g.interest_earned_micro)} earned so far` : ''}
            </span>
          )}
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
            {!met && (
              <label className="info" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={g.auto_contribute_enabled} disabled={busy}
                  onChange={async (e) => {
                    const on = e.target.checked
                    setBusy(true)
                    try { await setGoalAutoContribute(g.id, on); refreshGoals(); flash(on ? 'Auto-save is on' : 'Auto-save paused') }
                    catch { flash('Could not change auto-save') } finally { setBusy(false) }
                  }} />
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>
                  <b>Auto-save</b> {formatNaira(g.contribution_naira_kobo)} {FREQ_LABELS[g.frequency]?.toLowerCase()} from my balance
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>{g.auto_contribute_enabled ? 'Skipped automatically if your balance is short' : 'Paused, save manually above'}</span>
                </span>
              </label>
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
        <span className="apy">{apy?.backed ? `Goals earn ${apy.goals}% · Ajo earns ${apy.ajo}% a year` : 'Save toward goals with your circle'}</span>
      </div>

      <div className="sect"><span className="h">Fixed deposits</span>{FIXED_LIVE && <button className="m" onClick={() => setScreen('lock')}>New</button>}</div>
      <div className="rows">
        {activeLocks.map((l) => {
          const days = Math.max(0, Math.ceil((new Date(l.unlocks_at).getTime() - Date.now()) / 86400000))
          const matured = days === 0
          const auto = l.breakable === false
          const sub = auto
            ? `${l.apy_percent}% · ${formatCngn(l.amount_usdc_micro + l.projected_interest_micro)} pays out ${matured ? 'within the hour' : `on ${fmtDate(l.unlocks_at)}`}`
            : `${l.apy_percent}% · ${matured ? 'matured — tap to withdraw' : `matures in ${days} days`}`
          return (
            <button key={l.id} className="opt" onClick={() => doWithdrawLock(l)} disabled={busy}>
              <span className="ic"><IconLock /></span>
              <div className="mid">
                <div className="nm">{formatNaira(l.amount_kobo)} locked</div>
                <div className="sub">{sub}</div>
              </div>
              {!auto && <span className="chev"><Chevron /></span>}
            </button>
          )
        })}
        <button className="opt" onClick={() => FIXED_LIVE && setScreen('lock')} disabled={!FIXED_LIVE}>
          <span className="ic"><IconPlus /></span>
          <div className="mid"><div className="nm">Start a fixed deposit</div><div className="sub">{FIXED_LIVE ? `Lock in for ${fixedRate}% a year${V2 ? ', paid out automatically' : ''}` : `Coming soon · ${fixedRate}% a year`}</div></div>
          {FIXED_LIVE && <span className="chev"><Chevron /></span>}
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