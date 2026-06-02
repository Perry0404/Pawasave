import { ethers } from "hardhat"
import * as fs from "fs"
import * as path from "path"

interface DeploymentConfig {
  cNGNToken: string
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

  // PRIMARY_STRATEGY_ADDRESS = PawasaveLend contract (deploy-lend.ts first)
  // FALLBACK_STRATEGY_ADDRESS = XEND X-AUTO bridge or secondary lending pool
  const primaryStrategy  = process.env.PRIMARY_STRATEGY_ADDRESS  || deployer.address
  const fallbackStrategy = process.env.FALLBACK_STRATEGY_ADDRESS || deployer.address
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
