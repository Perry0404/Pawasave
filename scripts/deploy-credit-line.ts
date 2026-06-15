import { ethers } from "hardhat"
import * as fs from "fs"
import * as path from "path"

/**
 * Deploys PawasaveCreditLine (B2B uncollateralised partner credit lines).
 * Owner = deployer; transfer to the Safe afterwards via transfer-ownership.ts.
 *
 *   CNGN_TOKEN_ADDRESS — cNGN on Base
 *   npx hardhat run scripts/deploy-credit-line.ts --network baseMainnet
 */
async function main() {
  const cngn = process.env.CNGN_TOKEN_ADDRESS
  if (!cngn) throw new Error("Set CNGN_TOKEN_ADDRESS")

  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  console.log("📝 Deployer:", deployer.address)
  console.log("🌐 Network:", network.name, "— Chain ID:", network.chainId)
  console.log("💵 cNGN:", cngn)

  const CL = await ethers.getContractFactory("PawasaveCreditLine")
  const cl = await CL.deploy(cngn)
  await cl.waitForDeployment()
  const addr = await cl.getAddress()
  console.log("✓ PawasaveCreditLine:", addr)

  const deploymentsDir = path.join(__dirname, "../deployments")
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true })
  const networkName = network.name === "unknown" ? "hardhat" : network.name
  fs.writeFileSync(
    path.join(deploymentsDir, `${networkName}-creditline.json`),
    JSON.stringify({ creditLine: addr, cngn, timestamp: Date.now() }, null, 2),
  )

  console.log("\n📌 Env:")
  console.log(`CREDIT_LINE_ADDRESS=${addr}`)
  console.log("\n✨ Credit line deployed. Fund it with cNGN (fund()) and add partners when ready.")
}

main().catch((e) => { console.error(e); process.exitCode = 1 })