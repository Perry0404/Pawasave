'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, TrendingUp, Users, Lock, Target, DollarSign, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'

const supabase = createClient()

interface RevenueSummaryDaily {
  date: string
  revenue_type: string
  count: number
  total_usdc_micro: number
  total_usdc: number
}

interface RevenueSummaryMonthly {
  date: string
  revenue_type: string
  count: number
  total_usdc_micro: number
  total_usdc: number
}

interface RevenueByType {
  revenue_type: string
  count: number
  total_usdc_micro: number
  total_usdc: number
  avg_usdc: number
}

interface PlatformMetrics {
  total_users: number
  active_locks: number
  active_goals: number
  completed_transactions: number
  total_revenue_usdc: number
}

export default function RevenuePage() {
  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null)
  const [revenueByType, setRevenueByType] = useState<RevenueByType[]>([])
  const [monthlyRevenue, setMonthlyRevenue] = useState<RevenueSummaryMonthly[]>([])
  const [dailyRevenue, setDailyRevenue] = useState<RevenueSummaryDaily[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch platform metrics
        const { data: metricsData } = await supabase
          .from('platform_metrics')
          .select('*')
          .limit(1)
          .single()

        if (metricsData) setMetrics(metricsData)

        // Fetch revenue by type
        const { data: typeData } = await supabase
          .from('revenue_by_type')
          .select('*')
          .order('total_usdc_micro', { ascending: false })

        if (typeData) setRevenueByType(typeData)

        // Fetch monthly revenue
        const { data: monthlyData } = await supabase
          .from('revenue_summary_monthly')
          .select('*')
          .order('date', { ascending: false })
          .limit(12)

        if (monthlyData) setMonthlyRevenue(monthlyData)

        // Fetch daily revenue (last 30 days)
        const { data: dailyData } = await supabase
          .from('revenue_summary_daily')
          .select('*')
          .order('date', { ascending: false })
          .limit(30)

        if (dailyData) setDailyRevenue(dailyData)
      } catch (error) {
        console.error('Failed to fetch revenue data:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 60000) // Refresh every minute
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="min-h-dvh bg-slate-50">
        <header className="bg-slate-900 px-5 pt-4 pb-3 flex items-center gap-2.5 sticky top-0 z-50">
          <Link href="/admin" className="flex items-center gap-2.5 hover:opacity-80 transition">
            <ArrowLeft className="w-5 h-5 text-slate-400" />
            <div>
              <p className="text-white text-sm font-bold tracking-tight">Revenue Dashboard</p>
              <p className="text-slate-500 text-[11px]">Platform Analytics</p>
            </div>
          </Link>
        </header>
        <main className="max-w-6xl mx-auto p-5 pb-10">
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="bg-slate-900 px-5 pt-4 pb-3 flex items-center gap-2.5 sticky top-0 z-50">
        <Link href="/admin" className="flex items-center gap-2.5 hover:opacity-80 transition">
          <ArrowLeft className="w-5 h-5 text-slate-400" />
          <div>
            <p className="text-white text-sm font-bold tracking-tight">Revenue Dashboard</p>
            <p className="text-slate-500 text-[11px]">Platform Analytics & Metrics</p>
          </div>
        </Link>
      </header>

      <main className="max-w-6xl mx-auto p-5 pb-10">
        {/* Key Metrics Grid */}
        {metrics && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-500 text-xs font-medium mb-1">Total Revenue</p>
                  <p className="text-2xl font-bold text-slate-900">₦{(metrics.total_revenue_usdc || 0).toFixed(2)}</p>
                </div>
                <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center">
                  <DollarSign className="w-6 h-6 text-emerald-600" />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-500 text-xs font-medium mb-1">Total Users</p>
                  <p className="text-2xl font-bold text-slate-900">{metrics.total_users}</p>
                </div>
                <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                  <Users className="w-6 h-6 text-blue-600" />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-500 text-xs font-medium mb-1">Active Locks</p>
                  <p className="text-2xl font-bold text-slate-900">{metrics.active_locks}</p>
                </div>
                <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
                  <Lock className="w-6 h-6 text-purple-600" />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-500 text-xs font-medium mb-1">Active Goals</p>
                  <p className="text-2xl font-bold text-slate-900">{metrics.active_goals}</p>
                </div>
                <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center">
                  <Target className="w-6 h-6 text-orange-600" />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-500 text-xs font-medium mb-1">Transactions</p>
                  <p className="text-2xl font-bold text-slate-900">{metrics.completed_transactions}</p>
                </div>
                <div className="w-12 h-12 bg-teal-100 rounded-xl flex items-center justify-center">
                  <TrendingUp className="w-6 h-6 text-teal-600" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Revenue by Type */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-8">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="text-lg font-bold text-slate-900">Revenue by Type</h2>
            <p className="text-sm text-slate-500 mt-1">Total revenue breakdown by category</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-600">Type</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Count</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Total (cNGN)</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Average</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {revenueByType.map((row) => (
                  <tr key={row.revenue_type} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4 text-sm font-medium text-slate-900">
                      {formatRevenueType(row.revenue_type)}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600 text-right">{row.count}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-slate-900 text-right">
                      ₦{row.total_usdc.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600 text-right">₦{row.avg_usdc.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Monthly Revenue Trend */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-8">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="text-lg font-bold text-slate-900">Monthly Revenue Trend</h2>
            <p className="text-sm text-slate-500 mt-1">Last 12 months breakdown</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-600">Month</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-600">Type</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Count</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Total (cNGN)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {monthlyRevenue.map((row) => (
                  <tr key={`${row.date}-${row.revenue_type}`} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4 text-sm font-medium text-slate-900">
                      {new Date(row.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{formatRevenueType(row.revenue_type)}</td>
                    <td className="px-6 py-4 text-sm text-slate-600 text-right">{row.count}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-slate-900 text-right">
                      ₦{row.total_usdc.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Daily Revenue (Last 30 days) */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="border-b border-slate-200 px-6 py-4">
            <h2 className="text-lg font-bold text-slate-900">Daily Revenue (Last 30 Days)</h2>
            <p className="text-sm text-slate-500 mt-1">Recent daily revenue activity</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-600">Type</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Count</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-600">Total (cNGN)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {dailyRevenue.slice(0, 50).map((row) => (
                  <tr key={`${row.date}-${row.revenue_type}`} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4 text-sm font-medium text-slate-900">
                      {new Date(row.date).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{formatRevenueType(row.revenue_type)}</td>
                    <td className="px-6 py-4 text-sm text-slate-600 text-right">{row.count}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-slate-900 text-right">
                      ₦{row.total_usdc.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}

function formatRevenueType(type: string): string {
  const map: Record<string, string> = {
    platform_fee: 'Platform Fee',
    lock_interest_forfeited: 'Lock Interest Forfeited',
    goal_interest_forfeited: 'Goal Interest Forfeited',
    yield_spread: 'Yield Spread',
  }
  return map[type] || type
}
