import { ethers } from "hardhat"
import * as fs from "fs"
import * as path from "path"

async function main() {
  console.log("🏦 Deploying PawaSave cNGN Lending Pool...")

  const [deployer] = await ethers.getSigners()
  const network    = await ethers.provider.getNetwork()
  console.log("📝 Deployer:", deployer.address)
  console.log("🌐 Network:", network.name, "— Chain ID:", network.chainId)

  // ── Token ──────────────────────────────────────────────────────────────────
  let cngnAddress: string
  if (process.env.CNGN_TOKEN_ADDRESS) {
    cngnAddress = process.env.CNGN_TOKEN_ADDRESS
    console.log("✓ cNGN:", cngnAddress)
  } else {
    const ERC20F = await ethers.getContractFactory("MockERC20")
    const token  = await ERC20F.deploy("Crypto NGN", "cNGN", 6)
    await token.waitForDeployment()
    cngnAddress  = await token.getAddress()
    console.log("✓ MockERC20 (cNGN) deployed:", cngnAddress)
  }

  // ── Interest Rate Model ────────────────────────────────────────────────────
  // 5% base | 40% multiplier | 300% jump | 80% kink
  // Target: ~65% borrow APR at 85% utilization
  const IRMF = await ethers.getContractFactory("InterestRateModel")
  const irm  = await IRMF.deploy(
    ethers.parseEther("0.05"),
    ethers.parseEther("0.40"),
    ethers.parseEther("3.00"),
    ethers.parseEther("0.80"),
  )
  await irm.waitForDeployment()
  console.log("✓ InterestRateModel:", await irm.getAddress())

  // ── Price Oracle ───────────────────────────────────────────────────────────
  const keeperAddress = process.env.ORACLE_KEEPER_ADDRESS || deployer.address
  const OF     = await ethers.getContractFactory("PriceOracle")
  const oracle = await OF.deploy(keeperAddress)
  await oracle.waitForDeployment()
  console.log("✓ PriceOracle:", await oracle.getAddress())

  // Seed initial price if USDC address is known
  const usdcAddress = process.env.USDC_TOKEN_ADDRESS
  if (usdcAddress) {
    // 1 USDC = 1,650 cNGN (update this via keeper bot in production)
    const initialPrice = ethers.parseUnits("1650", 6)
    await oracle.setPrice(usdcAddress, initialPrice)
    console.log("✓ USDC price set:", usdcAddress, "→", initialPrice.toString(), "cNGN/USDC")
  }

  // ── PawasaveLend ───────────────────────────────────────────────────────────
  const treasuryAddress     = process.env.FEE_RECIPIENT_ADDRESS    || deployer.address
  const insuranceFundAddress = process.env.INSURANCE_FUND_ADDRESS  || deployer.address

  const LF   = await ethers.getContractFactory("PawasaveLend")
  const lend = await LF.deploy(
    cngnAddress,
    await irm.getAddress(),
    await oracle.getAddress(),
    treasuryAddress,
    insuranceFundAddress,
  )
  await lend.waitForDeployment()
  console.log("✓ PawasaveLend:", await lend.getAddress())

  // Add USDC as accepted collateral — 75% LTV (most liquid, dollar-stable)
  if (usdcAddress) {
    await lend.addCollateral(usdcAddress, 6, ethers.parseEther("0.75"))
    console.log("✓ USDC added as collateral (75% LTV)")
  }

  // Add cNGN as self-collateral — 60% LTV (naira-pegged, more volatile)
  // This is PawaSave's biggest differentiation: first protocol to allow cNGN as collateral
  await lend.addCollateral(cngnAddress, 6, ethers.parseEther("0.60"))
  console.log("✓ cNGN added as collateral (60% LTV) — first on Base!")

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log("\n📋 Deployment summary:")
  console.log("  cNGN:            ", cngnAddress)
  console.log("  InterestRateModel:", await irm.getAddress())
  console.log("  PriceOracle:      ", await oracle.getAddress())
  console.log("  PawasaveLend:     ", await lend.getAddress())
  console.log("  Treasury:         ", treasuryAddress)
  console.log("  Insurance Fund:   ", insuranceFundAddress)
  console.log("  Oracle Keeper:    ", keeperAddress)

  // ── Save deployment ────────────────────────────────────────────────────────
  const deploymentInfo = {
    cngnToken:         cngnAddress,
    interestRateModel: await irm.getAddress(),
    priceOracle:       await oracle.getAddress(),
    pawasaveLend:      await lend.getAddress(),
    treasury:          treasuryAddress,
    oracleKeeper:      keeperAddress,
    timestamp:         Date.now(),
  }

  const deploymentsDir = path.join(__dirname, "../deployments")
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true })

  const networkName = network.name === "unknown" ? "hardhat" : network.name
  fs.writeFileSync(
    path.join(deploymentsDir, `${networkName}-lend.json`),
    JSON.stringify(deploymentInfo, null, 2)
  )

  console.log("\n📌 Add to frontend .env.local:")
  console.log(`NEXT_PUBLIC_LEND_ADDRESS=${await lend.getAddress()}`)
  console.log(`NEXT_PUBLIC_CNGN_ADDRESS=${cngnAddress}`)
  console.log("\n✨ Lending pool deployment complete!")
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
