'use client'

import { useState } from 'react'
import { Target, Plus, ArrowLeft, CheckCircle2, TrendingUp, Loader2, ChevronRight, XCircle } from 'lucide-react'
import { formatNaira, formatUsdc, koboToMicroUsdc, microUsdcToKobo, getRate } from '@/lib/format'
import { useSavingsGoals, createSavingsGoal, contributeToGoal, completeSavingsGoal, breakSavingsGoal } from '@/hooks/use-data'
import type { Wallet, SavingsGoal } from '@/lib/types'

interface Props {
  wallet: Wallet | null
  refresh: () => void
}

const FREQ_LABELS: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

type View = 'list' | 'create' | 'detail'

export default function GoalsView({ wallet, refresh }: Props) {
  const { goals, loading, refresh: refreshGoals } = useSavingsGoals()
  const [view, setView] = useState<View>('list')
  const [selected, setSelected] = useState<SavingsGoal | null>(null)

  // Create form
  const [title, setTitle] = useState('')
  const [targetAmount, setTargetAmount] = useState('')
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('monthly')
  const [contributionAmount, setContributionAmount] = useState('')

  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')

  const rate = getRate()

  const flash = (msg: string, dur = 4000) => {
    setFeedback(msg)
    setTimeout(() => setFeedback(''), dur)
  }

  const progressPct = (g: SavingsGoal) =>
    Math.min(100, Math.round((g.saved_usdc_micro / g.target_usdc_micro) * 100))

  const periodsLeft = (g: SavingsGoal) => {
    const remaining = Math.max(0, g.target_usdc_micro - g.saved_usdc_micro)
    if (!g.contribution_usdc_micro) return '—'
    return Math.ceil(remaining / g.contribution_usdc_micro)
  }

  const handleCreate = async () => {
    const targetNaira = parseFloat(targetAmount)
    const contribNaira = parseFloat(contributionAmount)
    if (!title.trim())                              { flash('Enter a goal title'); return }
    if (!targetNaira || targetNaira < 1000)         { flash('Minimum target ₦1,000'); return }
    if (!contribNaira || contribNaira < 100)        { flash('Minimum contribution ₦100'); return }
    if (contribNaira > targetNaira)                 { flash('Contribution cannot exceed target'); return }

    const targetKobo = Math.round(targetNaira * 100)
    const targetUsdc = koboToMicroUsdc(targetKobo, rate)
    const contribKobo = Math.round(contribNaira * 100)
    const contribUsdc = koboToMicroUsdc(contribKobo, rate)

    setBusy(true)
    try {
      await createSavingsGoal({ title: title.trim(), targetKobo, targetUsdc, frequency, contribKobo, contribUsdc })
      setTitle(''); setTargetAmount(''); setContributionAmount('')
      await refreshGoals()
      setView('list')
    } catch (e: any) {
      flash(e.message || 'Failed to create goal')
    } finally {
      setBusy(false)
    }
  }

  const handleContribute = async (goal: SavingsGoal) => {
    setBusy(true)
    try {
      const ok = await contributeToGoal(goal.id, goal.contribution_naira_kobo, goal.contribution_usdc_micro)
      if (!ok) { flash('Insufficient wallet balance'); return }
      flash(`Saved ${formatNaira(goal.contribution_naira_kobo)} toward "${goal.title}"`)
      await refreshGoals()
      refresh()
      // Optimistically update selected so progress bar animates
      setSelected(prev => prev ? {
        ...prev,
        saved_naira_kobo: prev.saved_naira_kobo + goal.contribution_naira_kobo,
        saved_usdc_micro: prev.saved_usdc_micro + goal.contribution_usdc_micro,
      } : null)
    } catch (e: any) {
      flash(e.message || 'Contribution failed')
    } finally {
      setBusy(false)
    }
  }

  const handleComplete = async (goal: SavingsGoal) => {
    setBusy(true)
    try {
      const interest = await completeSavingsGoal(goal.id)
      flash(`Goal completed! You earned ${formatUsdc(interest)} in interest. 🎉`)
      await refreshGoals()
      refresh()
      setView('list')
      setSelected(null)
    } catch (e: any) {
      flash(e.message || 'Could not complete goal')
    } finally {
      setBusy(false)
    }
  }

  const handleBreak = async (goal: SavingsGoal) => {
    if (!confirm('Break this goal early? You will only get your principal back — no interest earned.')) return
    setBusy(true)
    try {
      await breakSavingsGoal(goal.id)
      flash('Goal broken. Principal returned to your wallet.')
      await refreshGoals()
      refresh()
      setView('list')
      setSelected(null)
    } catch (e: any) {
      flash(e.message || 'Could not break goal')
    } finally {
      setBusy(false)
    }
  }

  // ── CREATE FORM ────────────────────────────────────────────────────────────
  if (view === 'create') {
    const targetNaira = parseFloat(targetAmount) || 0
    const contribNaira = parseFloat(contributionAmount) || 0
    const periodsToGoal = contribNaira > 0 ? Math.ceil(targetNaira / contribNaira) : null

    return (
      <div className="px-4 pt-5 pb-8">
        <button onClick={() => setView('list')} className="flex items-center gap-1.5 text-slate-500 text-sm mb-5">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-xl font-bold text-slate-900 mb-1">New Savings Goal</h2>
        <p className="text-sm text-slate-500 mb-6">
          Your money is locked until you hit the target — earning 50% APY the whole way.
        </p>

        <div className="space-y-5">
          {/* Title */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">What are you saving for?</p>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. New iPhone, School fees, Emergency fund"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              maxLength={100}
            />
          </div>

          {/* Target amount */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Target amount</p>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium">₦</span>
              <input
                type="number"
                inputMode="numeric"
                value={targetAmount}
                onChange={e => setTargetAmount(e.target.value)}
                placeholder="0"
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div className="flex gap-2 mt-2">
              {[50000, 100000, 250000, 500000].map(v => (
                <button
                  key={v}
                  onClick={() => setTargetAmount((v).toString())}
                  className="flex-1 text-xs py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition"
                >
                  {v >= 1000 ? `${v / 1000}k` : v}
                </button>
              ))}
            </div>
          </div>

          {/* Frequency */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Contribution frequency</p>
            <div className="flex gap-2">
              {(['daily', 'weekly', 'monthly'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFrequency(f)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition ${
                    frequency === f ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {FREQ_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          {/* Contribution amount */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">
              Amount per {frequency === 'daily' ? 'day' : frequency === 'weekly' ? 'week' : 'month'}
            </p>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium">₦</span>
              <input
                type="number"
                inputMode="numeric"
                value={contributionAmount}
                onChange={e => setContributionAmount(e.target.value)}
                placeholder="0"
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            {periodsToGoal !== null && periodsToGoal > 0 && (
              <p className="text-xs text-slate-400 mt-2">
                ≈ {periodsToGoal} {frequency === 'daily' ? 'days' : frequency === 'weekly' ? 'weeks' : 'months'} to reach your goal
              </p>
            )}
          </div>

          {/* Info */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5">
            <p className="text-xs font-bold text-emerald-800 mb-1.5">How it works</p>
            <ul className="text-xs text-emerald-700 space-y-1">
              <li>• Each contribution is locked until you reach your target</li>
              <li>• Locked savings earn 50% APY automatically</li>
              <li>• Break early to get your principal back (no interest)</li>
            </ul>
          </div>

          {feedback && (
            <p className="text-sm text-center text-rose-500">{feedback}</p>
          )}

          <button
            onClick={handleCreate}
            disabled={busy}
            className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold rounded-xl transition flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Target className="w-4 h-4" />}
            Create Goal
          </button>
        </div>
      </div>
    )
  }

  // ── GOAL DETAIL ────────────────────────────────────────────────────────────
  if (view === 'detail' && selected) {
    const pct = progressPct(selected)
    const isTargetMet = selected.saved_usdc_micro >= selected.target_usdc_micro
    const daysElapsed = Math.max(1, (Date.now() - new Date(selected.started_at).getTime()) / 86400000)
    const projectedInterest = Math.floor(selected.saved_usdc_micro * 0.50 * (daysElapsed / 365))

    return (
      <div className="px-4 pt-5 pb-8">
        <button onClick={() => { setView('list'); setSelected(null) }} className="flex items-center gap-1.5 text-slate-500 text-sm mb-5">
          <ArrowLeft className="w-4 h-4" /> All Goals
        </button>

        {/* Goal header card */}
        <div className="bg-gradient-to-br from-emerald-600 via-teal-700 to-slate-800 rounded-2xl p-5 text-white mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-emerald-200" />
              <p className="text-emerald-100 text-xs font-medium uppercase tracking-wider">Savings Goal</p>
            </div>
            <span className="text-xs font-semibold bg-white/20 px-2 py-0.5 rounded-full flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> 50% APY
            </span>
          </div>

          <p className="text-xl font-bold mb-1">{selected.title}</p>
          <p className="text-3xl font-bold tracking-tight">{formatNaira(selected.saved_naira_kobo)}</p>
          <p className="text-emerald-200 text-sm mt-0.5">of {formatNaira(selected.target_naira_kobo)} target</p>

          {/* Progress bar */}
          <div className="mt-4">
            <div className="flex justify-between text-xs text-emerald-200 mb-1.5">
              <span>{pct}% saved</span>
              {selected.status === 'active' && !isTargetMet && (
                <span>{periodsLeft(selected)} {selected.frequency === 'daily' ? 'days' : selected.frequency === 'weekly' ? 'weeks' : 'months'} left</span>
              )}
              {isTargetMet && <span className="font-bold text-white">Target reached!</span>}
            </div>
            <div className="h-2.5 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-4 mt-4 pt-3 border-t border-white/10 text-xs">
            <div>
              <p className="text-emerald-200">Saved (USDC)</p>
              <p className="font-semibold mt-0.5">{formatUsdc(selected.saved_usdc_micro)}</p>
            </div>
            <div>
              <p className="text-emerald-200">Interest accrued</p>
              <p className="font-bold mt-0.5 text-emerald-300">~{formatUsdc(projectedInterest)}</p>
            </div>
            <div>
              <p className="text-emerald-200">Frequency</p>
              <p className="font-semibold mt-0.5">{FREQ_LABELS[selected.frequency]}</p>
            </div>
          </div>
        </div>

        {feedback && (
          <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-sm text-emerald-800">{feedback}</div>
        )}

        {selected.status === 'active' && (
          <div className="space-y-3">
            {!isTargetMet ? (
              <button
                onClick={() => handleContribute(selected)}
                disabled={busy}
                className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold rounded-xl transition flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Save {formatNaira(selected.contribution_naira_kobo)} ({FREQ_LABELS[selected.frequency]})
              </button>
            ) : (
              <button
                onClick={() => handleComplete(selected)}
                disabled={busy}
                className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold rounded-xl transition flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Claim Goal + Interest 🎉
              </button>
            )}

            <button
              onClick={() => handleBreak(selected)}
              disabled={busy}
              className="w-full py-3 border border-rose-200 text-rose-500 hover:bg-rose-50 rounded-xl text-sm font-medium transition"
            >
              Break goal early (no interest)
            </button>
          </div>
        )}

        {selected.status === 'completed' && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto mb-2" />
            <p className="font-bold text-emerald-900 text-lg">Goal achieved!</p>
            <p className="text-sm text-emerald-700 mt-1">
              You earned {formatUsdc(selected.interest_earned_micro)} in interest
            </p>
          </div>
        )}

        {selected.status === 'broken' && (
          <div className="bg-slate-100 border border-slate-200 rounded-2xl p-5 text-center">
            <XCircle className="w-10 h-10 text-slate-400 mx-auto mb-2" />
            <p className="font-bold text-slate-700 text-lg">Goal broken</p>
            <p className="text-sm text-slate-500 mt-1">Principal was returned to your wallet</p>
          </div>
        )}
      </div>
    )
  }

  // ── LIST ───────────────────────────────────────────────────────────────────
  const activeGoals = goals.filter(g => g.status === 'active')
  const doneGoals = goals.filter(g => g.status !== 'active')

  return (
    <div className="px-4 pt-5 pb-8">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Savings Goals</h2>
          <p className="text-xs text-slate-500 mt-0.5">Lock money, earn 50% APY, unlock at target</p>
        </div>
        <button
          onClick={() => setView('create')}
          className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition"
        >
          <Plus className="w-4 h-4" /> New
        </button>
      </div>

      {feedback && (
        <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-sm text-emerald-800">{feedback}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : activeGoals.length === 0 && doneGoals.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Target className="w-8 h-8 text-emerald-600" />
          </div>
          <p className="font-bold text-slate-800 text-lg mb-1">No goals yet</p>
          <p className="text-sm text-slate-500 mb-6 max-w-xs mx-auto">
            Set a target, contribute regularly, and watch your savings grow with 50% APY interest.
          </p>
          <button
            onClick={() => setView('create')}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-6 py-3 rounded-xl transition"
          >
            Create first goal
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {activeGoals.map(goal => {
            const pct = progressPct(goal)
            const isTargetMet = goal.saved_usdc_micro >= goal.target_usdc_micro
            return (
              <button
                key={goal.id}
                onClick={() => { setSelected(goal); setView('detail') }}
                className="w-full text-left bg-white border border-slate-200 hover:border-emerald-400 rounded-2xl p-4 transition group"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-slate-900 truncate">{goal.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {FREQ_LABELS[goal.frequency]} · {formatNaira(goal.contribution_naira_kobo)} / period
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    {isTargetMet && (
                      <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                        Ready!
                      </span>
                    )}
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-500 transition" />
                  </div>
                </div>

                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isTargetMet ? 'bg-emerald-500' : 'bg-emerald-400'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="flex justify-between text-xs text-slate-500">
                  <span>{formatNaira(goal.saved_naira_kobo)} saved</span>
                  <span>{pct}% of {formatNaira(goal.target_naira_kobo)}</span>
                </div>
              </button>
            )
          })}

          {doneGoals.length > 0 && (
            <>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider pt-2 pb-1">
                Completed / Broken
              </p>
              {doneGoals.map(goal => (
                <button
                  key={goal.id}
                  onClick={() => { setSelected(goal); setView('detail') }}
                  className="w-full text-left bg-slate-50 border border-slate-100 rounded-2xl p-4 transition opacity-70 hover:opacity-100"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-slate-700">{goal.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {goal.status === 'completed'
                          ? `Completed · Earned ${formatUsdc(goal.interest_earned_micro)} interest`
                          : 'Broken early · Principal returned'}
                      </p>
                    </div>
                    {goal.status === 'completed'
                      ? <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                      : <XCircle className="w-5 h-5 text-slate-400 flex-shrink-0" />}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
