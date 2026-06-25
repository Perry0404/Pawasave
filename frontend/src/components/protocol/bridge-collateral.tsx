"use client"
import { ArrowLeftRight, ExternalLink } from "lucide-react"
import { CONTRACTS } from "@/lib/contracts"

/**
 * BridgeCollateral — self-serve cross-chain on/off-ramp for collateral.
 *
 * Borrowers holding a token on another chain (e.g. MRLN on Arbitrum) can swap +
 * bridge it to USDC on Base, then post it as collateral and borrow cNGN. On
 * repay, they bridge the withdrawn USDC back to their own chain/token.
 *
 * This is NON-CUSTODIAL: it just deep-links into LI.FI's hosted app (Jumper)
 * with the route pre-filled. The borrower bridges from/to THEIR OWN wallet — we
 * never touch the bridge or hold their funds. The only invariant we lock is that
 * the inbound route must DELIVER USDC on Base (the accepted collateral).
 *
 * Override the host with NEXT_PUBLIC_BRIDGE_URL (defaults to jumper.exchange).
 * Upgrade path: swap this deep-link for the embedded @lifi/widget later if we
 * want it fully in-app (it pulls in wagmi/viem, so kept out of the bundle now).
 */
const BASE_CHAIN = 8453
const ARBITRUM_CHAIN = 42161 // sensible default source (the MRLN example); user can change
const BRIDGE_HOST = process.env.NEXT_PUBLIC_BRIDGE_URL || "https://jumper.exchange"
const INTEGRATOR = "pawasave"

function bridgeUrl(direction: "in" | "out"): string {
  const usdc = CONTRACTS.USDC
  const p = new URLSearchParams({ integrator: INTEGRATOR })
  if (direction === "in") {
    // any token / any chain  →  USDC on Base (to deposit as collateral)
    p.set("toChain", String(BASE_CHAIN))
    p.set("toToken", usdc)
    p.set("fromChain", String(ARBITRUM_CHAIN))
  } else {
    // USDC on Base  →  any token / any chain (after repay + withdraw)
    p.set("fromChain", String(BASE_CHAIN))
    p.set("fromToken", usdc)
  }
  return `${BRIDGE_HOST}/?${p.toString()}`
}

export function BridgeCollateral({ direction = "in" }: { direction?: "in" | "out" }) {
  const inbound = direction === "in"
  return (
    <a
      href={bridgeUrl(direction)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 bg-gray-800/50 hover:bg-gray-800 border border-gray-700 hover:border-brand-700 rounded-xl p-3 mb-4 transition group"
    >
      <div className="w-8 h-8 rounded-lg bg-brand-900/60 flex items-center justify-center flex-shrink-0">
        <ArrowLeftRight className="w-4 h-4 text-brand-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">
          {inbound ? "Bring collateral from another chain" : "Bridge USDC back to your chain"}
        </p>
        <p className="text-xs text-gray-400 truncate">
          {inbound
            ? "Swap any token (e.g. MRLN on Arbitrum) → USDC on Base, then deposit it below."
            : "Send your withdrawn USDC from Base back to any token/chain."}
        </p>
      </div>
      <ExternalLink className="w-4 h-4 text-gray-500 group-hover:text-brand-400 flex-shrink-0" />
    </a>
  )
}