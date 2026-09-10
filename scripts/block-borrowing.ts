/**
 * block-borrowing.ts
 *
 * Disables NEW borrowing on the live PawasaveLend pool while leaving supply /
 * withdraw fully working — so the pool keeps serving as the custodial holding
 * layer (deposits swept in, off-ramps redeemed out) but no one can draw cNGN OUT
 * as a loan. Borrowing moves to the asset-backed model (Daya-funded disbursement),
 * so the on-chain pool must stop being a borrow venue.
 *
 * HOW it blocks: removeCollateral() sets accepted=false and trims the collateral
 * list, so totalCollateralValue()/borrowLimit() become 0 for everyone and any
 * borrow() reverts "Insufficient collateral" (PawasaveLend.sol:311). This does NOT
 * touch supply()/withdraw() (they aren't collateral-gated), unlike pausePool()
 * which would also freeze supply and break the holding-layer sweep.
 *
 * SAFETY GATE: aborts unless totalBorrows() == 0. Removing collateral while a loan
 * is open would zero that borrower's collateral value → make them unhealthy /
 * liquidatable and strand their collateral. At ~0 borrow TVL this is a no-op guard,
 * but it must hold before we ever remove.
 *
 * OWNER: if the connected signer is the pool owner it executes; otherwise it prints
 * the target + calldata for each call so you can submit them through the Gnosis Safe
 * (Transaction Builder). Reversible later with add-collateral.ts.
 *
 * Run:
 *   npx hardhat run scripts/block-borrowing.ts --network baseMainnet
 *
 * Env:
 *   PAWASAVE_LEND_ADDRESS   — deployed PawasaveLend (default: live v3 pool)
 *   BLOCK_COLLATERAL_TOKENS — optional comma-separated token addresses to remove;
 *                             defaults to cNGN + USDC + USDT (the listable set).
 */

import { ethers } from "hardhat"

const LEND_ABI = [
  "function owner() view returns (address)",
  "function totalBorrows() view returns (uint256)",
  "function collaterals(address) view returns (bool accepted, uint8 decimals, uint256 collateralFactor)",
  "function removeCollateral(address token) external",
]

const DEFAULT_LEND  = "0x5583802FB2215d550f80DC42CD44C40E0EF8B7cF" // live v3
const DEFAULT_TOKENS = [
  "0x46C85152bFe9f96829aA94755D9f915F9B10EF5F", // cNGN
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
  "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", // USDT (USD₮0)
]

async function main() {
  const lendAddr = process.env.PAWASAVE_LEND_ADDRESS || DEFAULT_LEND
  const tokens = (process.env.BLOCK_COLLATERAL_TOKENS
    ? process.env.BLOCK_COLLATERAL_TOKENS.split(",").map((t) => t.trim())
    : DEFAULT_TOKENS
  ).filter(Boolean)

  const [signer] = await ethers.getSigners()
  const lend  = new ethers.Contract(lendAddr, LEND_ABI, signer)
  const iface = new ethers.Interface(LEND_ABI)

  const owner = await lend.owner()
  const isOwner = owner.toLowerCase() === signer.address.toLowerCase()
  console.log("👤 Signer:", signer.address)
  console.log("🏦 Lend:  ", lendAddr)
  console.log("🔑 Owner: ", owner, isOwner ? "(signer IS owner → will execute)" : "(signer is NOT owner → will print calldata for the Safe)")

  // ── SAFETY GATE: no open loans ─────────────────────────────────────────────
  const borrows = await lend.totalBorrows()
  if (borrows > 0n) {
    throw new Error(
      `ABORT: totalBorrows() = ${borrows} (> 0). Removing collateral would strand/` +
      `liquidate open positions. Wait until every loan is repaid, then re-run.`,
    )
  }
  console.log("✅ Safety gate passed: totalBorrows() == 0 (no open loans)\n")

  for (const token of tokens) {
    const info = await lend.collaterals(token)
    if (!info.accepted) {
      console.log(`⏭️  ${token}: not accepted collateral — nothing to remove`)
      continue
    }
    const cfPct = (Number(info.collateralFactor) / 1e18) * 100
    console.log(`— ${token}: accepted @ ${cfPct}% LTV → removing —`)

    if (isOwner) {
      await (await lend.removeCollateral(token)).wait()
      console.log(`   ✓ removeCollateral executed`)
    } else {
      const data = iface.encodeFunctionData("removeCollateral", [token])
      console.log(`   → Safe tx:  to=${lendAddr}  value=0`)
      console.log(`               data=${data}`)
    }
  }

  console.log(
    "\n✨ Done. After this, borrow() reverts 'Insufficient collateral' for everyone; " +
    "supply()/withdraw() are unaffected. Reverse later with scripts/add-collateral.ts.",
  )
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
