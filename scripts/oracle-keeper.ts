/**
 * oracle-keeper.ts
 *
 * Fetches the live NGN/USD exchange rate and pushes it to the
 * PriceOracle contract on Base so the P-AUTO vault and lending pool
 * always have a fresh collateral price.
 *
 * Run manually:
 *   npx ts-node scripts/oracle-keeper.ts
 *
 * Run on a schedule (e.g. every 30 min via PM2 or a cron job):
 *   */30 * * * * npx ts-node /path/to/scripts/oracle-keeper.ts >> /var/log/keeper.log 2>&1
 *
 * Required env vars:
 *   BASE_MAINNET_RPC_URL      — Base mainnet JSON-RPC
 *   ORACLE_KEEPER_PRIVATE_KEY — private key of the keeper wallet
 *   PRICE_ORACLE_ADDRESS      — deployed PriceOracle contract
 *   USDC_TOKEN_ADDRESS        — USDC on Base (6 decimals)
 *   FLINT_API_KEY             — Flint API key (already in PawaSave env)
 */

import { ethers } from "ethers"
import * as dotenv from "dotenv"
dotenv.config()

const ORACLE_ABI = [
  "function setPrice(address token, uint256 price) external",
  "function prices(address) view returns (uint256)",
  "function lastUpdated(address) view returns (uint256)",
]

async function fetchNgnUsdRate(): Promise<number> {
  // Primary: Flint API (already integrated in PawaSave)
  if (process.env.FLINT_API_KEY) {
    try {
      const res = await fetch("https://api.flintpay.io/v1/rates?from=NGN&to=USD", {
        headers: { Authorization: `Bearer ${process.env.FLINT_API_KEY}` },
      })
      if (res.ok) {
        const json = await res.json()
        const rate = json?.rate || json?.data?.rate
        if (rate && rate > 0) {
          console.log(`[Flint] NGN/USD rate: ${rate}`)
          return Number(rate)
        }
      }
    } catch (e) {
      console.warn("[Flint] rate fetch failed, trying fallback:", e)
    }
  }

  // Fallback: ExchangeRate-API (free tier)
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD")
    if (res.ok) {
      const json = await res.json()
      const ngnPerUsd = json?.rates?.NGN
      if (ngnPerUsd && ngnPerUsd > 0) {
        const rate = 1 / ngnPerUsd
        console.log(`[ExchangeRate-API] NGN/USD rate: ${rate} (${ngnPerUsd} NGN per USD)`)
        return rate
      }
    }
  } catch (e) {
    console.warn("[ExchangeRate-API] failed:", e)
  }

  throw new Error("All rate sources failed — refusing to update oracle with stale data")
}

/**
 * Convert NGN/USD rate to the price format PriceOracle expects:
 *   price = cNGN (1e6) per 1e18 normalised USDC
 *
 * 1 USDC = 1e6 USDC units = 1e12 in 1e18 normalised form
 * 1 USDC = (1 / ngnUsdRate) NGN = (1 / ngnUsdRate) cNGN (since 1 cNGN = 1 NGN)
 * price per 1e18 normalised = (1 / ngnUsdRate) * 1e18 * 1e6 (cNGN decimals)
 *                           = 1e24 / ngnUsdRate
 * But ngnUsdRate is USD per NGN (e.g. 0.000625 at ₦1600/$1)
 * So ngnPerUsd = 1 / ngnUsdRate ≈ 1600
 * price = ngnPerUsd * 1e6
 */
function rateToOraclePrice(ngnUsdRate: number): bigint {
  const ngnPerUsd = 1 / ngnUsdRate
  // price = cNGN per 1e18 normalised USDC
  // 1 USDC normalised to 1e18 → worth ngnPerUsd cNGN
  // cNGN has 6 decimals → multiply by 1e6
  const price = Math.round(ngnPerUsd * 1e6)
  return BigInt(price)
}

/** Push a USD-stable price for one token, skipping if within 0.5% of on-chain. */
async function updateStableToken(
  oracle: ethers.Contract,
  label: string,
  tokenAddr: string,
  price: bigint,
) {
  const currentPrice: bigint = await oracle.prices(tokenAddr)
  const priceDiff = currentPrice > 0n
    ? (price > currentPrice
        ? ((price - currentPrice) * 10000n) / currentPrice
        : ((currentPrice - price) * 10000n) / currentPrice)
    : 10000n

  console.log(`[oracle-keeper] ${label}: on-chain ${currentPrice.toString()} → new ${price.toString()} (${Number(priceDiff)/100}% diff)`)

  if (priceDiff < 50n && currentPrice > 0n) {
    console.log(`[oracle-keeper] ${label}: within 0.5% — skipping`)
    return
  }

  const tx = await oracle.setPrice(tokenAddr, price)
  const receipt = await tx.wait()
  console.log(`[oracle-keeper] ✓ ${label} updated — 1 ${label} = ${Number(price) / 1e6} cNGN — tx: ${receipt.hash}`)
}

async function main() {
  const rpcUrl      = process.env.BASE_MAINNET_RPC_URL
  const privateKey  = process.env.ORACLE_KEEPER_PRIVATE_KEY
  const oracleAddr  = process.env.PRICE_ORACLE_ADDRESS
  const usdcAddr    = process.env.USDC_TOKEN_ADDRESS
  // USDT (USD₮0) on Base — same USD peg as USDC. Optional; defaults to Base USDT.
  const usdtAddr    = process.env.USDT_TOKEN_ADDRESS || "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"

  if (!rpcUrl || !privateKey || !oracleAddr || !usdcAddr) {
    console.error("Missing required env vars: BASE_MAINNET_RPC_URL, ORACLE_KEEPER_PRIVATE_KEY, PRICE_ORACLE_ADDRESS, USDC_TOKEN_ADDRESS")
    process.exit(1)
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const keeper   = new ethers.Wallet(privateKey, provider)
  const oracle   = new ethers.Contract(oracleAddr, ORACLE_ABI, keeper)

  console.log(`[oracle-keeper] Keeper: ${keeper.address}`)
  console.log(`[oracle-keeper] Oracle: ${oracleAddr}`)

  // Fetch the NGN/USD rate once — USDC and USDT share the same USD peg.
  const ngnUsdRate = await fetchNgnUsdRate()
  const price      = rateToOraclePrice(ngnUsdRate)
  console.log(`[oracle-keeper] NGN per USD: ${Math.round(1 / ngnUsdRate)} → price ${price.toString()}`)

  // USD-stable collateral tokens to keep priced. RWAs/T-bills are NOT here —
  // they have a drifting NAV and need their own per-asset price source.
  const stableTokens: Array<{ label: string; addr?: string }> = [
    { label: "USDC", addr: usdcAddr },
    { label: "USDT", addr: usdtAddr },
  ]

  for (const t of stableTokens) {
    if (!t.addr) continue
    try {
      await updateStableToken(oracle, t.label, t.addr, price)
    } catch (e: any) {
      console.error(`[oracle-keeper] ${t.label} update failed:`, e?.message || e)
    }
  }
}

main().catch((e) => {
  console.error("[oracle-keeper] FATAL:", e)
  process.exit(1)
})
