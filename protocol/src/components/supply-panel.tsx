"use client"
import { useState } from "react"
import { ArrowDownCircle, ArrowUpCircle, Loader2, TrendingUp } from "lucide-react"
import type { PoolStats, UserPosition } from "@/hooks/use-lend-pool"
import { fmtCngn, fmtPct, parse6 } from "@/lib/format"

interface Props {
  stats:    PoolStats | null
  position: UserPosition | null
  connected: boolean
  txPending: boolean
  error: string | null
  onSupply: (amount: bigint) => Promise<void>
  onWithdraw: (shares: bigint) => Promise<void>
}

export function SupplyPanel({ stats, position, connected, txPending, error, onSupply, onWithdraw }: Props) {
  const [tab, setTab]       = useState<"supply" | "withdraw">("supply")
  const [amount, setAmount] = useState("")

  const maxSupply   = position?.cngnBalance   ?? 0n
  const maxWithdraw = position?.psNgnShares   ?? 0n

  async function handleSubmit() {
    if (!amount) return
    const parsed = parse6(amount)
    if (tab === "supply")   await onSupply(parsed)
    else                     await onWithdraw(parsed)
    setAmount("")
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-bold text-white text-lg">Earn Yield</h2>
        {stats && (
          <div className="flex items-center gap-1.5 bg-brand-900/50 border border-brand-800 rounded-full px-3 py-1">
            <TrendingUp className="w-3.5 h-3.5 text-brand-400" />
            <span className="text-brand-400 text-xs font-semibold">{fmtPct(stats.supplyAPY)} APY</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-800 rounded-xl p-1 mb-5">
        {(["supply", "withdraw"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setAmount("") }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition capitalize ${
              tab === t ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {t === "supply" ? "Supply cNGN" : "Withdraw"}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="mb-4">
        <label className="label flex justify-between">
          <span>{tab === "supply" ? "Amount to supply" : "psNGN shares to redeem"}</span>
          {connected && (
            <button
              className="text-brand-400 hover:text-brand-300"
              onClick={() => setAmount(tab === "supply"
                ? (Number(maxSupply) / 1e6).toString()
                : (Number(maxWithdraw) / 1e6).toString()
              )}
            >
              MAX {tab === "supply"
                ? fmtCngn(maxSupply)
                : `${(Number(maxWithdraw)/1e6).toFixed(2)} psNGN`
              }
            </button>
          )}
        </label>
        <input
          className="input"
          placeholder="0.00"
          value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </div>

      {/* Info */}
      {tab === "supply" && position && position.suppliedValue > 0n && (
        <div className="bg-gray-800/50 rounded-xl p-3 mb-4 text-sm text-gray-400 space-y-1">
          <div className="flex justify-between">
            <span>Currently supplying</span>
            <span className="text-white">{fmtCngn(position.suppliedValue)}</span>
          </div>
          <div className="flex justify-between">
            <span>psNGN shares</span>
            <span className="text-white">{(Number(position.psNgnShares)/1e6).toFixed(4)}</span>
          </div>
        </div>
      )}

      {error && <p className="text-red-400 text-sm mb-3 bg-red-950/30 border border-red-900 rounded-xl p-3">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={!connected || !amount || txPending}
        className="btn-primary w-full flex items-center justify-center gap-2"
      >
        {txPending ? <Loader2 className="w-4 h-4 animate-spin" /> : tab === "supply" ? <ArrowDownCircle className="w-4 h-4" /> : <ArrowUpCircle className="w-4 h-4" />}
        {!connected ? "Connect wallet" : txPending ? "Processing…" : tab === "supply" ? "Supply cNGN" : "Withdraw"}
      </button>

      <p className="text-xs text-gray-500 text-center mt-3">
        Receive psNGN yield-bearing shares · Redeem anytime (subject to liquidity)
      </p>
    </div>
  )
}
