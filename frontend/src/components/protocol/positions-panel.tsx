"use client"
import { useState } from "react"
import { CheckCircle, AlertTriangle, Loader2, RefreshCw } from "lucide-react"
import type { UserPosition } from "@/hooks/use-lend-pool"
import { fmtCngn, fmtUsdc, parse6 } from "@/lib/format"

interface Props {
  position:  UserPosition | null
  connected: boolean
  txPending: boolean
  error:     string | null
  onRepay:     (amount: bigint) => Promise<void>
  onRepayFull: () => Promise<void>
  onWithdrawCollateral: (amount: bigint) => Promise<void>
  onWithdrawSupply: (shares: bigint) => Promise<void>
}

export function PositionsPanel({ position, connected, txPending, error,
  onRepay, onRepayFull, onWithdrawCollateral, onWithdrawSupply }: Props) {

  const [repayAmt, setRepayAmt] = useState("")

  const hasSupply = (position?.psNgnShares ?? 0n) > 0n
  const hasDebt   = (position?.borrowDebt  ?? 0n) > 0n
  const hasCollat = (position?.usdcCollateral ?? 0n) > 0n

  if (!connected) {
    return (
      <div className="proto-card flex flex-col items-center justify-center py-12 text-center">
        <div className="w-12 h-12 bg-gray-800 rounded-full flex items-center justify-center mb-3">
          <RefreshCw className="w-6 h-6 text-gray-500" />
        </div>
        <p className="text-gray-400 font-medium">Connect your wallet</p>
        <p className="text-gray-600 text-sm mt-1">to view your positions</p>
      </div>
    )
  }

  if (!hasSupply && !hasDebt && !hasCollat) {
    return (
      <div className="proto-card flex flex-col items-center justify-center py-10 text-center">
        <p className="text-gray-400 font-medium">No open positions</p>
        <p className="text-gray-600 text-sm mt-1">Supply cNGN to earn yield or borrow against USDC</p>
      </div>
    )
  }

  return (
    <div className="proto-card space-y-5">
      <h2 className="font-bold text-white text-lg">Your Positions</h2>

      {/* Supply position */}
      {hasSupply && position && (
        <div className="bg-brand-900/20 border border-brand-800/50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-brand-300">Supplying (Earning)</p>
            <CheckCircle className="w-4 h-4 text-brand-400" />
          </div>
          <p className="text-2xl font-bold text-white mb-1">{fmtCngn(position.suppliedValue)}</p>
          <p className="text-xs text-gray-400">{(Number(position.psNgnShares)/1e6).toFixed(4)} psNGN shares</p>
          <button
            onClick={() => onWithdrawSupply(position.psNgnShares)}
            disabled={txPending}
            className="proto-outline text-sm mt-3 w-full"
          >
            {txPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Withdraw All"}
          </button>
        </div>
      )}

      {/* Borrow position */}
      {(hasDebt || hasCollat) && position && (
        <div className={`border rounded-xl p-4 ${
          position.healthy
            ? "bg-gray-800/30 border-gray-700"
            : "bg-red-950/20 border-red-900"
        }`}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-300">Borrow Position</p>
            {position.healthy
              ? <CheckCircle className="w-4 h-4 text-brand-400" />
              : <AlertTriangle className="w-4 h-4 text-red-400" />
            }
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Debt</p>
              <p className="font-semibold text-white">{fmtCngn(position.borrowDebt)}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Collateral (USDC)</p>
              <p className="font-semibold text-white">{fmtUsdc(position.usdcCollateral)}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Collateral Value</p>
              <p className="font-semibold text-white">{fmtCngn(position.collateralValue)}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Borrow Limit</p>
              <p className="font-semibold text-brand-400">{fmtCngn(position.borrowLimit)}</p>
            </div>
          </div>

          {!position.healthy && (
            <div className="flex items-center gap-2 bg-red-950/40 text-red-300 text-xs p-2.5 rounded-lg mb-3">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Position at risk of liquidation — repay debt immediately
            </div>
          )}

          {hasDebt && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input
                  className="proto-input text-sm flex-1"
                  placeholder="Repay amount"
                  value={repayAmt}
                  onChange={e => setRepayAmt(e.target.value.replace(/[^0-9.]/g, ""))}
                />
                <button
                  onClick={() => onRepay(parse6(repayAmt))}
                  disabled={!repayAmt || txPending}
                  className="proto-outline text-sm px-3"
                >
                  {txPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Repay"}
                </button>
              </div>
              <button
                onClick={onRepayFull}
                disabled={txPending}
                className="proto-btn w-full text-sm"
              >
                {txPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Repay Full + Reclaim Collateral"}
              </button>
            </div>
          )}

          {!hasDebt && hasCollat && (
            <button
              onClick={() => onWithdrawCollateral(position.usdcCollateral)}
              disabled={txPending}
              className="proto-outline w-full text-sm"
            >
              Withdraw Collateral
            </button>
          )}
        </div>
      )}

      {error && <p className="text-red-400 text-sm bg-red-950/30 border border-red-900 rounded-xl p-3">{error}</p>}
    </div>
  )
}
