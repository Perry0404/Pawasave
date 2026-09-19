'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatNaira, formatCngn } from '@/lib/format'
import type { AdminFeeSummary, AdminUserStats, AdminTxVolume, PlatformFee } from '@/lib/types'
import {
  Shield, DollarSign, Users, Activity, TrendingUp, Loader2, Lock, AlertTriangle,
  ArrowUpRight, ArrowDownLeft, Eye, EyeOff, LogOut, Banknote, ChevronDown, BarChart3,
  RefreshCw, Wallet, PiggyBank, Landmark, Layers, ShoppingBag,
} from 'lucide-react'
import Link from 'next/link'

const ADMIN_STORAGE_KEY = 'pawa_admin_auth'

interface AdminInvestment {
  kind: string; side: 'buy' | 'sell' | string; symbol: string
  user_id: string; display_name: string | null; phone: string | null
  amount_cngn_micro: number; shares: number | null; status: string
  reference: string | null; created_at: string
}

type Tab = 'overview' | 'revenue' | 'activity'

// ── small presentational helpers ────────────────────────────────────────────

function StatCard({ icon, label, value, sub, tone = 'slate' }: {
  icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode
  tone?: 'slate' | 'emerald' | 'blue' | 'violet' | 'amber' | 'indigo' | 'orange' | 'purple' | 'teal'
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-500', emerald: 'text-emerald-500', blue: 'text-blue-500',
    violet: 'text-violet-500', amber: 'text-amber-500', indigo: 'text-indigo-500',
    orange: 'text-orange-500', purple: 'text-purple-500', teal: 'text-teal-500',
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className={`mb-2 ${tones[tone]}`}>{icon}</div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-xl font-bold text-slate-800 tabular-nums leading-tight mt-0.5">{value}</p>
      {sub}
    </div>
  )
}

// Full class strings (never interpolated) so Tailwind's JIT keeps them.
const ROW_TONES: Record<string, string> = {
  emerald: 'text-emerald-600', orange: 'text-orange-600', blue: 'text-blue-600',
  teal: 'text-teal-600', teal7: 'text-teal-700', indigo: 'text-indigo-600',
  purple: 'text-purple-600', slate: 'text-slate-900',
}

function Row({ label, value, tone = 'slate' }: { label: string; value: string; tone?: keyof typeof ROW_TONES }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold tabular-nums ${ROW_TONES[tone] || ROW_TONES.slate}`}>{value}</span>
    </div>
  )
}

function SectionCard({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {right}
      </div>
      {children}
    </div>
  )
}

export default function AdminView() {
  const [authed, setAuthed] = useState(false)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [authError, setAuthError] = useState('')
  const [dashboardError, setDashboardError] = useState('')
  const [fees, setFees] = useState<AdminFeeSummary | null>(null)
  const [users, setUsers] = useState<AdminUserStats | null>(null)
  const [volume, setVolume] = useState<AdminTxVolume | null>(null)
  const [recentFees, setRecentFees] = useState<PlatformFee[]>([])
  const [recentInvestments, setRecentInvestments] = useState<AdminInvestment[]>([])
  const [ajo, setAjo] = useState<{ groups: number; members: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [revenueKobo, setRevenueKobo] = useState(0)
  const [showWithdrawRevenue, setShowWithdrawRevenue] = useState(false)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawBankCode, setWithdrawBankCode] = useState('')
  const [withdrawAccount, setWithdrawAccount] = useState('')
  const [withdrawBusy, setWithdrawBusy] = useState(false)
  const [withdrawFeedback, setWithdrawFeedback] = useState('')
  const [tab, setTab] = useState<Tab>('overview')

  // Restore the UI "authed" flag (non-sensitive); the real auth is the httpOnly
  // session cookie set by /api/admin/verify (V2-HIGH-03 — no password in storage).
  useEffect(() => {
    if (sessionStorage.getItem(ADMIN_STORAGE_KEY) === 'true') {
      setAuthed(true)
    } else {
      setLoading(false)
    }
  }, [])

  // Load data (auth travels via the httpOnly cookie, sent automatically).
  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true)
    try {
      const res = await fetch('/api/admin/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recentFeeLimit: 30 }),
      })
      const data = await res.json()
      if (res.status === 401) {
        sessionStorage.removeItem(ADMIN_STORAGE_KEY)
        setAuthed(false)
      } else if (!res.ok) {
        setDashboardError(data.error || 'Dashboard load failed — check server logs')
      } else {
        setDashboardError('')
        setFees(data.fees)
        setUsers(data.users)
        setVolume(data.volume)
        setRecentFees(data.recentFees || [])
        setRecentInvestments(data.recentInvestments || [])
        setRevenueKobo(data.revenueKobo || 0)
        setAjo(data.ajo || null)
      }
    } catch (err: unknown) {
      setDashboardError(err instanceof Error ? err.message : 'Network error')
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    if (authed) loadData()
  }, [authed, loadData])

  const handleWithdrawRevenue = async (e: React.FormEvent) => {
    e.preventDefault()
    const amount = parseFloat(withdrawAmount)
    if (!amount || amount < 1000) { setWithdrawFeedback('Minimum ₦1,000'); return }
    if (!withdrawBankCode || !withdrawAccount) { setWithdrawFeedback('Fill in bank details'); return }
    setWithdrawBusy(true)
    setWithdrawFeedback('')
    try {
      const res = await fetch('/api/admin/revenue-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountNaira: amount, bankCode: withdrawBankCode, accountNumber: withdrawAccount }),
      })
      const data = await res.json()
      if (res.ok) {
        setWithdrawFeedback(`✓ Withdrawal initiated! Ref: ${data.reference}`)
        setWithdrawAmount('')
        setRevenueKobo(prev => Math.max(0, prev - Math.round(amount * 100)))
      } else {
        setWithdrawFeedback(data.error || 'Withdrawal failed')
      }
    } catch {
      setWithdrawFeedback('Network error — try again')
    } finally {
      setWithdrawBusy(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    const res = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      sessionStorage.setItem(ADMIN_STORAGE_KEY, 'true')
      setAuthed(true)
      setPassword('')
    } else {
      setAuthError('Invalid admin password')
    }
  }

  const handleLogout = async () => {
    sessionStorage.removeItem(ADMIN_STORAGE_KEY)
    try { await fetch('/api/admin/logout', { method: 'POST' }) } catch { /* ignore */ }
    setAuthed(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    )
  }

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-emerald-50 flex items-center justify-center mx-auto mb-3">
              <Shield className="w-7 h-7 text-emerald-600" />
            </div>
            <h1 className="text-xl font-bold text-slate-900">Admin Access</h1>
            <p className="text-sm text-slate-500 mt-1">Enter admin password to continue</p>
          </div>
          <div className="relative mb-4">
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Admin password"
              className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 pr-12"
              autoFocus
            />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {authError && <p className="text-sm text-red-600 mb-3 text-center">{authError}</p>}
          <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3.5 rounded-xl transition">
            Access Dashboard
          </button>
        </form>
      </div>
    )
  }

  // ── Derived totals ────────────────────────────────────────────────────────
  const totalVolume =
    (volume?.total_deposits_kobo || 0) + (volume?.total_withdrawals_kobo || 0)
    + (volume?.total_vault_saves_kobo || 0) + (volume?.total_loans_disbursed_kobo || 0)
    + (volume?.total_loans_repaid_kobo || 0) + (volume?.total_investments_kobo || 0)
    + (volume?.total_transfers_kobo || 0)
  const tvlKobo = (users?.total_naira_kobo || 0) + Math.floor((users?.total_usdc_micro || 0) / 10000)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'revenue', label: 'Revenue' },
    { id: 'activity', label: 'Activity' },
  ]

  return (
    <div className="px-4 pt-5 pb-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-emerald-50 flex items-center justify-center">
            <Shield className="w-4 h-4 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900 leading-none">Admin Dashboard</h1>
            <p className="text-[11px] text-slate-400 mt-1">PawaSave control center</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="text-slate-400 hover:text-slate-600 p-2 transition disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <Link href="/admin/revenue" className="text-slate-400 hover:text-slate-600 p-2 transition" title="Revenue Analytics">
            <BarChart3 className="w-4 h-4" />
          </Link>
          <button onClick={handleLogout} className="text-slate-400 hover:text-slate-600 p-2 transition" title="Log out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {dashboardError && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{dashboardError}</span>
        </div>
      )}

      {/* Segmented tabs */}
      <div className="flex gap-1 p-1 bg-slate-100 rounded-xl mb-5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 text-sm font-semibold py-2 rounded-lg transition ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ─────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <>
          {/* Revenue hero */}
          <div className="bg-gradient-to-br from-emerald-600 to-teal-700 rounded-2xl p-5 text-white mb-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <DollarSign className="w-4 h-4 text-emerald-200" />
              <p className="text-emerald-200 text-xs font-medium uppercase tracking-wider">Total Revenue</p>
            </div>
            <p className="text-3xl font-bold tracking-tight tabular-nums">{formatNaira(fees?.total_fees_kobo || 0)}</p>
            <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-white/10 text-xs">
              <div>
                <p className="text-emerald-300">Today</p>
                <p className="font-semibold mt-0.5 tabular-nums">{formatNaira(fees?.today_fees_kobo || 0)}</p>
              </div>
              <div>
                <p className="text-emerald-300">This Month</p>
                <p className="font-semibold mt-0.5 tabular-nums">{formatNaira(fees?.this_month_fees_kobo || 0)}</p>
              </div>
              <div>
                <p className="text-emerald-300">Fee Txns</p>
                <p className="font-semibold mt-0.5 tabular-nums">{fees?.fee_count || 0}</p>
              </div>
            </div>
          </div>

          {/* Key KPIs */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <StatCard tone="blue" icon={<Users className="w-4 h-4" />} label="Total Users" value={String(users?.total_users || 0)} />
            <StatCard
              tone="violet" icon={<Activity className="w-4 h-4" />} label="Total Transactions"
              value={String(volume?.total_tx_count || 0)}
              sub={(volume?.pending_count || 0) > 0 ? <p className="text-[10px] text-amber-600 mt-0.5">{volume!.pending_count} pending</p> : undefined}
            />
            <StatCard tone="emerald" icon={<Wallet className="w-4 h-4" />} label="Platform TVL" value={formatNaira(tvlKobo)} />
            <StatCard tone="purple" icon={<Layers className="w-4 h-4" />} label="Total Volume" value={formatNaira(totalVolume)} />
          </div>

          {/* Ajo adoption */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard tone="amber" icon={<Users className="w-4 h-4" />} label="Ajo Groups" value={String(ajo?.groups || 0)} />
            <StatCard tone="teal" icon={<Users className="w-4 h-4" />} label="Ajo Memberships" value={String(ajo?.members || 0)} />
          </div>
        </>
      )}

      {/* ── REVENUE ──────────────────────────────────────────────── */}
      {tab === 'revenue' && (
        <>
          {/* Fee breakdown */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <StatCard tone="emerald" icon={<ArrowDownLeft className="w-4 h-4" />} label="On-ramp fees" value={formatNaira(fees?.total_onramp_fees || 0)} />
            <StatCard tone="orange" icon={<ArrowUpRight className="w-4 h-4" />} label="Off-ramp fees" value={formatNaira(fees?.total_offramp_fees || 0)} />
            <StatCard tone="purple" icon={<Lock className="w-4 h-4" />} label="Penalties" value={formatNaira(fees?.total_penalty_fees || 0)} />
            <StatCard tone="teal" icon={<TrendingUp className="w-4 h-4" />} label="Loans (fee + interest)" value={formatNaira(fees?.total_loan_fees || 0)} />
            <StatCard tone="indigo" icon={<TrendingUp className="w-4 h-4" />} label="Stocks (sell fee)" value={formatNaira(fees?.total_investment_fees || 0)} />
          </div>

          {/* TVL detail */}
          <SectionCard title="Platform TVL">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-slate-500 flex items-center gap-1"><Banknote className="w-3 h-3" /> Naira Balances</p>
                <p className="font-bold text-slate-800 tabular-nums mt-0.5">{formatNaira(users?.total_naira_kobo || 0)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 flex items-center gap-1"><PiggyBank className="w-3 h-3" /> cNGN Savings</p>
                <p className="font-bold text-slate-800 tabular-nums mt-0.5">{formatCngn(users?.total_usdc_micro || 0)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 flex items-center gap-1"><Lock className="w-3 h-3" /> Locked cNGN</p>
                <p className="font-bold text-slate-800 tabular-nums mt-0.5">{formatCngn(users?.total_locked_usdc_micro || 0)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 flex items-center gap-1"><Landmark className="w-3 h-3" /> Active Locks</p>
                <p className="font-bold text-slate-800 tabular-nums mt-0.5">{users?.active_locks || 0}</p>
              </div>
            </div>
          </SectionCard>

          {/* Transaction volume breakdown */}
          <SectionCard title="Transaction Volume">
            <div className="space-y-2.5 text-sm">
              <Row label="Deposits" value={formatNaira(volume?.total_deposits_kobo || 0)} tone="emerald" />
              <Row label="Withdrawals" value={formatNaira(volume?.total_withdrawals_kobo || 0)} tone="orange" />
              <Row label="Vault Saves" value={formatNaira(volume?.total_vault_saves_kobo || 0)} tone="blue" />
              <Row label="Loans Disbursed" value={formatNaira(volume?.total_loans_disbursed_kobo || 0)} tone="teal" />
              <Row label="Loans Repaid" value={formatNaira(volume?.total_loans_repaid_kobo || 0)} tone="teal7" />
              <Row label="Investments" value={formatNaira(volume?.total_investments_kobo || 0)} tone="indigo" />
              <Row label="Transfers (P2P & Pawa)" value={formatNaira(volume?.total_transfers_kobo || 0)} tone="purple" />
              <div className="flex justify-between pt-2.5 mt-0.5 border-t border-slate-200">
                <span className="font-semibold text-slate-700">Total Volume</span>
                <span className="font-bold text-slate-900 tabular-nums">{formatNaira(totalVolume)}</span>
              </div>
            </div>
          </SectionCard>

          {/* Withdraw revenue */}
          <div className="bg-white rounded-2xl border border-emerald-200 p-5">
            <button onClick={() => setShowWithdrawRevenue(!showWithdrawRevenue)} className="w-full flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Banknote className="w-4 h-4 text-emerald-600" />
                <span className="text-sm font-semibold text-slate-800">Withdraw Revenue</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-emerald-600 tabular-nums">{formatNaira(revenueKobo)} available</span>
                <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showWithdrawRevenue ? 'rotate-180' : ''}`} />
              </div>
            </button>

            {showWithdrawRevenue && (
              <form onSubmit={handleWithdrawRevenue} className="mt-4 space-y-3">
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">Amount (₦)</label>
                  <input type="number" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)}
                    placeholder="e.g. 50000" min={1000} max={revenueKobo / 100}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">Bank Code</label>
                  <input type="text" value={withdrawBankCode} onChange={(e) => setWithdrawBankCode(e.target.value)}
                    placeholder="e.g. 058 (GTBank)"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">Account Number</label>
                  <input type="text" value={withdrawAccount} onChange={(e) => setWithdrawAccount(e.target.value)}
                    placeholder="10-digit account number" maxLength={10}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                {withdrawFeedback && (
                  <p className={`text-xs px-3 py-2 rounded-lg ${withdrawFeedback.startsWith('✓') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                    {withdrawFeedback}
                  </p>
                )}
                <button type="submit" disabled={withdrawBusy}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl transition disabled:opacity-60 flex items-center justify-center gap-2">
                  {withdrawBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                  Withdraw to Bank
                </button>
              </form>
            )}
          </div>
        </>
      )}

      {/* ── ACTIVITY ─────────────────────────────────────────────── */}
      {tab === 'activity' && (
        <>
          {/* Recent investments */}
          <SectionCard title="Recent Investments" right={<span className="text-[11px] text-slate-400">{recentInvestments.length} shown</span>}>
            {recentInvestments.length === 0 ? (
              <div className="py-6 text-center">
                <ShoppingBag className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                <p className="text-xs text-slate-400">No investments yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentInvestments.map((inv, i) => {
                  const buy = inv.side === 'buy'
                  const done = inv.status === 'filled' || inv.status === 'completed' || inv.status === 'credited'
                  const failed = inv.status === 'failed' || inv.status === 'refunded'
                  return (
                    <div key={`${inv.reference || inv.user_id}-${i}`} className="flex items-center justify-between py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${buy ? 'bg-emerald-50 text-emerald-700' : 'bg-orange-50 text-orange-700'}`}>{buy ? 'BUY' : 'SELL'}</span>
                          <span className="font-semibold text-slate-800">{inv.symbol}</span>
                          <span className="text-[10px] text-slate-400">{inv.kind}</span>
                        </div>
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">
                          {inv.display_name || inv.phone || inv.user_id.slice(0, 8)} · {new Date(inv.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                        </p>
                      </div>
                      <div className="text-right flex-none ml-2">
                        <div className="font-semibold text-slate-900 tabular-nums">{formatNaira((inv.amount_cngn_micro || 0) / 10000)}</div>
                        <div className={`text-[10px] font-medium ${done ? 'text-emerald-600' : failed ? 'text-red-500' : 'text-amber-600'}`}>
                          {inv.status}{inv.shares ? ` · ${Number(inv.shares).toFixed(4)} sh` : ''}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>

          {/* Recent fees */}
          <SectionCard title="Recent Fees" right={<span className="text-[11px] text-slate-400">{recentFees.length} shown</span>}>
            {recentFees.length === 0 ? (
              <div className="py-6 text-center">
                <DollarSign className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                <p className="text-xs text-slate-400">No fees collected yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {recentFees.map((f) => (
                  <div key={f.id} className="py-2.5 flex justify-between items-center">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">
                        {f.fee_type === 'ramp_onramp' ? 'On-ramp Fee' : f.fee_type === 'ramp_offramp' ? 'Off-ramp Fee' : 'Lock Penalty'}
                      </p>
                      <p className="text-xs text-slate-400">{f.fee_percent}% of {formatNaira(f.gross_amount_kobo)}</p>
                    </div>
                    <p className="text-sm font-semibold text-emerald-600 tabular-nums flex-none ml-2">+{formatNaira(f.fee_amount_kobo)}</p>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  )
}
