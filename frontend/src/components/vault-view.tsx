'use client'

import { useState, useEffect } from 'react'
import { formatNaira, formatCngn, koboToMicroUsdc, microUsdcToKobo, getRate } from '@/lib/format'
import { saveToVault, withdrawFromVault, lockSavings, withdrawLock, useSavingsLocks } from '@/hooks/use-data'
import { Shield, ArrowDown, ArrowUp, Info, Loader2, Lock, Unlock, TrendingUp, AlertTriangle, Zap, ChevronRight } from 'lucide-react'
import type { Wallet, SavingsLock } from '@/lib/types'
import { useConfirm } from '@/components/confirm-dialog'

interface Props {
  wallet: Wallet | null
  refresh: () => void
}

const LOCK_DURATIONS = [
  { days: 30,  label: '30 Days',  apy: 15 },
  { days: 90,  label: '90 Days',  apy: 22 },
  { days: 180, label: '6 Months', apy: 30 },
  { days: 365, label: '1 Year',   apy: 40 },
]

// Only fixed/locked savings plan
type SavingsPlan = null | 'fixed'
type FlexAction = 'save' | 'withdraw'
const FLEXIBLE_APY = 27  // Ajo (flexible savings) — supplied to PawasaveLend at ~80% utilization
const FIXED_APY_MAX = 40 // Maximum fixed APY (1-year lock)

export default function VaultView({ wallet, refresh }: Props) {
  const [plan, setPlan] = useState<SavingsPlan>(null)
  const [flexAction, setFlexAction] = useState<FlexAction>('save')
  const [amount, setAmount] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [lockDuration, setLockDuration] = useState(90)
  const [liveRate, setLiveRate] = useState<number>(getRate())
  const [showLockConsent, setShowLockConsent] = useState(false)
  const [lockConsented, setLockConsented] = useState(false)
  const { locks, loading: locksLoading, refresh: refreshLocks } = useSavingsLocks()
  const confirm = useConfirm()

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
  const cngnYieldMicro = wallet.cngn_yield_earned_micro || 0
  const cngnTotalMicro = (wallet.cngn_pool_micro || 0) + cngnYieldMicro
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)
  const cngnPoolKobo = microUsdcToKobo(wallet.cngn_pool_micro || 0, rate)
  const cngnTotalKobo = microUsdcToKobo(cngnTotalMicro, rate)
  const activeLocks = locks.filter(l => l.status === 'active')
  const totalLockedMicro = activeLocks.reduce((s, l) => s + l.amount_usdc_micro, 0)
  const lockedKobo = microUsdcToKobo(totalLockedMicro, rate)

  const lockAmount = parseFloat(amount) || 0
  const lockKobo = Math.round(lockAmount * 100)
  const lockUsdc = koboToMicroUsdc(lockKobo, rate)
  const selectedDuration = LOCK_DURATIONS.find(d => d.days === lockDuration)
  const selectedAPY = selectedDuration?.apy || LOCK_DURATIONS[0].apy
  const projectedInterest = Math.floor(lockUsdc * (selectedAPY / 100) * (lockDuration / 365))

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
        flash(`Saved ${formatCngn(usdc)} to flexible vault`)
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
    if (!lockConsented) {
      setShowLockConsent(true)
      return
    }

    const naira = parseFloat(amount)
    if (!naira || naira < 100) { flash('Minimum ₦100'); return }
    const kobo = Math.round(naira * 100)
    const usdc = koboToMicroUsdc(kobo, rate)
    setBusy(true)
    try {
      const selectedDuration = LOCK_DURATIONS.find(d => d.days === lockDuration)
      const selectedAPY = selectedDuration?.apy || LOCK_DURATIONS[0].apy
      await lockSavings(usdc, kobo, lockDuration, selectedAPY, true)
      flash(`Locked ${formatCngn(usdc)} for ${lockDuration} days at ${selectedAPY}% APY`)
      refreshLocks()
      setAmount('')
      refresh()
      setLockConsented(false)
    } catch (e: any) {
      flash(e.message || 'Operation failed')
    } finally {
      setBusy(false)
    }
  }

  const handleWithdrawLock = async (lock: SavingsLock) => {
    const isMatured = new Date(lock.unlocks_at) <= new Date()
    const early = !isMatured
    if (early && !(await confirm({ title: 'Early withdrawal', message: 'Early withdrawal forfeits interest and incurs a 0.5% penalty.', confirmText: 'Withdraw anyway', danger: true }))) return
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
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-amber-100" />
          <p className="text-amber-100 text-xs font-medium uppercase tracking-wider">Savings Vault</p>
        </div>
        <span className="text-xs font-semibold bg-white/20 px-2 py-0.5 rounded-full flex items-center gap-1">
          <TrendingUp className="w-3 h-3" /> Up to {FIXED_APY_MAX}% APY
        </span>
      </div>
      <p className="text-3xl font-bold tracking-tight">{formatNaira(cngnTotalKobo)}</p>
      <p className="text-amber-100 text-sm mt-0.5">{(cngnTotalMicro / 1_000_000).toFixed(2)} cNGN total</p>
      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-white/10 text-xs">
        <div>
          <p className="text-amber-100">Principal</p>
          <p className="font-semibold mt-0.5">{formatNaira(cngnPoolKobo)}</p>
        </div>
        <div>
          <p className="text-amber-200">Yield Earned</p>
          <p className="font-bold mt-0.5 text-amber-200">{formatCngn(cngnYieldMicro)}</p>
        </div>
        <div>
          <p className="text-amber-100">Liquid cNGN</p>
          <p className="font-semibold mt-0.5">{formatCngn(wallet.usdc_balance_micro)}</p>
        </div>
        <div>
          <p className="text-amber-100">Locked</p>
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
          ≈ {parseFloat(amount).toLocaleString('en-NG')} cNGN
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

        <h2 className="text-base font-bold text-slate-900 mb-1">Lock your savings</h2>
        <p className="text-xs text-slate-500 mb-4">
          All deposits automatically earn 27% APY in Ajo (flexible savings). Lock additional funds for higher returns (15–40% APY based on duration).
        </p>

        {/* Fixed/Locked Savings */}
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
                <p className="font-bold text-slate-900">Locked Savings (P Auto)</p>
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-purple-500 transition" />
              </div>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Time-lock your savings for 30 days, 90 days, 6 months, or 1 year. Earn 15–40% APY (higher for longer locks) — locked until maturity.
              </p>
              <div className="flex items-center gap-3 mt-3 flex-wrap">
                {LOCK_DURATIONS.map(d => (
                  <span key={d.days} className="text-xs font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">
                    {d.label}: {d.apy}%
                  </span>
                ))}
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
              You have {activeLocks.length} active lock{activeLocks.length > 1 ? 's' : ''} earning locked rates — tap to manage
            </p>
            <ChevronRight className="w-4 h-4 text-purple-400" />
          </div>
        )}
      </div>
    )
  }

  // ─── Flexible savings screen ──────────────────────────────────────────────
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
          <p className="text-xs text-purple-700 font-medium">{selectedAPY}% APY · P Auto (Locked)</p>
        </div>

        <AmountInput
          label="Amount to lock (₦)"
          sub={`Available in cNGN pool: ${formatNaira(cngnPoolKobo)}`}
        />
        <QuickAmounts />

        {/* Duration picker with APY rates */}
        <p className="text-xs text-slate-500 mb-2">Lock Duration</p>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {LOCK_DURATIONS.map((d) => (
            <button
              key={d.days}
              onClick={() => setLockDuration(d.days)}
              className={`text-xs py-2.5 rounded-xl font-semibold transition flex flex-col items-center gap-0.5 ${
                lockDuration === d.days
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <span>{d.label}</span>
              <span className={`text-xs font-bold ${lockDuration === d.days ? 'text-purple-100' : 'text-slate-400'}`}>
                {d.apy}%
              </span>
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
                <p className="text-sm font-bold text-emerald-600">+{formatCngn(projectedInterest)}</p>
              </div>
              <div>
                <p className="text-[10px] text-purple-400 mb-0.5">At Maturity</p>
                <p className="text-sm font-bold text-purple-900">{formatCngn(lockUsdc + projectedInterest)}</p>
              </div>
            </div>
            <p className="text-[10px] text-purple-400 mt-2 text-center">
              {selectedAPY}% APY · {lockDuration} days · P Auto
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
                      <p className="text-sm font-bold text-slate-800">{formatCngn(lock.amount_usdc_micro)}</p>
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
                    <span className="text-emerald-600 font-medium">+{formatCngn(lock.projected_interest_micro)}</span>
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

      {/* Consent Modal for Locking */}
      {showLockConsent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-slate-200 p-5">
              <h2 className="text-lg font-bold text-slate-900">Confirm Lock Agreement</h2>
            </div>

            <div className="p-5 space-y-4">
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                <p className="text-sm font-semibold text-purple-900 mb-2">Lock Terms</p>
                <p className="text-xs text-purple-800 leading-relaxed">
                  You are about to lock <strong>{formatCngn(lockUsdc)}</strong> for <strong>{lockDuration} days</strong> at <strong>{selectedAPY}%</strong> interest.
                </p>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 space-y-3">
                <p className="text-sm font-semibold text-slate-900">Terms & Conditions:</p>
                <ul className="text-xs text-slate-600 space-y-2">
                  <li>✓ <strong>Your funds are locked until {new Date(Date.now() + lockDuration * 86400000).toLocaleDateString()}.</strong></li>
                  <li>✓ You cannot withdraw before this date.</li>
                  <li>✓ If you attempt early withdrawal, you forfeit <strong>ALL interest earned</strong>.</li>
                  <li>✓ The forfeited interest will be credited to PawaSave as platform revenue.</li>
                  <li>✓ You will receive your principal amount minus a 0.5% early withdrawal penalty.</li>
                  <li>✓ Upon maturity, you receive principal + all accrued interest.</li>
                </ul>
              </div>

              <div className="flex gap-2">
                <input
                  type="checkbox"
                  checked={lockConsented}
                  onChange={(e) => setLockConsented(e.target.checked)}
                  className="w-4 h-4 mt-1"
                />
                <p className="text-xs text-slate-600">
                  I understand the lock terms and accept that my funds are locked until maturity. I also understand that early withdrawal forfeits all interest.
                </p>
              </div>
            </div>

            <div className="bg-slate-50 border-t border-slate-200 p-5 flex gap-3">
              <button
                onClick={() => {
                  setShowLockConsent(false)
                  setLockConsented(false)
                }}
                className="flex-1 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowLockConsent(false)
                  executeFixed()
                }}
                disabled={!lockConsented}
                className="flex-1 py-2.5 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg transition disabled:opacity-50"
              >
                Lock & Confirm
              </button>
            </div>
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
