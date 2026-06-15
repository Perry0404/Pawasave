import { ethers } from "hardhat"

/**
 * Transfer contract ownership to a multisig (Gnosis Safe) — FIND-3P-05 / SC-21.
 *
 * Moves PawasaveLend + PriceOracle (Ownable, immediate) and PawasaveAutoVault
 * (Ownable2Step, two-step) to NEW_OWNER. Run AFTER the audited redeploy.
 *
 * Env:
 *   NEW_OWNER                  Safe/multisig address to own the contracts
 *   PAWASAVE_LEND_ADDRESS      (optional) lend pool
 *   PRICE_ORACLE_ADDRESS       (optional) oracle
 *   CREDIT_LINE_ADDRESS        (optional) B2B credit line
 *   PAUTO_VAULT_ADDRESS        (optional) vault
 *
 *   npx hardhat run scripts/transfer-ownership.ts --network baseMainnet
 */
const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner) external",
]

async function main() {
  const newOwner = process.env.NEW_OWNER
  if (!newOwner || !ethers.isAddress(newOwner)) {
    throw new Error("Set NEW_OWNER to the Safe/multisig address")
  }

  const [signer] = await ethers.getSigners()
  console.log("Signer (current owner):", signer.address)
  console.log("New owner (Safe):      ", newOwner)

  const targets: { name: string; addr?: string; twoStep?: boolean }[] = [
    { name: "PawasaveLend", addr: process.env.PAWASAVE_LEND_ADDRESS },
    { name: "PriceOracle",  addr: process.env.PRICE_ORACLE_ADDRESS },
    { name: "PawasaveCreditLine", addr: process.env.CREDIT_LINE_ADDRESS },
    { name: "PawasaveAutoVault", addr: process.env.PAUTO_VAULT_ADDRESS, twoStep: true },
  ]

  for (const t of targets) {
    if (!t.addr) { console.log(`\n- ${t.name}: skipped (no address)`); continue }
    const c = await ethers.getContractAt(OWNABLE_ABI, t.addr)
    const current = await c.owner()
    console.log(`\n${t.name} @ ${t.addr}`)
    console.log("  current owner:", current)
    if (current.toLowerCase() !== signer.address.toLowerCase()) {
      console.log("  ⚠ signer is not the current owner — skipping")
      continue
    }
    const tx = await c.transferOwnership(newOwner)
    await tx.wait()
    if (t.twoStep) {
      console.log("  ✓ transfer INITIATED (Ownable2Step) — the Safe must call acceptOwnership()")
    } else {
      console.log("  ✓ ownership transferred")
    }
  }

  console.log("\nDone. Verify owners on Basescan. For the vault, finalise from the Safe with acceptOwnership().")
  console.log("Reminder: also migrate the off-chain keys — custody EOA → Safe, deposit mnemonic + oracle keeper → KMS/HSM (operational).")
}

main().catch((e) => { console.error(e); process.exitCode = 1 })