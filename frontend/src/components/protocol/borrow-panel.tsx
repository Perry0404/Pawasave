"use client"
import { useState } from "react"
import { ArrowDownCircle, Loader2, Info, ChevronDown } from "lucide-react"
import type { PoolStats, UserPosition, CollateralEntry } from "@/hooks/use-lend-pool"
import { COLLATERAL_TOKENS } from "@/lib/contracts"
import { fmtCngn, fmtUnits, fmtToken, fmtPct, parseUnits } from "@/lib/format"
import { BridgeCollateral } from "./bridge-collateral"

interface Props {
  stats:    PoolStats | null
  position: UserPosition | null
  collateralStatus: Record<string, boolean>  // token key → accepted on-chain
  connected: boolean
  txPending: boolean
  error: string | null
  onDepositCollateral: (token: string, amount: bigint) => Promise<void>
  onWithdrawCollateral:(token: string, amount: bigint) => Promise<void>
  onBorrow: (amount: bigint, tenorDays: number) => Promise<void>
}

const TENORS = [30, 90, 180, 365] as const

/** A row for the selector: every known collateral, enriched with live data. */
type DisplayToken = CollateralEntry & { live: boolean }

export function BorrowPanel({ stats, position, collateralStatus, connected, txPending, error,
  onDepositCollateral, onWithdrawCollateral, onBorrow }: Props) {

  const [step,   setStep]   = useState<"collateral" | "borrow">("collateral")
  const [action, setAction] = useState<"deposit" | "withdraw">("deposit")
  const [amount, setAmount] = useState("")
  const [tenor, setTenor] = useState<number>(90)
  const [tokenKey, setTokenKey] = useState(COLLATERAL_TOKENS[0]?.key ?? "usdc")

  // Merge the full token catalogue with live balances + on-chain accepted status.
  // A token is "live" only if it has an address AND is accepted on the pool.
  const liveByKey = new Map((position?.collaterals ?? []).map(c => [c.key, c]))
  const tokens: DisplayToken[] = COLLATERAL_TOKENS.map(t => {
    const live = liveByKey.get(t.key)
    return {
      ...t,
      deposited:     live?.deposited     ?? 0n,
      walletBalance: live?.walletBalance ?? 0n,
      // Optimistic: a token with a real address is "live" unless the chain
      // EXPLICITLY says not-accepted. A pending/failed read (undefined) won't
      // make live collateral look dead.
      live: !!t.address && collateralStatus[t.key] !== false,
    }
  })
  const token = tokens.find(t => t.key === tokenKey) ?? tokens[0]
  const tokenLive = token?.live ?? false

  const maxColDeposit  = token?.walletBalance ?? 0n
  const maxColWithdraw = token?.deposited     ?? 0n
  const maxBorrow      = position?.borrowLimit ?? 0n
  const currentDebt    = position?.borrowDebt  ?? 0n
  const available      = maxBorrow > currentDebt ? maxBorrow - currentDebt : 0n

  // Block deposits into a not-yet-live token (would revert "Collateral not accepted").
  // Withdraw stays allowed so anyone with a balance can always exit.
  const blockedAction = step === "collateral" && action === "deposit" && !tokenLive

  async function handleSubmit() {
    if (!amount || !token?.address) return
    if (step === "collateral") {
      const parsed = parseUnits(amount, token.decimals)
      if (action === "deposit") await onDepositCollateral(token.address, parsed)
      else await onWithdrawCollateral(token.address, parsed)
    } else {
      await onBorrow(parseUnits(amount, 6), tenor) // cNGN is 6 decimals
    }
    setAmount("")
  }

  return (
    <div className="proto-card">
      <div className="flex items-center justify-between mb-5">
        <h2 className="font-bold text-white text-lg">Borrow cNGN</h2>
        {stats && (
          <div className="text-xs text-orange-400 font-semibold">
            {fmtPct(stats.borrowAPR)} APR
          </div>
        )}
      </div>

      {/* Step tabs */}
      <div className="flex gap-1 bg-gray-800 rounded-xl p-1 mb-5">
        {(["collateral", "borrow"] as const).map((s, i) => (
          <button
            key={s}
            onClick={() => { setStep(s); setAmount("") }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
              step === s ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {i + 1}. {s === "collateral" ? "Collateral" : "Borrow"}
          </button>
        ))}
      </div>

      {step === "collateral" && (
        <>
          {/* Collateral token selector */}
          <label className="label">Collateral asset</label>
          <div className="relative mb-3">
            <select
              value={tokenKey}
              onChange={e => { setTokenKey(e.target.value); setAmount("") }}
              className="proto-input appearance-none pr-10 cursor-pointer"
            >
              {tokens.map(t => (
                <option key={t.key} value={t.key}>
                  {t.symbol} — {t.ltv}% LTV{t.live ? "" : " (coming soon)"}
                </option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-gray-500 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          {!tokenLive ? (
            <p className="text-xs text-amber-400/90 mb-3 -mt-1">
              {token?.symbol} isn’t live yet — coming soon.{token?.note ? ` ${token.note}` : ""}
            </p>
          ) : token?.note ? (
            <p className="text-xs text-gray-500 mb-3 -mt-1">{token.note}</p>
          ) : null}

          <div className="flex gap-1 mb-4">
            {(["deposit", "withdraw"] as const).map(a => (
              <button key={a} onClick={() => { setAction(a); setAmount("") }}
                className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition capitalize ${
                  action === a ? "bg-blue-900 text-blue-300 border border-blue-800" : "text-gray-500 hover:text-gray-400"
                }`}
              >
                {a} {token?.symbol}
              </button>
            ))}
          </div>

          {/* Cross-chain helper: only meaningful for the USDC collateral path. */}
          {token?.key === "usdc" && (
            <BridgeCollateral direction={action === "withdraw" ? "out" : "in"} />
          )}

          <div className="bg-gray-800/50 rounded-xl p-3 mb-4 text-sm text-gray-400 space-y-1">
            <div className="flex justify-between">
              <span>{token?.symbol} posted</span>
              <span className="text-white">{token ? fmtToken(maxColWithdraw, token.decimals, token.symbol) : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span>Total collateral value</span>
              <span className="text-white">{fmtCngn(position?.collateralValue ?? 0n)}</span>
            </div>
            <div className="flex justify-between">
              <span>Borrow limit</span>
              <span className="text-brand-400">{fmtCngn(maxBorrow)}</span>
            </div>
          </div>

          <div className="mb-4">
            <label className="label flex justify-between">
              <span>{token?.symbol} {action}</span>
              <button className="text-brand-400 hover:text-brand-300 text-xs"
                onClick={() => token && setAmount(fmtUnits(
                  action === "deposit" ? maxColDeposit : maxColWithdraw,
                  token.decimals, token.decimals,
                ))}>
                MAX {token ? fmtUnits(action === "deposit" ? maxColDeposit : maxColWithdraw, token.decimals) : "0"}
              </button>
            </label>
            <input className="proto-input" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
        </>
      )}

      {step === "borrow" && (
        <>
          <div className="bg-gray-800/50 rounded-xl p-3 mb-4 text-sm text-gray-400 space-y-1">
            <div className="flex justify-between">
              <span>Available to borrow</span>
              <span className="text-brand-400">{fmtCngn(available)}</span>
            </div>
            <div className="flex justify-between">
              <span>Current debt</span>
              <span className="text-white">{fmtCngn(currentDebt)}</span>
            </div>
            {position && position.dueDate > 0n && (
              <div className="flex justify-between">
                <span>Loan due</span>
                <span className={position.overdue ? "text-red-400 font-semibold" : "text-white"}>
                  {new Date(Number(position.dueDate) * 1000).toLocaleDateString()}
                  {position.overdue ? " · overdue" : ""}
                </span>
              </div>
            )}
            {stats && (
              <div className="flex justify-between">
                <span>Origination fee</span>
                <span className="text-white">{(Number(stats.originationFee)/1e16).toFixed(2)}%</span>
              </div>
            )}
          </div>

          <div className="mb-4">
            <label className="label flex justify-between">
              <span>cNGN to borrow</span>
              <button className="text-brand-400 hover:text-brand-300 text-xs"
                onClick={() => setAmount((Number(available)/1e6).toFixed(2))}>
                MAX {fmtCngn(available)}
              </button>
            </label>
            <input className="proto-input" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          </div>

          <div className="mb-4">
            <label className="label">Loan term</label>
            <div className="grid grid-cols-3 gap-2">
              {TENORS.map(d => (
                <button key={d} onClick={() => setTenor(d)}
                  className={`py-2 rounded-lg text-sm font-semibold transition ${
                    tenor === d ? "bg-brand-600 text-white" : "bg-gray-800 text-gray-400 hover:text-gray-300"
                  }`}>
                  {d} days
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              Repay by the due date. Early repayment is free; after a 4-day grace period an overdue loan can be liquidated.
              {position && position.dueDate > 0n ? " (Term applies to new loans; your existing due date is unchanged.)" : ""}
            </p>
          </div>

          <div className="flex items-start gap-2 bg-orange-950/30 border border-orange-900/50 rounded-xl p-3 mb-4">
            <Info className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-orange-300">
              If collateral value drops below your debt, your position may be liquidated. Keep your health factor safe by maintaining extra collateral.
            </p>
          </div>
        </>
      )}

      {error && <p className="text-red-400 text-sm mb-3 bg-red-950/30 border border-red-900 rounded-xl p-3">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={!connected || !amount || txPending || blockedAction}
        className="proto-btn w-full flex items-center justify-center gap-2"
      >
        {txPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownCircle className="w-4 h-4" />}
        {!connected ? "Connect wallet" : txPending ? "Processing…"
          : blockedAction ? `${token?.symbol ?? "Asset"} coming soon`
          : step === "collateral" ? `${action === "deposit" ? "Deposit" : "Withdraw"} ${token?.symbol ?? "Collateral"}`
          : "Borrow cNGN"}
      </button>
    </div>
  )
}
