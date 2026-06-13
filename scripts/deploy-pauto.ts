import { ethers } from "hardhat"
import * as fs from "fs"
import * as path from "path"

interface DeploymentConfig {
  cNGNToken: string
  lendPool: string
  lendStrategy: string
  primaryStrategy: string
  fallbackStrategy: string
  feeRecipient: string
  vaultAddress: string
  timestamp: number
}

async function main() {
  console.log("🚀 Deploying P-AUTO Vault...")

  const [deployer] = await ethers.getSigners()
  console.log("📝 Deploying with account:", deployer.address)

  // Get network info
  const network = await ethers.provider.getNetwork()
  console.log("🌐 Network:", network.name, "- Chain ID:", network.chainId)

  // Deploy or use existing token
  let tokenAddress: string
  if (process.env.CNGN_TOKEN_ADDRESS) {
    tokenAddress = process.env.CNGN_TOKEN_ADDRESS
    console.log("✓ Using existing cNGN token:", tokenAddress)
  } else {
    console.log("📦 Deploying MockERC20 token...")
    const MockERC20 = await ethers.getContractFactory("MockERC20")
    const token = await MockERC20.deploy("Crypto NGN", "cNGN", 6)
    await token.waitForDeployment()
    tokenAddress = await token.getAddress()
    console.log("✓ MockERC20 deployed to:", tokenAddress)
  }

  // Strategy wiring (redesign): the vault now requires IStrategy-conforming
  // strategies. Preferred path — set LEND_POOL_ADDRESS to the deployed
  // PawasaveLend, and we deploy a PawasaveLendStrategy adapter over it. (The raw
  // lend pool is NOT an IStrategy, so it can no longer be passed directly.)
  let primaryStrategy = process.env.PRIMARY_STRATEGY_ADDRESS || ""
  let lendStrategyAddress = ""
  const lendPool = process.env.LEND_POOL_ADDRESS || ""
  if (lendPool) {
    console.log("\n🔗 Deploying PawasaveLendStrategy adapter over lend pool:", lendPool)
    const Adapter = await ethers.getContractFactory("PawasaveLendStrategy")
    const adapter = await Adapter.deploy(tokenAddress, lendPool)
    await adapter.waitForDeployment()
    lendStrategyAddress = await adapter.getAddress()
    primaryStrategy = lendStrategyAddress
    console.log("✓ Adapter deployed to:", lendStrategyAddress)
  }
  if (!primaryStrategy) {
    throw new Error("Set LEND_POOL_ADDRESS (preferred) or PRIMARY_STRATEGY_ADDRESS to an IStrategy")
  }
  // Fallback is optional and must itself be an IStrategy; default to none.
  const fallbackStrategy = process.env.FALLBACK_STRATEGY_ADDRESS || ethers.ZeroAddress
  const feeRecipient     = process.env.FEE_RECIPIENT_ADDRESS     || deployer.address

  console.log("\n📋 Deployment Configuration:")
  console.log("  Token:", tokenAddress)
  console.log("  Primary Strategy:", primaryStrategy)
  console.log("  Fallback Strategy:", fallbackStrategy)
  console.log("  Fee Recipient:", feeRecipient)

  // Deploy vault
  console.log("\n🔨 Deploying PawasaveAutoVault...")
  const VaultFactory = await ethers.getContractFactory("PawasaveAutoVault")
  const vault = await VaultFactory.deploy(
    tokenAddress,
    primaryStrategy,
    fallbackStrategy,
    feeRecipient
  )

  const vaultAddress = await vault.getAddress()
  console.log("✓ Vault deployed to:", vaultAddress)

  // Bind the lend adapter to the vault (one-time) so only the vault can move funds.
  if (lendStrategyAddress) {
    console.log("\n🔗 Binding adapter to vault (setVault)...")
    const adapter = await ethers.getContractAt("PawasaveLendStrategy", lendStrategyAddress)
    const tx = await adapter.setVault(vaultAddress)
    await tx.wait()
    console.log("✓ Adapter bound to vault")
  }

  // Verify deployment
  console.log("\n✅ Verifying deployment...")
  const assetToken = await vault.assetToken()
  const primStrat = await vault.primaryStrategy()
  const fallStrat = await vault.fallbackStrategy()
  const feeRecip = await vault.feeRecipient()
  const platformFee = await vault.platformFeeBps()

  console.log("  Asset Token:", assetToken)
  console.log("  Primary Strategy:", primStrat)
  console.log("  Fallback Strategy:", fallStrat)
  console.log("  Fee Recipient:", feeRecip)
  console.log("  Platform Fee (bps):", platformFee.toString())

  // Save deployment info
  const deploymentInfo: DeploymentConfig = {
    cNGNToken: tokenAddress,
    lendPool,
    lendStrategy: lendStrategyAddress,
    primaryStrategy,
    fallbackStrategy,
    feeRecipient,
    vaultAddress,
    timestamp: Date.now(),
  }

  const deploymentsDir = path.join(__dirname, "../deployments")
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true })
  }

  const networkName = network.name === "unknown" ? "hardhat" : network.name
  const deploymentFile = path.join(deploymentsDir, `${networkName}-deployment.json`)
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2))

  console.log("\n💾 Deployment saved to:", deploymentFile)

  // Generate .env.local snippet
  console.log("\n📌 Add to .env.local:")
  console.log(`NEXT_PUBLIC_PAUTO_VAULT_ADDRESS=${vaultAddress}`)
  console.log(`NEXT_PUBLIC_CNGN_TOKEN_ADDRESS=${tokenAddress}`)
  if (network.chainId === 84532) {
    console.log("NEXT_PUBLIC_BASE_RPC_URL=https://sepolia.base.org")
  } else if (network.chainId === 8453) {
    console.log("NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org")
  }

  console.log("\n✨ Deployment complete!")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
