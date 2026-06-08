import { NextRequest, NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { getNgnUsdRateFromFlipeet } from '@/lib/ramp-rate'

/**
 * GET /api/cron/update-oracle
 *
 * Pushes the live NGN/USD price for the USD-stable collateral tokens (USDC, USDT)
 * to the PriceOracle so the lending pool never serves a stale price. The oracle
 * rejects prices older than 1 hour, so this must run well under hourly — it's
 * scheduled every 30 min in vercel.json.
 *
 * RWAs / T-bills are NOT priced here — they need their own per-asset NAV feed.
 *
 * Required env vars:
 *   BASE_MAINNET_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL)
 *   ORACLE_KEEPER_PRIVATE_KEY   — keeper wallet (authorised on PriceOracle)
 *   PRICE_ORACLE_ADDRESS        — deployed PriceOracle
 *   USDC_TOKEN_ADDRESS          — defaults to Base USDC
 *   USDT_TOKEN_ADDRESS          — defaults to Base USDT
 *   CRON_SECRET                 — Vercel cron secret
 */

const ORACLE_ABI = [
  'function setPrice(address token, uint256 price) external',
  'function prices(address) view returns (uint256)',
]

const USDC_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDT_DEFAULT = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rpcUrl     = process.env.BASE_MAINNET_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  const keeperKey  = process.env.ORACLE_KEEPER_PRIVATE_KEY
  const oracleAddr = process.env.PRICE_ORACLE_ADDRESS
  if (!rpcUrl || !keeperKey || !oracleAddr) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Oracle keeper not configured' })
  }

  try {
    // NGN per 1 USD (e.g. ~1650). Oracle price = cNGN(1e6) per 1 whole token.
    const ngnPerUsd = await getNgnUsdRateFromFlipeet()
    if (!Number.isFinite(ngnPerUsd) || ngnPerUsd < 100 || ngnPerUsd > 100000) {
      return NextResponse.json({ error: `Implausible rate ${ngnPerUsd} — refusing to update` }, { status: 502 })
    }
    const price = BigInt(Math.round(ngnPerUsd * 1e6))

    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const keeper   = new ethers.Wallet(keeperKey, provider)
    const oracle   = new ethers.Contract(oracleAddr, ORACLE_ABI, keeper)

    const tokens = [
      { sym: 'USDC', addr: process.env.USDC_TOKEN_ADDRESS || USDC_DEFAULT },
      { sym: 'USDT', addr: process.env.USDT_TOKEN_ADDRESS || USDT_DEFAULT },
    ]

    const results: Record<string, string> = {}
    for (const t of tokens) {
      try {
        const current: bigint = await oracle.prices(t.addr)
        const diffBps = current > 0n
          ? (price > current ? ((price - current) * 10000n) / current : ((current - price) * 10000n) / current)
          : 10000n
        // Skip if within 0.5% AND not stale-risky (refresh anyway every run to reset the 1h clock)
        // We always push so the staleness timer resets; gas on Base is negligible.
        const tx = await oracle.setPrice(t.addr, price)
        await tx.wait()
        results[t.sym] = `set ${price.toString()} (Δ${(Number(diffBps) / 100).toFixed(2)}%) tx ${tx.hash}`
      } catch (e: any) {
        results[t.sym] = `error: ${e?.message || e}`
      }
    }

    return NextResponse.json({ ok: true, ngnPerUsd, price: price.toString(), results })
  } catch (err: any) {
    console.error('[update-oracle] error:', err)
    return NextResponse.json({ error: err?.message || 'oracle update failed' }, { status: 500 })
  }
}
