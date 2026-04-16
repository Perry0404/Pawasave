'use client'

import { useState, useEffect } from 'react'
import { formatNaira, formatUsdc } from '@/lib/format'
import {
  getAdminFeeSummary, getAdminUserStats, getAdminTxVolume,
  getAdminRecentFees
} from '@/hooks/use-data'
import type { AdminFeeSummary, AdminUserStats, AdminTxVolume, PlatformFee } from '@/lib/types'
import { Shield, DollarSign, Users, Activity, TrendingUp, Loader2, Lock, AlertTriangle, ArrowUpRight, ArrowDownLeft, Eye, EyeOff, LogOut } from 'lucide-react'

const ADMIN_STORAGE_KEY = 'pawa_admin_auth'

export default function AdminView() {
  const [authed, setAuthed] = useState(false)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [authError, setAuthError] = useState('')
  const [fees, setFees] = useState<AdminFeeSummary | null>(null)
  const [users, setUsers] = useState<AdminUserStats | null>(null)
  const [volume, setVolume] = useState<AdminTxVolume | null>(null)
  const [recentFees, setRecentFees] = useState<PlatformFee[]>([])
  const [loading, setLoading] = useState(true)

  // Check session storage for existing auth
  useEffect(() => {
    const stored = sessionStorage.getItem(ADMIN_STORAGE_KEY)
    if (stored === 'true') {
      setAuthed(true)
    } else {
      setLoading(false)
    }
  }, [])

  // Load data once authed
  useEffect(() => {
    if (!authed) return
    const load = async () => {
      setLoading(true)
      const [f, u, v, rf] = await Promise.all([
        getAdminFeeSummary(),
        getAdminUserStats(),
        getAdminTxVolume(),
        getAdminRecentFees(30),
      ])
      setFees(f)
      setUsers(u)
      setVolume(v)
      setRecentFees(rf)
      setLoading(false)
    }
    load()
  }, [authed])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    // Verify via API route
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

  const handleLogout = () => {
    sessionStorage.removeItem(ADMIN_STORAGE_KEY)
    setAuthed(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    )
  }

  // Login screen
  if (!authed) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm">
          <div className="text-center mb-6">
            <Shield className="w-12 h-12 text-emerald-600 mx-auto mb-3" />
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
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400"
            >
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {authError && (
            <p className="text-sm text-red-600 mb-3 text-center">{authError}</p>
          )}
          <button
            type="submit"
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-3.5 rounded-xl transition"
          >
            Access Dashboard
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="px-4 pt-5 pb-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-emerald-600" />
          <h1 className="text-lg font-bold text-slate-900">Admin Dashboard</h1>
        </div>
        <button onClick={handleLogout} className="text-slate-400 hover:text-slate-600 p-2 transition">
          <LogOut className="w-4 h-4" />
        </button>
      </div>

      {/* Revenue Card */}
      <div className="bg-gradient-to-br from-emerald-600 to-teal-700 rounded-2xl p-5 text-white mb-4">
        <div className="flex items-center gap-2 mb-3">
          <DollarSign className="w-4 h-4 text-emerald-200" />
          <p className="text-emerald-200 text-xs font-medium uppercase tracking-wider">Total Revenue</p>
        </div>
        <p className="text-3xl font-bold tracking-tight">{formatNaira(fees?.total_fees_kobo || 0)}</p>
        <div className="flex items-center gap-6 mt-4 pt-3 border-t border-white/10 text-xs">
          <div>
            <p className="text-emerald-300">Today</p>
            <p className="font-semibold mt-0.5">{formatNaira(fees?.today_fees_kobo || 0)}</p>
          </div>
          <div>
            <p className="text-emerald-300">This Month</p>
            <p className="font-semibold mt-0.5">{formatNaira(fees?.this_month_fees_kobo || 0)}</p>
          </div>
          <div>
            <p className="text-emerald-300">Transactions</p>
            <p className="font-semibold mt-0.5">{fees?.fee_count || 0}</p>
          </div>
        </div>
      </div>

      {/* Fee Breakdown */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white rounded-xl border border-slate-200 p-3.5">
          <ArrowDownLeft className="w-4 h-4 text-emerald-500 mb-1.5" />
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">On-ramp</p>
          <p className="text-sm font-bold text-slate-800 mt-0.5">{formatNaira(fees?.total_onramp_fees || 0)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3.5">
          <ArrowUpRight className="w-4 h-4 text-orange-500 mb-1.5" />
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Off-ramp</p>
          <p className="text-sm font-bold text-slate-800 mt-0.5">{formatNaira(fees?.total_offramp_fees || 0)}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3.5">
          <Lock className="w-4 h-4 text-purple-500 mb-1.5" />
          <p className="text-[10px] text-slate-500 uppercase tracking-wider">Penalties</p>
          <p className="text-sm font-bold text-slate-800 mt-0.5">{formatNaira(fees?.total_penalty_fees || 0)}</p>
        </div>
      </div>

      {/* Platform Stats */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <Users className="w-4 h-4 text-blue-500 mb-2" />
          <p className="text-xs text-slate-500">Total Users</p>
          <p className="text-xl font-bold text-slate-800">{users?.total_users || 0}</p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <Activity className="w-4 h-4 text-violet-500 mb-2" />
          <p className="text-xs text-slate-500">Total Transactions</p>
          <p className="text-xl font-bold text-slate-800">{volume?.total_tx_count || 0}</p>
          {(volume?.pending_count || 0) > 0 && (
            <p className="text-[10px] text-amber-600 mt-0.5">{volume!.pending_count} pending</p>
          )}
        </div>
      </div>

      {/* Volume & TVL */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-slate-600" />
          <p className="text-sm font-semibold text-slate-800">Platform TVL</p>
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-slate-500">Naira Balances</p>
            <p className="font-bold text-slate-800">{formatNaira(users?.total_naira_kobo || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">USDC Vaults</p>
            <p className="font-bold text-slate-800">{formatUsdc(users?.total_usdc_micro || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Locked USDC</p>
            <p className="font-bold text-slate-800">{formatUsdc(users?.total_locked_usdc_micro || 0)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Active Locks</p>
            <p className="font-bold text-slate-800">{users?.active_locks || 0}</p>
          </div>
        </div>
      </div>

      {/* Transaction Volume */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <p className="text-sm font-semibold text-slate-800 mb-3">Transaction Volume</p>
        <div className="space-y-2.5 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Total Deposits</span>
            <span className="font-semibold text-emerald-600">{formatNaira(volume?.total_deposits_kobo || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Total Withdrawals</span>
            <span className="font-semibold text-orange-600">{formatNaira(volume?.total_withdrawals_kobo || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Vault Saves</span>
            <span className="font-semibold text-blue-600">{formatNaira(volume?.total_vault_saves_kobo || 0)}</span>
          </div>
        </div>
      </div>

      {/* Recent Fees */}
      <h3 className="text-sm font-semibold text-slate-800 mb-2">Recent Fees</h3>
      {recentFees.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">No fees collected yet</p>
      ) : (
        <div className="space-y-2">
          {recentFees.map((f) => (
            <div key={f.id} className="bg-white px-4 py-3 rounded-xl border border-slate-200 flex justify-between items-center">
              <div>
                <p className="text-sm font-medium text-slate-700">
                  {f.fee_type === 'ramp_onramp' ? 'On-ramp Fee' :
                   f.fee_type === 'ramp_offramp' ? 'Off-ramp Fee' : 'Lock Penalty'}
                </p>
                <p className="text-xs text-slate-400">
                  {f.fee_percent}% of {formatNaira(f.gross_amount_kobo)}
                </p>
              </div>
              <p className="text-sm font-semibold text-emerald-600">+{formatNaira(f.fee_amount_kobo)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
