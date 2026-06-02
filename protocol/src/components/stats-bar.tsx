import { TrendingUp, DollarSign, Activity, Shield } from "lucide-react"
import type { PoolStats } from "@/hooks/use-lend-pool"
import { fmtCngn, fmtPct } from "@/lib/format"

export function StatsBar({ stats, loading }: { stats: PoolStats | null; loading: boolean }) {
  const placeholder = loading ? "—" : "N/A"

  const items = [
    {
      icon: <DollarSign className="w-5 h-5 text-brand-400" />,
      label: "Total Supply (TVL)",
      value: stats ? fmtCngn(stats.totalAssets) : placeholder,
    },
    {
      icon: <TrendingUp className="w-5 h-5 text-emerald-400" />,
      label: "Supply APY",
      value: stats ? fmtPct(stats.supplyAPY) : placeholder,
      highlight: true,
    },
    {
      icon: <Activity className="w-5 h-5 text-orange-400" />,
      label: "Borrow APR",
      value: stats ? fmtPct(stats.borrowAPR) : placeholder,
    },
    {
      icon: <Shield className="w-5 h-5 text-blue-400" />,
      label: "Utilization",
      value: stats ? `${stats.utilization.toFixed(1)}%` : placeholder,
    },
    {
      icon: <DollarSign className="w-5 h-5 text-purple-400" />,
      label: "Total Borrowed",
      value: stats ? fmtCngn(stats.totalBorrows) : placeholder,
    },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
      {items.map((item) => (
        <div key={item.label} className="card flex flex-col gap-2">
          <div className="flex items-center gap-2 text-gray-400">
            {item.icon}
            <span className="text-xs">{item.label}</span>
          </div>
          <p className={`text-lg font-bold ${item.highlight ? "text-brand-400" : "text-white"}`}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  )
}
