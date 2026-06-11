"use client"
import { useState, useEffect, useCallback } from "react"
import { ethers } from "ethers"
import { ADDRESSES, LEND_ABI, ERC20_ABI, CONFIGURED_COLLATERAL, type CollateralToken } from "@/lib/contracts"

// The public mainnet.base.org endpoint aggressively rate-limits the burst of
// read calls this hook makes on load, dropping ~30–100% of them — which made
// pool stats show "N/A" and live collateral show "coming soon". We instead use
// a FallbackProvider across several reliable public endpoints (quorum 1: first
// success wins, automatically routes around a flaky/dead node). Override with a
// dedicated endpoint (Alchemy/QuickNode) by setting NEXT_PUBLIC_BASE_RPC_URL —
// comma-separated for multiple.
const DEFAULT_BASE_RPCS = [
  "https://base.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://base.gateway.tenderly.co",
]

let _readProvider: ethers.AbstractProvider | null = null
function getReadProvider(): ethers.AbstractProvider {
  if (_readProvider) return _readProvider
  const env  = process.env.NEXT_PUBLIC_BASE_RPC_URL
  const urls = (env ? env.split(",") : DEFAULT_BASE_RPCS).map(s => s.trim()).filter(Boolean)
  if (urls.length === 1) {
    _readProvider = new ethers.JsonRpcProvider(urls[0], 8453, { staticNetwork: true })
  } else {
    _readProvider = new ethers.FallbackProvider(
      urls.map((url, i) => ({
        provider: new ethers.JsonRpcProvider(url, 8453, { staticNetwork: true }),
        priority: i + 1, stallTimeout: 2000, weight: 1,
      })),
      8453,
      { quorum: 1 },
    )
  }
  return _readProvider
}

export interface PoolStats {
  totalAssets:    bigint
  totalBorrows:   bigint
  cash:           bigint
  supplyAPY:      bigint  // 1e18-scaled annualised
  borrowAPR:      bigint  // 1e18-scaled annualised
  utilization:    number  // 0–100
  exchangeRate:   bigint
  reserveFactor:  bigint
  originationFee: bigint
  paused:         boolean
}

/** One collateral token's state for the connected wallet */
export interface CollateralEntry extends CollateralToken {
  deposited:     bigint   // amount posted as collateral
  walletBalance: bigint   // amount held in wallet
}

export interface UserPosition {
  psNgnShares:       bigint            // psNGN held
  suppliedValue:     bigint            // cNGN value of shares
  borrowDebt:        bigint            // cNGN owed
  collateralValue:   bigint            // aggregate cNGN value of all collateral (from contract)
  borrowLimit:       bigint            // max cNGN borrowable (from contract, per-token LTV applied)
  healthy:           boolean
  cngnBalance:       bigint            // wallet cNGN (for supplying)
  collaterals:       CollateralEntry[] // per-token collateral + wallet balances
}

export function useLendPool(address: string | null, signer: ethers.JsonRpcSigner | null) {
  const [stats,    setStats]    = useState<PoolStats | null>(null)
  const [position, setPosition] = useState<UserPosition | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [txPending, setTxPending] = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  // Per-token on-chain status: token key → accepted as collateral on the pool.
  // Fetched independently of the connected wallet so the UI can show live vs
  // "coming soon" before connecting.
  const [collateralStatus, setCollateralStatus] = useState<Record<string, boolean>>({})

  const readProvider = getReadProvider()
  const lendRO  = ADDRESSES.LEND ? new ethers.Contract(ADDRESSES.LEND, LEND_ABI,  readProvider) : null
  const cngnRO  = new ethers.Contract(ADDRESSES.CNGN,  ERC20_ABI, readProvider)

  const b = (v: any): bigint => BigInt(v ?? 0)

  const fetchStats = useCallback(async () => {
    if (!lendRO) return
    // Each read resolves independently: a single dropped call can no longer
    // reject the whole batch and blank the stats bar. Defaults are the values
    // an empty/healthy pool returns. (collateralFactorMantissa was removed — the
    // contract uses per-token factors, so that global getter doesn't exist.)
    const r = async <T,>(p: Promise<T>, d: T): Promise<T> => { try { return await p } catch { return d } }
    try {
      const [assets, borrows, cash, supplyAPY, borrowAPR, rate, rf, of, paused] =
        await Promise.all([
          r(lendRO.totalPoolAssets(),       0n),
          r(lendRO.totalBorrows(),          0n),
          r(lendRO.getCash(),               0n),
          r(lendRO.currentSupplyAPY(),      0n),
          r(lendRO.currentBorrowAPR(),      0n),
          r(lendRO.exchangeRate(),          1000000n),
          r(lendRO.reserveFactorMantissa(), 0n),
          r(lendRO.originationFeeMantissa(),0n),
          r(lendRO.paused(),                false),
        ])
      const ba = b(assets), bb = b(borrows)
      const util = ba > 0n ? Number((bb * 100n) / ba) : 0
      setStats({
        totalAssets: ba, totalBorrows: bb, cash: b(cash),
        supplyAPY: b(supplyAPY), borrowAPR: b(borrowAPR),
        utilization: util, exchangeRate: b(rate),
        reserveFactor: b(rf),
        originationFee: b(of), paused: Boolean(paused),
      })
    } catch (e: any) {
      console.error("fetchStats error:", e)
    }
  }, [])

  // Which configured tokens are actually accepted as collateral on-chain.
  const fetchCollateralStatus = useCallback(async () => {
    if (!lendRO) return
    try {
      const entries = await Promise.all(
        CONFIGURED_COLLATERAL.map(async (tok) => {
          try {
            const info = await lendRO.collaterals(tok.address)
            return [tok.key, Boolean(info.accepted)] as const
          } catch {
            // Read failed (e.g. public RPC rate-limited the burst) — return null
            // so we DON'T record a false. The UI stays optimistic for tokens that
            // have an address; only a confirmed `false` marks them "coming soon".
            return null
          }
        })
      )
      const ok = entries.filter((e): e is readonly [string, boolean] => e !== null)
      setCollateralStatus(prev => ({ ...prev, ...Object.fromEntries(ok) }))
    } catch (e: any) {
      console.error("fetchCollateralStatus error:", e)
    }
  }, [])

  const fetchPosition = useCallback(async () => {
    if (!address || !lendRO) return
    try {
      // Per-token collateral + wallet balances for every configured token
      const collaterals: CollateralEntry[] = await Promise.all(
        CONFIGURED_COLLATERAL.map(async (tok) => {
          const token = new ethers.Contract(tok.address, ERC20_ABI, readProvider)
          const [deposited, walletBalance] = await Promise.all([
            lendRO.collateralBalance(address, tok.address).catch(() => 0n),
            token.balanceOf(address).catch(() => 0n),
          ])
          return { ...tok, deposited: b(deposited), walletBalance: b(walletBalance) }
        })
      )

      const [shares, debt, colVal, limit, healthy] = await Promise.all([
        lendRO.balanceOf(address),
        lendRO.borrowBalanceCurrent(address).catch(() => 0n),
        lendRO.totalCollateralValue(address).catch(() => 0n),
        lendRO.borrowLimit(address).catch(() => 0n),
        lendRO.isHealthy(address).catch(() => true),
      ])

      const total      = b(await lendRO.totalSupply())
      const poolAssets = b(await lendRO.totalPoolAssets())
      const bShares    = b(shares)
      const suppliedValue = total > 0n ? (bShares * poolAssets) / total : 0n

      // wallet cNGN for the supply panel
      const cngnBalance = collaterals.find(c => c.key === "cngn")?.walletBalance
        ?? b(await cngnRO.balanceOf(address))

      setPosition({
        psNgnShares: bShares, suppliedValue,
        borrowDebt: b(debt),
        collateralValue: b(colVal), borrowLimit: b(limit),
        healthy: Boolean(healthy),
        cngnBalance,
        collaterals,
      })
    } catch (e: any) {
      console.error("fetchPosition error:", e)
    }
  }, [address])

  const refresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([
      fetchStats(),
      fetchCollateralStatus(),
      address ? fetchPosition() : Promise.resolve(),
    ])
    setLoading(false)
  }, [fetchStats, fetchCollateralStatus, fetchPosition, address])

  useEffect(() => { refresh() }, [address])

  // ── Write helpers ───────────────────────────────────────────────────────────

  async function ensureApproval(tokenAddr: string, spender: string, amount: bigint) {
    if (!signer) throw new Error("Wallet not connected")
    const token   = new ethers.Contract(tokenAddr, ERC20_ABI, signer)
    const current = await token.allowance(await signer.getAddress(), spender)
    if (current < amount) {
      const tx = await token.approve(spender, amount)
      await tx.wait()
    }
  }

  const lendRW = () => {
    if (!signer) throw new Error("Wallet not connected")
    return new ethers.Contract(ADDRESSES.LEND, LEND_ABI, signer)
  }

  const run = useCallback(async (fn: () => Promise<void>) => {
    setTxPending(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e: any) {
      const msg = e?.reason || e?.message || "Transaction failed"
      setError(msg.includes("execution reverted") ? msg.split("execution reverted:")[1]?.trim() || msg : msg)
    } finally {
      setTxPending(false)
    }
  }, [refresh])

  async function supply(amount: bigint) {
    await run(async () => {
      await ensureApproval(ADDRESSES.CNGN, ADDRESSES.LEND, amount)
      const tx = await lendRW().supply(amount)
      await tx.wait()
    })
  }

  async function withdrawSupply(shares: bigint) {
    await run(async () => {
      const tx = await lendRW().withdraw(shares)
      await tx.wait()
    })
  }

  async function depositCollateral(token: string, amount: bigint) {
    await run(async () => {
      await ensureApproval(token, ADDRESSES.LEND, amount)
      const tx = await lendRW().depositCollateral(token, amount)
      await tx.wait()
    })
  }

  async function withdrawCollateral(token: string, amount: bigint) {
    await run(async () => {
      const tx = await lendRW().withdrawCollateral(token, amount)
      await tx.wait()
    })
  }

  async function borrow(amount: bigint) {
    await run(async () => {
      const tx = await lendRW().borrow(amount)
      await tx.wait()
    })
  }

  async function repay(amount: bigint) {
    await run(async () => {
      await ensureApproval(ADDRESSES.CNGN, ADDRESSES.LEND, amount)
      const tx = await lendRW().repay(address!, amount)
      await tx.wait()
    })
  }

  async function repayFull() {
    await run(async () => {
      const debt = await lendRO!.borrowBalanceCurrent(address!)
      const buffer = debt / 1000n + 1000n
      await ensureApproval(ADDRESSES.CNGN, ADDRESSES.LEND, debt + buffer)
      const tx = await lendRW().repay(address!, 2n ** 256n - 1n)
      await tx.wait()
    })
  }

  return { stats, position, collateralStatus, loading, txPending, error, refresh,
    supply, withdrawSupply, depositCollateral, withdrawCollateral, borrow, repay, repayFull }
}
