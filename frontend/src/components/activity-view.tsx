'use client'

import { formatNaira, formatUsdc, timeAgo } from '@/lib/format'
import { ArrowDownLeft, ArrowUpRight, Shield, RefreshCw, Users, AlertTriangle } from 'lucide-react'
import type { Transaction } from '@/lib/types'

interface Props {
  transactions: Transaction[]
}

const icons: Record<string, typeof ArrowDownLeft> = {
  deposit: ArrowDownLeft,
  withdrawal: ArrowUpRight,
  save_to_vault: Shield,
  vault_withdraw: Shield,
  esusu_contribute: Users,
  esusu_payout: Users,
  emergency_payout: AlertTriangle,
  split_auto_save: RefreshCw,
  split_auto_esusu: RefreshCw,
}

const labels: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  save_to_vault: 'Saved to Vault',
  vault_withdraw: 'Vault Withdrawal',
  esusu_contribute: 'Esusu Contribution',
  esusu_payout: 'Esusu Payout',
  emergency_payout: 'Emergency Payout',
  split_auto_save: 'Auto Save',
  split_auto_esusu: 'Auto Esusu',
}

const colorMap: Record<string, { bg: string; icon: string; amount: string }> = {
  deposit: { bg: 'bg-emerald-100', icon: 'text-emerald-600', amount: 'text-emerald-600' },
  withdrawal: { bg: 'bg-orange-100', icon: 'text-orange-600', amount: 'text-orange-600' },
  save_to_vault: { bg: 'bg-blue-100', icon: 'text-blue-600', amount: 'text-blue-600' },
  vault_withdraw: { bg: 'bg-indigo-100', icon: 'text-indigo-600', amount: 'text-indigo-600' },
  esusu_contribute: { bg: 'bg-purple-100', icon: 'text-purple-600', amount: 'text-purple-600' },
  esusu_payout: { bg: 'bg-violet-100', icon: 'text-violet-600', amount: 'text-violet-600' },
  emergency_payout: { bg: 'bg-amber-100', icon: 'text-amber-600', amount: 'text-amber-600' },
  split_auto_save: { bg: 'bg-cyan-100', icon: 'text-cyan-600', amount: 'text-cyan-600' },
  split_auto_esusu: { bg: 'bg-teal-100', icon: 'text-teal-600', amount: 'text-teal-600' },
}

const defaultColor = { bg: 'bg-slate-100', icon: 'text-slate-600', amount: 'text-slate-600' }

export default function ActivityView({ transactions }: Props) {
  // Group by date
  const grouped = transactions.reduce<Record<string, Transaction[]>>((acc, tx) => {
    const day = new Date(tx.created_at).toLocaleDateString('en-NG', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    if (!acc[day]) acc[day] = []
    acc[day].push(tx)
    return acc
  }, {})

  return (
    <div className="px-4 pt-5">
      <h2 className="text-lg font-bold text-slate-900 mb-4">Activity</h2>

      {transactions.length === 0 ? (
        <div className="text-center py-16">
          <RefreshCw className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500 mb-1">No transactions yet</p>
          <p className="text-xs text-slate-400">Deposit funds to get started</p>
        </div>
      ) : (
        Object.entries(grouped).map(([day, txs]) => (
          <div key={day} className="mb-5">
            <p className="text-xs text-slate-400 font-medium mb-2 uppercase tracking-wider">{day}</p>
            <div className="space-y-2">
              {txs.map((tx) => {
                const Icon = icons[tx.type] || RefreshCw
                const colors = colorMap[tx.type] || defaultColor
                const isCredit = ['deposit', 'vault_withdraw', 'esusu_payout', 'emergency_payout'].includes(tx.type)
                return (
                  <div
                    key={tx.id}
                    className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3"
                  >
                    <div className={`w-9 h-9 ${colors.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-4 h-4 ${colors.icon}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {labels[tx.type] || tx.type}
                      </p>
                      <p className="text-xs text-slate-400">{timeAgo(tx.created_at)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-semibold ${colors.amount}`}>
                        {isCredit ? '+' : '-'}{formatNaira(tx.amount_kobo)}
                      </p>
                      {tx.amount_usdc_micro && tx.amount_usdc_micro > 0 && (
                        <p className="text-xs text-slate-400">{formatUsdc(tx.amount_usdc_micro)}</p>
                      )}
                      {tx.status === 'pending' && (
                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                          Pending
                        </span>
                      )}
                      {tx.status === 'failed' && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">
                          Failed
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
