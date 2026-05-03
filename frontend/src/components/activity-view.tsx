'use client'

import { useState } from 'react'
import { formatNaira, formatUsdc, timeAgo } from '@/lib/format'
import { ArrowDownLeft, ArrowUpRight, Shield, RefreshCw, Users, AlertTriangle, X, Copy, Check } from 'lucide-react'
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

function statusBadge(status: string) {
  if (status === 'pending') return <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">Pending</span>
  if (status === 'failed') return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">Failed</span>
  return <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-semibold">Completed</span>
}

function DetailRow({ label, value, mono = false, copyable = false }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)
  const doCopy = () => {
    navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-400 flex-shrink-0 pt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-xs text-slate-800 text-right break-all ${mono ? 'font-mono' : 'font-semibold'}`}>{value}</span>
        {copyable && (
          <button onClick={doCopy} className="flex-shrink-0 text-slate-400 hover:text-slate-600">
            {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
          </button>
        )}
      </div>
    </div>
  )
}

function TransactionModal({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const Icon = icons[tx.type] || RefreshCw
  const colors = colorMap[tx.type] || defaultColor
  const isCredit = ['deposit', 'vault_withdraw', 'esusu_payout', 'emergency_payout'].includes(tx.type)
  const fullDate = new Date(tx.created_at).toLocaleString('en-NG', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-md bg-white rounded-t-2xl px-5 pt-5 pb-8 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Handle bar */}
        <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-4" />

        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className={`w-11 h-11 ${colors.bg} rounded-xl flex items-center justify-center flex-shrink-0`}>
            <Icon className={`w-5 h-5 ${colors.icon}`} />
          </div>
          <div className="flex-1">
            <p className="text-base font-bold text-slate-900">{labels[tx.type] || tx.type}</p>
            <p className="text-xs text-slate-400">{timeAgo(tx.created_at)}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        {/* Big amount */}
        <div className="text-center mb-5">
          <p className={`text-3xl font-bold ${colors.amount}`}>
            {isCredit ? '+' : '-'}{formatNaira(tx.amount_kobo)}
          </p>
          {tx.amount_usdc_micro && tx.amount_usdc_micro > 0 && (
            <p className="text-sm text-slate-400 mt-1">{formatUsdc(tx.amount_usdc_micro)}</p>
          )}
          <div className="mt-2">{statusBadge(tx.status)}</div>
        </div>

        {/* Details */}
        <div className="bg-slate-50 rounded-xl px-4 py-1">
          <DetailRow label="Date & Time" value={fullDate} />
          {tx.description && <DetailRow label="Description" value={tx.description} />}
          {tx.reference && (
            <DetailRow label="PawaSave Ref" value={tx.reference} mono copyable />
          )}
          {tx.paychant_tx_id && tx.paychant_tx_id !== tx.reference && (
            <DetailRow label="Provider Ref" value={tx.paychant_tx_id} mono copyable />
          )}
          <DetailRow label="Transaction ID" value={tx.id} mono copyable />
        </div>

        {(tx.status === 'pending' && (tx.type === 'deposit' || tx.type === 'withdrawal')) && (
          <p className="text-xs text-amber-600 text-center mt-4 px-2">
            This transaction is still processing. The status will update automatically once confirmed.
          </p>
        )}
        {tx.status === 'failed' && (
          <p className="text-xs text-red-500 text-center mt-4 px-2">
            This transaction failed. If you were debited, contact support with the references above.
          </p>
        )}
      </div>
    </div>
  )
}

export default function ActivityView({ transactions }: Props) {
  const [selected, setSelected] = useState<Transaction | null>(null)

  const grouped = transactions.reduce<Record<string, Transaction[]>>((acc, tx) => {
    const day = new Date(tx.created_at).toLocaleDateString('en-NG', {
      weekday: 'short', month: 'short', day: 'numeric',
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
                  <button
                    key={tx.id}
                    onClick={() => setSelected(tx)}
                    className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 text-left active:bg-slate-50 transition"
                  >
                    <div className={`w-9 h-9 ${colors.bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
                      <Icon className={`w-4 h-4 ${colors.icon}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">
                        {labels[tx.type] || tx.type}
                      </p>
                      <p className="text-xs text-slate-400">{timeAgo(tx.created_at)}</p>
                      {tx.reference && (
                        <p className="text-[10px] text-slate-300 font-mono truncate mt-0.5">
                          Ref: {tx.reference.slice(0, 8)}…
                        </p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-bold ${colors.amount}`}>
                        {isCredit ? '+' : '-'}{formatNaira(tx.amount_kobo)}
                      </p>
                      {tx.amount_usdc_micro && tx.amount_usdc_micro > 0 && (
                        <p className="text-xs text-slate-400">{formatUsdc(tx.amount_usdc_micro)}</p>
                      )}
                      {tx.status === 'pending' && (
                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">Pending</span>
                      )}
                      {tx.status === 'failed' && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full font-medium">Failed</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ))
      )}

      {selected && <TransactionModal tx={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}


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
                      {tx.reference && (
                        <p className="text-[10px] text-slate-300 font-mono truncate mt-0.5" title={tx.reference}>
                          Ref: {tx.reference.slice(0, 8)}…
                        </p>
                      )}
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
