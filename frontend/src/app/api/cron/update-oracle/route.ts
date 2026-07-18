import { NextRequest, NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'
import { checkCronAuth } from '@/lib/cron-auth'
import { getSecret } from '@/lib/secrets'
import { getWriteProvider } from '@/lib/rpc-provider'

/**
 * GET /api/cron/update-oracle
 *
 * Pushes the live NGN/USD price for the USD-stable collateral tokens (USDC, USDT)
 * to the PriceOracle so the lending pool never serves a stale price.
 *
 * Cadence is set by the CONTRACT, not the RPC: PriceOracle.MAX_PRICE_AGE = 1 hour,
 * and PawasaveLend prices collateral via the staleness-enforced getPrice (FIND-SC-13),
 * so once the oracle goes stale borrows AND liquidations stop working. At the old
 * every-30-min cadence that was only 2 attempts per hour — two consecutive failures
 * and the pool breaks. Now every 10 min (see vercel.json): ~6 attempts inside every
 * staleness window, so a run has to fail 5 times running to hurt. Cheap on a paid RPC.
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
const CNGN_DEFAULT = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'
const CNGN_PRICE = 1000000n // 1 cNGN = 1 cNGN (peg), 6 decimals

export const dynamic = 'force-dynamic'
// Three sequential setPrice txs, each awaiting a receipt. The default timeout can
// kill the function midway, leaving some tokens unpriced — give it real headroom.
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  const rpcUrl     = process.env.BASE_MAINNET_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  const keeperKey  = await getSecret('ORACLE_KEEPER_PRIVATE_KEY')
  const oracleAddr = process.env.PRICE_ORACLE_ADDRESS
  if (!rpcUrl || !keeperKey || !oracleAddr) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Oracle keeper not configured' })
  }

  try {
    // NGN per 1 USD (e.g. ~1650). Oracle price = cNGN(1e6) per 1 whole token.
    // Use the SAME rate path as /api/ramp/rate and the ramp: getNgnUsdRateFromFlint
    // → Flint, then Flipeet-usdc, then last-good, then fallback. The old
    // getNgnUsdRateFromFlipeet() asked Flipeet for a cNGN rate — which can't express
    // NGN/USD — so it silently returned FALLBACK_RATE, pushing a hardcoded FX onto
    // the oracle every run (1650 vs the live 1399, over-pricing collateral ~18%).
    const ngnPerUsd = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
    if (!Number.isFinite(ngnPerUsd) || ngnPerUsd < 100 || ngnPerUsd > 100000) {
      return NextResponse.json({ error: `Implausible rate ${ngnPerUsd} — refusing to update` }, { status: 502 })
    }
    const price = BigInt(Math.round(ngnPerUsd * 1e6))

    // Sign through ONE endpoint. This keeper sends THREE sequential setPrice txs,
    // and FallbackProvider races nonces across endpoints on sequential writes — the
    // 2nd/3rd would reuse the 1st's nonce and silently drop, leaving tokens unpriced
    // until the oracle went stale. Same fix already applied to custody/sweep/off-ramp.
    const provider = getWriteProvider()
    const keeper   = new ethers.Wallet(keeperKey, provider)
    const oracle   = new ethers.Contract(oracleAddr, ORACLE_ABI, keeper)

    // USDC/USDT track the live USD rate; cNGN is the peg (1 cNGN = 1 cNGN).
    // All are re-pushed every run so the oracle's 1h staleness timer never trips.
    const tokens = [
      { sym: 'USDC', addr: process.env.USDC_TOKEN_ADDRESS || USDC_DEFAULT, price },
      { sym: 'USDT', addr: process.env.USDT_TOKEN_ADDRESS || USDT_DEFAULT, price },
      { sym: 'cNGN', addr: process.env.CNGN_TOKEN_ADDRESS || CNGN_DEFAULT, price: CNGN_PRICE },
    ]

    const results: Record<string, string> = {}
    for (const t of tokens) {
      try {
        const tx = await oracle.setPrice(t.addr, t.price)
        await tx.wait()
        results[t.sym] = `set ${t.price.toString()} tx ${tx.hash}`
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
