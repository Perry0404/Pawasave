'use client'

import { useState, useEffect } from 'react'
import { formatNaira, formatUsdc, koboToMicroUsdc, microUsdcToKobo, getRate } from '@/lib/format'
import { saveToVault, withdrawFromVault, lockSavings, withdrawLock, useSavingsLocks, getMorphoApy } from '@/hooks/use-data'
import { Shield, ArrowDown, ArrowUp, Info, Loader2, Lock, Unlock, TrendingUp, Clock, AlertTriangle } from 'lucide-react'
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

export default function VaultView({ wallet, refresh }: Props) {
  const [mode, setMode] = useState<'save' | 'withdraw' | 'lock'>('save')
  const [amount, setAmount] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [lockDuration, setLockDuration] = useState(90)
  const [morphoApy, setMorphoApy] = useState(4.0)
  const { locks, loading: locksLoading, refresh: refreshLocks } = useSavingsLocks()

  useEffect(() => {
    getMorphoApy().then(setMorphoApy)
  }, [])

  if (!wallet) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  const rate = getRate()
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)
  const activeLocks = locks.filter(l => l.status === 'active')
  const totalLockedMicro = activeLocks.reduce((s, l) => s + l.amount_usdc_micro, 0)

  // Interest projection for lock form
  const lockAmount = parseFloat(amount) || 0
  const lockKobo = Math.round(lockAmount * 100)
  const lockUsdc = koboToMicroUsdc(lockKobo, rate)
  const projectedInterest = Math.floor(lockUsdc * (morphoApy / 100) * (lockDuration / 365))

  const execute = async () => {
    const naira = parseFloat(amount)
    if (!naira || naira < 100) { setFeedback('Minimum ₦100'); return }
    const kobo = Math.round(naira * 100)
    const usdc = koboToMicroUsdc(kobo, rate)

    setBusy(true)
    try {
      if (mode === 'save') {
        await saveToVault(kobo, usdc)
        setFeedback(`Saved ${formatUsdc(usdc)} to vault`)
      } else if (mode === 'withdraw') {
        await withdrawFromVault(kobo, usdc)
        setFeedback(`Withdrew ${formatNaira(kobo)} from vault`)
      } else if (mode === 'lock') {
        await lockSavings(usdc, kobo, lockDuration, morphoApy)
        setFeedback(`Locked ${formatUsdc(usdc)} for ${lockDuration} days`)
        refreshLocks()
      }
      setAmount('')
      refresh()
    } catch (e: any) {
      setFeedback(e.message || 'Operation failed')
    } finally {
      setBusy(false)
      setTimeout(() => setFeedback(''), 3000)
    }
  }

  const handleWithdrawLock = async (lock: SavingsLock) => {
    const isMatured = new Date(lock.unlocks_at) <= new Date()
    const early = !isMatured
    if (early && !confirm('Early withdrawal forfeits interest and incurs a 0.5% penalty. Continue?')) return

    setBusy(true)
    try {
      await withdrawLock(lock.id, early)
      setFeedback(early ? 'Lock withdrawn early (no interest)' : 'Lock matured — withdrawn with interest!')
      refreshLocks()
      refresh()
    } catch (e: any) {
      setFeedback(e.message || 'Failed to withdraw')
    } finally {
      setBusy(false)
      setTimeout(() => setFeedback(''), 3000)
    }
  }

  return (
    <div className="px-4 pt-5 pb-6">
      {/* Vault Card */}
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-5 text-white">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-blue-200" />
          <p className="text-blue-200 text-xs font-medium uppercase tracking-wider">USDC Vault</p>
        </div>
        <p className="text-3xl font-bold tracking-tight">{formatUsdc(wallet.usdc_balance_micro)}</p>
        <p className="text-blue-300 text-sm mt-1">&asymp; {formatNaira(savingsKobo)}</p>
        <div className="flex items-center gap-4 mt-4 pt-3 border-t border-white/10 text-xs">
          <div>
            <p className="text-blue-300">Available</p>
            <p className="font-semibold mt-0.5">{formatUsdc(wallet.usdc_balance_micro)}</p>
          </div>
          <div>
            <p className="text-blue-300">Locked</p>
            <p className="font-semibold mt-0.5">{formatUsdc(totalLockedMicro)}</p>
          </div>
          <div>
            <p className="text-blue-300">Rate</p>
            <p className="font-semibold mt-0.5">₦{rate}/USD</p>
          </div>
        </div>
      </div>

      {/* Morpho Yield Banner */}
      <div className="flex items-center gap-2.5 mt-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
        <TrendingUp className="w-4 h-4 text-emerald-600 flex-shrink-0" />
        <div>
          <p className="text-xs font-semibold text-emerald-800">Gauntlet USDC Prime · Morpho Vault</p>
          <p className="text-xs text-emerald-600">{morphoApy}% APY — Lock your savings to earn interest</p>
        </div>
      </div>

      {/* Mode Toggle */}
      <div className="flex bg-slate-100 rounded-xl p-1 mt-4 mb-4">
        <button
          onClick={() => { setMode('save'); setFeedback('') }}
          className={`flex-1 py-2.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all ${
            mode === 'save' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          <ArrowDown className="w-3 h-3" /> Save
        </button>
        <button
          onClick={() => { setMode('withdraw'); setFeedback('') }}
          className={`flex-1 py-2.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all ${
            mode === 'withdraw' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'
          }`}
        >
          <ArrowUp className="w-3 h-3" /> Withdraw
        </button>
        <button
          onClick={() => { setMode('lock'); setFeedback('') }}
          className={`flex-1 py-2.5 text-xs font-semibold rounded-lg flex items-center justify-center gap-1 transition-all ${
            mode === 'lock' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Lock className="w-3 h-3" /> Lock
        </button>
      </div>

      {/* Amount Input */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <p className="text-xs text-slate-500 mb-1">
          {mode === 'save' ? 'Amount to save (Naira)' : mode === 'withdraw' ? 'Amount to withdraw (Naira)' : 'Amount to lock (Naira)'}
        </p>
        <p className="text-xs text-slate-400 mb-3">
          {mode === 'save'
            ? `Available: ${formatNaira(wallet.naira_balance_kobo)}`
            : mode === 'withdraw'
            ? `In vault: ${formatUsdc(wallet.usdc_balance_micro)} (${formatNaira(savingsKobo)})`
            : `In vault: ${formatUsdc(wallet.usdc_balance_micro)} — will lock from vault`
          }
        </p>
        <div className="relative mb-3">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg font-medium">₦</span>
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full pl-10 pr-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        {amount && parseFloat(amount) > 0 && (
          <p className="text-xs text-slate-400 mb-3">
            &asymp; {formatUsdc(koboToMicroUsdc(Math.round(parseFloat(amount) * 100), rate))} USDC
          </p>
        )}

        {/* Lock Duration Picker */}
        {mode === 'lock' && (
          <>
            <p className="text-xs text-slate-500 mb-2">Lock Duration</p>
            <div className="flex gap-2 mb-3">
              {LOCK_DURATIONS.map((d) => (
                <button
                  key={d.days}
                  onClick={() => setLockDuration(d.days)}
                  className={`flex-1 text-xs py-2.5 rounded-lg font-medium transition ${
                    lockDuration === d.days
                      ? 'bg-purple-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>

            {/* Interest Projection */}
            {lockAmount >= 100 && (
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-3.5 mb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <TrendingUp className="w-3.5 h-3.5 text-purple-600" />
                  <p className="text-xs font-semibold text-purple-800">Interest Projection</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] text-purple-500">Principal</p>
                    <p className="text-xs font-bold text-purple-800">{formatUsdc(lockUsdc)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-purple-500">Interest</p>
                    <p className="text-xs font-bold text-emerald-700">+{formatUsdc(projectedInterest)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-purple-500">Total</p>
                    <p className="text-xs font-bold text-purple-800">{formatUsdc(lockUsdc + projectedInterest)}</p>
                  </div>
                </div>
                <p className="text-[10px] text-purple-500 mt-2 text-center">
                  {morphoApy}% APY &middot; {lockDuration} days &middot; Powered by Morpho
                </p>
              </div>
            )}
          </>
        )}

        <div className="flex gap-2 mb-4">
          {[10000, 50000, 100000, 500000].map((v) => (
            <button
              key={v}
              onClick={() => setAmount(v.toString())}
              className="flex-1 text-xs py-2 bg-slate-100 hover:bg-slate-200 active:bg-slate-200 text-slate-600 rounded-lg transition font-medium"
            >
              {v >= 1000 ? `${v / 1000}k` : v}
            </button>
          ))}
        </div>
        <button
          onClick={execute}
          disabled={busy}
          className={`w-full py-3.5 text-white font-semibold rounded-xl transition active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2 ${
            mode === 'save' ? 'bg-emerald-600 hover:bg-emerald-700' :
            mode === 'withdraw' ? 'bg-orange-500 hover:bg-orange-600' :
            'bg-purple-600 hover:bg-purple-700'
          }`}
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {mode === 'save' ? 'Save to Vault' : mode === 'withdraw' ? 'Withdraw to Naira' : `Lock for ${lockDuration} Days`}
        </button>
      </div>

      {feedback && (
        <div className={`mt-3 px-4 py-2.5 rounded-xl text-sm font-medium ${
          feedback.includes('Insufficient') || feedback.includes('Minimum') || feedback.includes('failed') || feedback.includes('no interest')
            ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
        }`}>
          {feedback}
        </div>
      )}

      {/* Active Locks */}
      {activeLocks.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center gap-2 mb-3">
            <Lock className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-semibold text-slate-800">Locked Savings ({activeLocks.length})</h3>
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
                      {isMatured ? 'Matured' : `${daysLeft}d left`}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-500 mb-3">
                    <span>{lock.apy_percent}% APY</span>
                    <span>{lock.duration_days} days</span>
                    <span className="text-emerald-600 font-medium">+{formatUsdc(lock.projected_interest_micro)} interest</span>
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

      {/* Info */}
      <div className="flex items-start gap-2.5 mt-4 bg-slate-100 rounded-xl px-4 py-3">
        <Info className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-slate-500 leading-relaxed">
          <strong>Save:</strong> Convert naira to USDC, withdraw anytime.{' '}
          <strong>Lock:</strong> Earn {morphoApy}% APY via Morpho vaults. Early withdrawal forfeits interest + 0.5% penalty.
        </p>
      </div>
    </div>
  )
}
