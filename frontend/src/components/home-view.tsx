'use client'

import { useState } from 'react'
import { formatNaira, formatUsdc, formatCompact, microUsdcToKobo, getRate, timeAgo } from '@/lib/format'
import { openDeposit, openWithdraw, type PaychantStatus } from '@/lib/paychant'
import { saveToVault, withdrawFromVault, createDepositTx } from '@/hooks/use-data'
import { ArrowDownLeft, ArrowUpRight, Vault, TrendingUp, Wallet, Plus, Minus, CreditCard, Loader2 } from 'lucide-react'
import type { Wallet as WalletType, Transaction } from '@/lib/types'
import type { User } from '@supabase/supabase-js'

interface Props {
  wallet: WalletType | null
  transactions: Transaction[]
  user: User | null
  refresh: () => void
}

export default function HomeView({ wallet, transactions, user, refresh }: Props) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')

  if (!wallet) return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>

  const rate = getRate()
  const savingsKobo = microUsdcToKobo(wallet.usdc_balance_micro, rate)
  const totalKobo = wallet.naira_balance_kobo + savingsKobo
  const recentTxs = transactions.slice(0, 6)

  const handleDeposit = async () => {
    if (!user?.email) return
    try {
      openDeposit(
        user.email,
        (s: PaychantStatus) => {
          if (s.reference) {
            createDepositTx(Math.round((s.amount || 0) * 100), s.reference)
          }
          if (s.status === 'completed' || s.status === 'success') {
            setFeedback('Deposit successful!')
            refresh()
            setTimeout(() => setFeedback(''), 3000)
          }
        },
        () => refresh()
      )
    } catch {
      setFeedback('Could not open deposit widget')
      setTimeout(() => setFeedback(''), 3000)
    }
  }

  const handleWithdraw = async () => {
    if (!user?.email) return
    try {
      openWithdraw(
        user.email,
        (s: PaychantStatus) => {
          if (s.status === 'completed' || s.status === 'success') {
            setFeedback('Withdrawal submitted!')
            refresh()
            setTimeout(() => setFeedback(''), 3000)
          }
        },
        () => refresh()
      )
    } catch {
      setFeedback('Could not open withdrawal widget')
      setTimeout(() => setFeedback(''), 3000)
    }
  }

  return (
    <div className="px-4 pt-5">
      {/* Balance Card */}
      <div className="bg-gradient-to-br from-emerald-600 to-emerald-800 rounded-2xl p-5 text-white">
        <p className="text-emerald-200 text-xs font-medium">Total Balance</p>
        <p className="text-[2rem] font-bold mt-0.5 tracking-tight">{formatNaira(totalKobo)}</p>
        <div className="flex gap-6 mt-4 text-sm">
          <div>
            <p className="text-emerald-300 text-[11px]">Available</p>
            <p className="font-semibold">{formatNaira(wallet.naira_balance_kobo)}</p>
          </div>
          <div>
            <p className="text-emerald-300 text-[11px]">USDC Vault</p>
            <p className="font-semibold">{formatUsdc(wallet.usdc_balance_micro)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-3 text-emerald-300 text-[11px]">
          <TrendingUp className="w-3 h-3" />
          <span>Rate: ₦{rate.toLocaleString()}/USD</span>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-3 gap-3 mt-5">
        <button
          onClick={handleDeposit}
          className="flex flex-col items-center gap-1.5 py-4 rounded-xl border border-slate-200 bg-white active:bg-slate-50 transition"
        >
          <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
            <CreditCard className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium text-slate-700">Deposit</span>
        </button>

        <button
          onClick={handleWithdraw}
          className="flex flex-col items-center gap-1.5 py-4 rounded-xl border border-slate-200 bg-white active:bg-slate-50 transition"
        >
          <div className="w-10 h-10 rounded-full bg-orange-100 text-orange-500 flex items-center justify-center">
            <ArrowUpRight className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium text-slate-700">Withdraw</span>
        </button>

        <button
          onClick={() => {/* Handled in vault tab */}}
          className="flex flex-col items-center gap-1.5 py-4 rounded-xl border border-slate-200 bg-white active:bg-slate-50 transition"
        >
          <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
            <Vault className="w-5 h-5" />
          </div>
          <span className="text-xs font-medium text-slate-700">Save</span>
        </button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className="mt-3 px-4 py-2.5 rounded-xl text-sm font-medium bg-emerald-50 text-emerald-700">
          {feedback}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mt-5">
        <div className="bg-white border border-slate-100 rounded-xl p-4">
          <p className="text-[11px] text-slate-400">Total Saved</p>
          <p className="text-lg font-bold text-slate-900 mt-0.5">{formatNaira(wallet.total_saved_kobo)}</p>
        </div>
        <div className="bg-white border border-slate-100 rounded-xl p-4">
          <p className="text-[11px] text-slate-400">Total Withdrawn</p>
          <p className="text-lg font-bold text-slate-900 mt-0.5">{formatNaira(wallet.total_withdrawn_kobo)}</p>
        </div>
      </div>

      {/* Recent Transactions */}
      <div className="mt-6 mb-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Activity</h3>
        {recentTxs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center">
            <Wallet className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-sm text-slate-400">No transactions yet</p>
            <p className="text-xs text-slate-300 mt-1">Make a deposit to get started</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-100 divide-y divide-slate-50">
            {recentTxs.map((tx) => (
              <div key={tx.id} className="flex items-center gap-3 px-4 py-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  tx.direction === 'credit' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'
                }`}>
                  {tx.direction === 'credit' ? <Plus className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-800 truncate">{tx.description}</p>
                  <p className="text-[11px] text-slate-400">
                    {timeAgo(tx.created_at)}
                    {tx.status === 'pending' && <span className="ml-1 text-amber-500 font-medium">pending</span>}
                  </p>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${
                  tx.direction === 'credit' ? 'text-emerald-600' : 'text-slate-700'
                }`}>
                  {tx.direction === 'credit' ? '+' : '-'}{formatNaira(tx.amount_kobo)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
