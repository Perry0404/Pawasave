'use client'

import { useState } from 'react'
import { formatNaira, formatUsdc, koboToMicroUsdc, microUsdcToKobo, getRate } from '@/lib/format'
import { saveToVault, withdrawFromVault } from '@/hooks/use-data'
import { Shield, ArrowDown, ArrowUp, Info, Loader2 } from 'lucide-react'
import type { Wallet } from '@/lib/types'

interface Props {
  wallet: Wallet | null
  refresh: () => void
}

export default function VaultView({ wallet, refresh }: Props) {
  const [mode, setMode] = useState<'save' | 'withdraw'>('save')
  const [amount, setAmount] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  if (!wallet) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  const rate = getRate()
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)

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
      } else {
        await withdrawFromVault(kobo, usdc)
        setFeedback(`Withdrew ${formatNaira(kobo)} from vault`)
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

  return (
    <div className="px-4 pt-5">
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
            <p className="text-blue-300">Total Saved</p>
            <p className="font-semibold mt-0.5">{formatNaira(wallet.total_saved_kobo)}</p>
          </div>
          <div>
            <p className="text-blue-300">Rate</p>
            <p className="font-semibold mt-0.5">₦{rate}/USD</p>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2.5 mt-4 bg-slate-100 rounded-xl px-4 py-3">
        <Info className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-slate-500 leading-relaxed">
          Your savings convert to USDC at current rates. Withdraw to naira anytime — no lock period.
        </p>
      </div>

      {/* Save / Withdraw Toggle */}
      <div className="flex bg-slate-100 rounded-xl p-1 mt-5 mb-4">
        <button
          onClick={() => { setMode('save'); setFeedback('') }}
          className={`flex-1 py-2.5 text-sm font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all ${
            mode === 'save' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
          }`}
        >
          <ArrowDown className="w-3.5 h-3.5" /> Save
        </button>
        <button
          onClick={() => { setMode('withdraw'); setFeedback('') }}
          className={`flex-1 py-2.5 text-sm font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all ${
            mode === 'withdraw' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-500'
          }`}
        >
          <ArrowUp className="w-3.5 h-3.5" /> Withdraw
        </button>
      </div>

      {/* Amount Input */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <p className="text-xs text-slate-500 mb-1">
          {mode === 'save' ? 'Amount to save (Naira)' : 'Amount to withdraw (Naira)'}
        </p>
        <p className="text-xs text-slate-400 mb-3">
          {mode === 'save'
            ? `Available: ${formatNaira(wallet.naira_balance_kobo)}`
            : `In vault: ${formatUsdc(wallet.usdc_balance_micro)} (${formatNaira(savingsKobo)})`
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
            mode === 'save' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-orange-500 hover:bg-orange-600'
          }`}
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {mode === 'save' ? 'Save to Vault' : 'Withdraw to Naira'}
        </button>
      </div>

      {feedback && (
        <div className={`mt-3 px-4 py-2.5 rounded-xl text-sm font-medium ${
          feedback.includes('Insufficient') || feedback.includes('Minimum') || feedback.includes('failed')
            ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
        }`}>
          {feedback}
        </div>
      )}
    </div>
  )
}
