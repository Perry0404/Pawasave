"use client"
import { useState, useEffect, useCallback } from "react"
import { ethers } from "ethers"
import { ADDRESSES, LEND_ABI, ERC20_ABI } from "@/lib/contracts"

const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org"

export interface PoolStats {
  totalAssets:    bigint
  totalBorrows:   bigint
  cash:           bigint
  supplyAPY:      bigint  // 1e18-scaled annualised
  borrowAPR:      bigint  // 1e18-scaled annualised
  utilization:    number  // 0–100
  exchangeRate:   bigint
  reserveFactor:  bigint
  collatFactor:   bigint
  originationFee: bigint
  paused:         boolean
}

export interface UserPosition {
  psNgnShares:       bigint   // psNGN held
  suppliedValue:     bigint   // cNGN value of shares
  borrowDebt:        bigint   // cNGN owed
  usdcCollateral:    bigint   // USDC posted
  collateralValue:   bigint   // cNGN value of collateral
  borrowLimit:       bigint   // max cNGN borrowable
  healthy:           boolean
  cngnBalance:       bigint   // wallet cNGN
  usdcBalance:       bigint   // wallet USDC
}

export function useLendPool(address: string | null, signer: ethers.JsonRpcSigner | null) {
  const [stats,    setStats]    = useState<PoolStats | null>(null)
  const [position, setPosition] = useState<UserPosition | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [txPending, setTxPending] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const readProvider = new ethers.JsonRpcProvider(BASE_RPC)
  const lendRO  = ADDRESSES.LEND ? new ethers.Contract(ADDRESSES.LEND, LEND_ABI,  readProvider) : null
  const cngnRO  = new ethers.Contract(ADDRESSES.CNGN,  ERC20_ABI, readProvider)
  const usdcRO  = new ethers.Contract(ADDRESSES.USDC,  ERC20_ABI, readProvider)

  const b = (v: any): bigint => BigInt(v ?? 0)

  const fetchStats = useCallback(async () => {
    if (!lendRO) return
    try {
      const [assets, borrows, cash, supplyAPY, borrowAPR, rate, rf, cf, of, paused] =
        await Promise.all([
          lendRO.totalPoolAssets(),
          lendRO.totalBorrows(),
          lendRO.getCash(),
          lendRO.currentSupplyAPY(),
          lendRO.currentBorrowAPR(),
          lendRO.exchangeRate(),
          lendRO.reserveFactorMantissa(),
          lendRO.collateralFactorMantissa(),
          lendRO.originationFeeMantissa(),
          lendRO.paused(),
        ])
      const ba = b(assets), bb = b(borrows)
      const util = ba > 0n ? Number((bb * 100n) / ba) : 0
      setStats({
        totalAssets: ba, totalBorrows: bb, cash: b(cash),
        supplyAPY: b(supplyAPY), borrowAPR: b(borrowAPR),
        utilization: util, exchangeRate: b(rate),
        reserveFactor: b(rf), collatFactor: b(cf),
        originationFee: b(of), paused: Boolean(paused),
      })
    } catch (e: any) {
      console.error("fetchStats error:", e)
    }
  }, [])

  const fetchPosition = useCallback(async () => {
    if (!address || !lendRO) return
    try {
      const [shares, debt, usdcCol, colVal, limit, healthy, cngnBal, usdcBal] =
        await Promise.all([
          lendRO.balanceOf(address),
          lendRO.borrowBalanceCurrent(address),
          lendRO.collateralBalance(address, ADDRESSES.USDC),
          lendRO.totalCollateralValue(address),
          lendRO.borrowLimit(address),
          lendRO.isHealthy(address),
          cngnRO.balanceOf(address),
          usdcRO.balanceOf(address),
        ])
      const total      = b(await lendRO.totalSupply())
      const poolAssets = b(await lendRO.totalPoolAssets())
      const bShares    = b(shares)
      const suppliedValue = total > 0n ? (bShares * poolAssets) / total : 0n
      setPosition({
        psNgnShares: bShares, suppliedValue,
        borrowDebt: b(debt), usdcCollateral: b(usdcCol),
        collateralValue: b(colVal), borrowLimit: b(limit),
        healthy: Boolean(healthy),
        cngnBalance: b(cngnBal), usdcBalance: b(usdcBal),
      })
    } catch (e: any) {
      console.error("fetchPosition error:", e)
    }
  }, [address])

  const refresh = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchStats(), address ? fetchPosition() : Promise.resolve()])
    setLoading(false)
  }, [fetchStats, fetchPosition, address])

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

  async function depositCollateral(amount: bigint) {
    await run(async () => {
      await ensureApproval(ADDRESSES.USDC, ADDRESSES.LEND, amount)
      const tx = await lendRW().depositCollateral(ADDRESSES.USDC, amount)
      await tx.wait()
    })
  }

  async function withdrawCollateral(amount: bigint) {
    await run(async () => {
      const tx = await lendRW().withdrawCollateral(ADDRESSES.USDC, amount)
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

  return { stats, position, loading, txPending, error, refresh,
    supply, withdrawSupply, depositCollateral, withdrawCollateral, borrow, repay, repayFull }
}
