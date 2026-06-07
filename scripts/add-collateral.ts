/**
 * add-collateral.ts
 *
 * Lists additional collateral tokens (USDT, tokenized T-bills, RWAs) on the
 * live PawasaveLend pool and seeds their PriceOracle prices. Idempotent —
 * safe to re-run; it only adds tokens that aren't already accepted and always
 * refreshes the price.
 *
 * The deployed pool already supports per-token collateral factors; this just
 * wires the extra tokens the frontend exposes (USDC + cNGN are added at deploy).
 *
 * Run:
 *   npx hardhat run scripts/add-collateral.ts --network baseMainnet
 *
 * Required env vars (owner / keeper key must match the deployer):
 *   PAWASAVE_LEND_ADDRESS   — deployed PawasaveLend
 *   PRICE_ORACLE_ADDRESS    — deployed PriceOracle
 *
 * Per-token env vars (a token is skipped unless its *_ADDRESS is set):
 *   USDT:    USDT_TOKEN_ADDRESS (default Base USDT), USDT_LTV (0.75), NGN_PER_USD (1650)
 *   T-bills: TBILL_TOKEN_ADDRESS, TBILL_DECIMALS (18), TBILL_LTV (0.70), TBILL_PRICE_CNGN (cNGN per 1 token)
 *   RWA:     RWA_TOKEN_ADDRESS,   RWA_DECIMALS (18),   RWA_LTV (0.65),   RWA_PRICE_CNGN   (cNGN per 1 token)
 */

import { ethers } from "hardhat"

const LEND_ABI = [
  "function collaterals(address) view returns (bool accepted, uint8 decimals, uint256 collateralFactor)",
  "function addCollateral(address token, uint8 decimals_, uint256 collateralFactor) external",
  "function setCollateralFactor(address token, uint256 newFactor) external",
]
const ORACLE_ABI = [
  "function prices(address) view returns (uint256)",
  "function setPrice(address token, uint256 price) external",
]

/** Oracle price = cNGN (1e6) per 1e18-normalised collateral = (cNGN value of 1 whole token) * 1e6 */
function oraclePrice(cngnPerToken: number): bigint {
  return BigInt(Math.round(cngnPerToken * 1e6))
}

interface TokenSpec {
  label: string
  address?: string
  decimals: number
  ltv: number          // e.g. 0.75
  cngnPerToken: number // value of 1 whole token in cNGN (=NGN)
}

async function main() {
  const lendAddr   = process.env.PAWASAVE_LEND_ADDRESS
  const oracleAddr = process.env.PRICE_ORACLE_ADDRESS
  if (!lendAddr || !oracleAddr) {
    throw new Error("Set PAWASAVE_LEND_ADDRESS and PRICE_ORACLE_ADDRESS")
  }

  const [signer] = await ethers.getSigners()
  console.log("👤 Signer:", signer.address)
  console.log("🏦 Lend:  ", lendAddr)
  console.log("🔮 Oracle:", oracleAddr)

  const lend   = new ethers.Contract(lendAddr, LEND_ABI, signer)
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer)

  const ngnPerUsd = Number(process.env.NGN_PER_USD || 1650)

  const specs: TokenSpec[] = [
    {
      label: "USDT",
      address: process.env.USDT_TOKEN_ADDRESS || "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimals: 6,
      ltv: Number(process.env.USDT_LTV || 0.75),
      cngnPerToken: ngnPerUsd, // 1 USDT ≈ ngnPerUsd cNGN
    },
    {
      label: "T-Bills",
      address: process.env.TBILL_TOKEN_ADDRESS,
      decimals: Number(process.env.TBILL_DECIMALS || 18),
      ltv: Number(process.env.TBILL_LTV || 0.70),
      cngnPerToken: Number(process.env.TBILL_PRICE_CNGN || 0),
    },
    {
      label: "RWA",
      address: process.env.RWA_TOKEN_ADDRESS,
      decimals: Number(process.env.RWA_DECIMALS || 18),
      ltv: Number(process.env.RWA_LTV || 0.65),
      cngnPerToken: Number(process.env.RWA_PRICE_CNGN || 0),
    },
  ]

  for (const t of specs) {
    if (!t.address) {
      console.log(`\n⏭️  ${t.label}: no *_ADDRESS set — skipping`)
      continue
    }
    if (!t.cngnPerToken || t.cngnPerToken <= 0) {
      console.log(`\n⚠️  ${t.label}: price (cNGN per token) is 0 — set its *_PRICE_CNGN. Skipping.`)
      continue
    }

    console.log(`\n— ${t.label} (${t.address}) —`)

    // 1) Oracle price (always refresh)
    const price = oraclePrice(t.cngnPerToken)
    await (await oracle.setPrice(t.address, price)).wait()
    console.log(`   ✓ price set: 1 ${t.label} = ${t.cngnPerToken.toLocaleString()} cNGN`)

    // 2) addCollateral if not already accepted, else update factor
    const info = await lend.collaterals(t.address)
    const factor = ethers.parseEther(t.ltv.toString())
    if (info.accepted) {
      await (await lend.setCollateralFactor(t.address, factor)).wait()
      console.log(`   ✓ already listed — factor updated to ${t.ltv * 100}% LTV`)
    } else {
      await (await lend.addCollateral(t.address, t.decimals, factor)).wait()
      console.log(`   ✓ listed as collateral at ${t.ltv * 100}% LTV (${t.decimals} decimals)`)
    }
  }

  console.log("\n✨ Done. Remember to set the matching NEXT_PUBLIC_*_TOKEN_ADDRESS in the frontend env.")
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
