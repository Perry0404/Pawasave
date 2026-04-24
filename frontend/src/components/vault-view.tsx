'use client'

import { useState, useEffect } from 'react'
import { formatNaira, formatUsdc, koboToMicroUsdc, microUsdcToKobo, getRate } from '@/lib/format'
import { saveToVault, withdrawFromVault, lockSavings, withdrawLock, useSavingsLocks } from '@/hooks/use-data'
import { Shield, ArrowDown, ArrowUp, Info, Loader2, Lock, Unlock, TrendingUp, AlertTriangle, Zap, ChevronRight } from 'lucide-react'
import type { Wallet, SavingsLock } from '@/lib/types'

interface Props {
  wallet: Wallet | null
  refresh: () => void
}

const LOCK_DURATIONS = [
  { days: 30, label: '30 Days' },
  { days: 90, label: '90 Days' },
  { days: 180, label: '6 Months' },
  { days: 365, label: '1 Year' },
]

// Which top-level plan the user picked: null = chooser screen
type SavingsPlan = null | 'flexible' | 'fixed'
// Within a plan, which action is active
type FlexAction = 'save' | 'withdraw'
const CNGN_APY = 21

export default function VaultView({ wallet, refresh }: Props) {
  const [plan, setPlan] = useState<SavingsPlan>(null)
  const [flexAction, setFlexAction] = useState<FlexAction>('save')
  const [amount, setAmount] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [lockDuration, setLockDuration] = useState(90)
  const [liveRate, setLiveRate] = useState<number>(getRate())
  const { locks, loading: locksLoading, refresh: refreshLocks } = useSavingsLocks()

  useEffect(() => {
    fetch('/api/ramp/rate')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.rate && Number.isFinite(Number(data.rate))) {
          setLiveRate(Number(data.rate))
        }
      })
      .catch(() => undefined)
  }, [])

  if (!wallet) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  const rate = liveRate
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)
  const cngnPoolKobo = microUsdcToKobo(wallet.cngn_pool_micro || 0, rate)
  const activeLocks = locks.filter(l => l.status === 'active')
  const totalLockedMicro = activeLocks.reduce((s, l) => s + l.amount_usdc_micro, 0)
  const lockedKobo = microUsdcToKobo(totalLockedMicro, rate)

  const lockAmount = parseFloat(amount) || 0
  const lockKobo = Math.round(lockAmount * 100)
  const lockUsdc = koboToMicroUsdc(lockKobo, rate)
  const projectedInterest = Math.floor(lockUsdc * (CNGN_APY / 100) * (lockDuration / 365))

  const flash = (msg: string) => {
    setFeedback(msg)
    setTimeout(() => setFeedback(''), 3500)
  }

  const executeFlexible = async () => {
    const naira = parseFloat(amount)
    if (!naira || naira < 100) { flash('Minimum ₦100'); return }
    const kobo = Math.round(naira * 100)
    const usdc = koboToMicroUsdc(kobo, rate)
    setBusy(true)
    try {
      if (flexAction === 'save') {
        await saveToVault(kobo, usdc)
        flash(`Saved ${formatUsdc(usdc)} to flexible vault`)
      } else {
        await withdrawFromVault(kobo, usdc)
        flash(`Withdrew ${formatNaira(kobo)} from vault`)
      }
      setAmount('')
      refresh()
    } catch (e: any) {
      flash(e.message || 'Operation failed')
    } finally {
      setBusy(false)
    }
  }

  const executeFixed = async () => {
    const naira = parseFloat(amount)
    if (!naira || naira < 100) { flash('Minimum ₦100'); return }
    const kobo = Math.round(naira * 100)
    const usdc = koboToMicroUsdc(kobo, rate)
    setBusy(true)
    try {
      await lockSavings(usdc, kobo, lockDuration, CNGN_APY)
      flash(`Locked ${formatUsdc(usdc)} in cNGN for ${lockDuration} days at ${CNGN_APY}% APY`)
      refreshLocks()
      setAmount('')
      refresh()
    } catch (e: any) {
      flash(e.message || 'Operation failed')
    } finally {
      setBusy(false)
    }
  }

  const handleWithdrawLock = async (lock: SavingsLock) => {
    const isMatured = new Date(lock.unlocks_at) <= new Date()
    const early = !isMatured
    if (early && !confirm('Early withdrawal forfeits interest and incurs a 0.5% penalty. Continue?')) return
    setBusy(true)
    try {
      await withdrawLock(lock.id, early)
      flash(early ? 'Lock withdrawn early (no interest)' : 'Lock matured — withdrawn with interest!')
      refreshLocks()
      refresh()
    } catch (e: any) {
      flash(e.message || 'Failed to withdraw')
    } finally {
      setBusy(false)
    }
  }

  // ─── Vault header card (always shown) ────────────────────────────────────
  const VaultCard = () => (
    <div className="bg-gradient-to-br from-amber-500 via-orange-600 to-rose-700 rounded-2xl p-5 text-white mb-5">
      <div className="flex items-center gap-2 mb-3">
        <Shield className="w-4 h-4 text-amber-100" />
        <p className="text-amber-100 text-xs font-medium uppercase tracking-wider">cNGN Yield Vault</p>
      </div>
      <p className="text-3xl font-bold tracking-tight">{formatNaira(cngnPoolKobo)}</p>
      <p className="text-amber-100 text-sm mt-1">{(wallet.cngn_pool_micro / 1_000_000).toFixed(2)} cNGN</p>
      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-white/10 text-xs">
        <div>
          <p className="text-amber-100">Yield Earned</p>
          <p className="font-semibold mt-0.5">{formatUsdc(wallet.cngn_yield_earned_micro || 0)}</p>
        </div>
        <div>
          <p className="text-amber-100">USDC Free</p>
          <p className="font-semibold mt-0.5">{formatUsdc(wallet.usdc_balance_micro)}</p>
        </div>
        <div>
          <p className="text-amber-100">cNGN Locked</p>
          <p className="font-semibold mt-0.5">{formatNaira(lockedKobo)}</p>
        </div>
      </div>
    </div>
  )

  // ─── Amount input shared by both plan forms ───────────────────────────────
  const AmountInput = ({ label, sub }: { label: string; sub: string }) => (
    <div className="mb-3">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-xs text-slate-400 mb-2">{sub}</p>
      <div className="relative">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg font-medium">₦</span>
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          className="w-full pl-10 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
          autoFocus
        />
      </div>
      {amount && parseFloat(amount) > 0 && (
        <p className="text-xs text-slate-400 mt-2">
          ≈ {formatUsdc(koboToMicroUsdc(Math.round(parseFloat(amount) * 100), rate))} USDC
        </p>
      )}
    </div>
  )

  const QuickAmounts = () => (
    <div className="flex gap-2 mb-4">
      {[10000, 50000, 100000, 500000].map((v) => (
        <button
          key={v}
          onClick={() => setAmount(v.toString())}
          className="flex-1 text-xs py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition font-medium"
        >
          {v >= 1000 ? `${v / 1000}k` : v}
        </button>
      ))}
    </div>
  )

  // ─── Chooser screen ───────────────────────────────────────────────────────
  if (plan === null) {
    return (
      <div className="px-4 pt-5 pb-6">
        <VaultCard />

        <h2 className="text-base font-bold text-slate-900 mb-1">Choose your savings type</h2>
        <p className="text-xs text-slate-500 mb-4">
          Pick how you want to save. You can always switch later.
        </p>

        {/* Flexible */}
        <button
          onClick={() => { setPlan('flexible'); setFlexAction('save'); setAmount('') }}
          className="w-full text-left bg-white border border-slate-200 hover:border-emerald-400 rounded-2xl p-5 mb-3 transition group"
        >
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0">
              <Zap className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="font-bold text-slate-900">Flexible Savings</p>
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-500 transition" />
              </div>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Save into the cNGN yield pool and withdraw anytime. Earns 21% APY automatically — no lock-in.
              </p>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">21% APY</span>
                <span className="text-xs text-slate-400">Withdraw anytime</span>
              </div>
            </div>
          </div>
        </button>

        {/* Fixed */}
        <button
          onClick={() => { setPlan('fixed'); setAmount('') }}
          className="w-full text-left bg-white border border-slate-200 hover:border-purple-400 rounded-2xl p-5 mb-5 transition group"
        >
          <div className="flex items-start gap-4">
            <div className="w-11 h-11 rounded-xl bg-purple-100 flex items-center justify-center flex-shrink-0">
              <Lock className="w-5 h-5 text-purple-600" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="font-bold text-slate-900">Fixed Savings</p>
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-purple-500 transition" />
              </div>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Time-lock your cNGN pool balance for 30–365 days. Same cNGN engine, but locked until maturity for disciplined savings.
              </p>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-xs font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">{CNGN_APY}% APY</span>
                <span className="text-xs text-slate-400">30 – 365 day lock</span>
              </div>
            </div>
          </div>
        </button>

        {/* Active locks summary if any */}
        {activeLocks.length > 0 && (
          <div
            className="flex items-center gap-3 bg-purple-50 border border-purple-100 rounded-xl px-4 py-3 cursor-pointer"
            onClick={() => setPlan('fixed')}
          >
            <Lock className="w-4 h-4 text-purple-500 flex-shrink-0" />
            <p className="text-xs text-purple-800 font-medium flex-1">
              You have {activeLocks.length} active lock{activeLocks.length > 1 ? 's' : ''} — tap to manage
            </p>
            <ChevronRight className="w-4 h-4 text-purple-400" />
          </div>
        )}
      </div>
    )
  }

  // ─── Flexible savings screen ──────────────────────────────────────────────
  if (plan === 'flexible') {
    return (
      <div className="px-4 pt-5 pb-6">
        <button
          onClick={() => { setPlan(null); setAmount(''); setFeedback('') }}
          className="flex items-center gap-1 text-sm text-slate-500 mb-4"
        >
          ← Back
        </button>

        <VaultCard />

        {/* Save / Withdraw toggle */}
        <div className="flex bg-slate-100 rounded-xl p-1 mb-4">
          <button
            onClick={() => { setFlexAction('save'); setAmount(''); setFeedback('') }}
            className={`flex-1 py-2.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all ${
              flexAction === 'save' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            <ArrowDown className="w-3.5 h-3.5" /> Save
          </button>
          <button
            onClick={() => { setFlexAction('withdraw'); setAmount(''); setFeedback('') }}
            className={`flex-1 py-2.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all ${
              flexAction === 'withdraw' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'
            }`}
          >
            <ArrowUp className="w-3.5 h-3.5" /> Withdraw
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          {/* 21% APY badge */}
          <div className="flex items-center gap-2 mb-4 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
            <p className="text-xs text-emerald-700 font-medium">21% APY · cNGN Yield Pool via Xend Asset Chain</p>
          </div>

          <AmountInput
            label={flexAction === 'save' ? 'Amount to save (₦)' : 'Amount to withdraw (₦)'}
            sub={
              flexAction === 'save'
                ? `Available naira: ${formatNaira(wallet.naira_balance_kobo)}`
                : `In cNGN vault: ${formatNaira(cngnPoolKobo + savingsKobo)} total`
            }
          />
          <QuickAmounts />

          <button
            onClick={executeFlexible}
            disabled={busy || !amount}
            className={`w-full py-3.5 text-white font-semibold rounded-xl transition active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2 ${
              flexAction === 'save' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-orange-500 hover:bg-orange-600'
            }`}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {flexAction === 'save' ? 'Save to Vault' : 'Withdraw to Naira'}
          </button>
        </div>

        {feedback && (
          <div className={`mt-3 px-4 py-2.5 rounded-xl text-sm font-medium ${
            feedback.toLowerCase().includes('insufficient') || feedback.toLowerCase().includes('minimum') || feedback.toLowerCase().includes('failed')
              ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {feedback}
          </div>
        )}

        <div className="flex items-start gap-2.5 mt-4 bg-slate-100 rounded-xl px-4 py-3">
          <Info className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-slate-500 leading-relaxed">
            90% of saved funds auto-allocate to the cNGN yield pool. Withdraw the full balance at any time — no penalties.
          </p>
        </div>
      </div>
    )
  }

  // ─── Fixed savings screen ─────────────────────────────────────────────────
  return (
    <div className="px-4 pt-5 pb-6">
      <button
        onClick={() => { setPlan(null); setAmount(''); setFeedback('') }}
        className="flex items-center gap-1 text-sm text-slate-500 mb-4"
      >
        ← Back
      </button>

      <VaultCard />

      {/* Lock form */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
        <div className="flex items-center gap-2 mb-4 bg-purple-50 border border-purple-200 rounded-xl px-3 py-2">
          <TrendingUp className="w-3.5 h-3.5 text-purple-600 flex-shrink-0" />
          <p className="text-xs text-purple-700 font-medium">{CNGN_APY}% APY · Locked cNGN balance</p>
        </div>

        <AmountInput
          label="Amount to lock (₦)"
          sub={`Available in cNGN pool: ${formatNaira(cngnPoolKobo)}`}
        />
        <QuickAmounts />

        {/* Duration picker */}
        <p className="text-xs text-slate-500 mb-2">Lock Duration</p>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {LOCK_DURATIONS.map((d) => (
            <button
              key={d.days}
              onClick={() => setLockDuration(d.days)}
              className={`text-xs py-2.5 rounded-xl font-semibold transition ${
                lockDuration === d.days
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>

        {/* Projection */}
        {lockAmount >= 100 && (
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-1.5 mb-3">
              <TrendingUp className="w-3.5 h-3.5 text-purple-600" />
              <p className="text-xs font-bold text-purple-800">Returns Preview</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] text-purple-400 mb-0.5">You Lock</p>
                <p className="text-sm font-bold text-purple-900">{formatNaira(lockKobo)}</p>
              </div>
              <div>
                <p className="text-[10px] text-purple-400 mb-0.5">Interest</p>
                <p className="text-sm font-bold text-emerald-600">+{formatUsdc(projectedInterest)}</p>
              </div>
              <div>
                <p className="text-[10px] text-purple-400 mb-0.5">At Maturity</p>
                <p className="text-sm font-bold text-purple-900">{formatUsdc(lockUsdc + projectedInterest)}</p>
              </div>
            </div>
            <p className="text-[10px] text-purple-400 mt-2 text-center">
              {CNGN_APY}% APY · {lockDuration} days · Locked inside cNGN strategy
            </p>
          </div>
        )}

        <button
          onClick={executeFixed}
          disabled={busy || !amount}
          className="w-full py-3.5 text-white font-semibold rounded-xl bg-purple-600 hover:bg-purple-700 transition active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Lock for {lockDuration} Days
        </button>
      </div>

      {feedback && (
        <div className={`mb-4 px-4 py-2.5 rounded-xl text-sm font-medium ${
          feedback.toLowerCase().includes('insufficient') || feedback.toLowerCase().includes('minimum') || feedback.toLowerCase().includes('failed')
            ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
        }`}>
          {feedback}
        </div>
      )}

      {/* Active locks list */}
      {activeLocks.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Lock className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-semibold text-slate-800">Active Locks ({activeLocks.length})</h3>
          </div>
          <div className="space-y-3">
            {activeLocks.map((lock) => {
              const isMatured = new Date(lock.unlocks_at) <= new Date()
              const daysLeft = Math.max(0, Math.ceil((new Date(lock.unlocks_at).getTime() - Date.now()) / 86400000))
              return (
                <div key={lock.id} className={`bg-white rounded-xl border p-4 ${isMatured ? 'border-emerald-300' : 'border-slate-200'}`}>
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="text-sm font-bold text-slate-800">{formatUsdc(lock.amount_usdc_micro)}</p>
                      <p className="text-xs text-slate-400">{formatNaira(lock.amount_kobo)}</p>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      isMatured ? 'bg-emerald-100 text-emerald-700' : 'bg-purple-100 text-purple-700'
                    }`}>
                      {isMatured ? 'Matured ✓' : `${daysLeft}d left`}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-500 mb-3">
                    <span>{lock.apy_percent}% APY</span>
                    <span>{lock.duration_days} days</span>
                    <span className="text-emerald-600 font-medium">+{formatUsdc(lock.projected_interest_micro)}</span>
                  </div>
                  <button
                    onClick={() => handleWithdrawLock(lock)}
                    disabled={busy}
                    className={`w-full py-2.5 text-sm font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${
                      isMatured
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {isMatured ? <Unlock className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    {isMatured ? 'Withdraw + Interest' : 'Early Withdraw (no interest)'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex items-start gap-2.5 mt-4 bg-slate-100 rounded-xl px-4 py-3">
        <Info className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-slate-500 leading-relaxed">
          Early withdrawal forfeits all interest and incurs a 0.5% penalty on the principal.
        </p>
      </div>
    </div>
  )
}
