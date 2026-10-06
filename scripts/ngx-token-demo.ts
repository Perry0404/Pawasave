/**
 * PawaSave NGX token — live walkthrough of the full lifecycle.
 *
 *   npx hardhat run scripts/ngx-token-demo.ts                      (local, instant)
 *   npx hardhat run scripts/ngx-token-demo.ts --network baseSepolia (Base testnet; needs NGX_DEMO_KEY funded)
 *
 * Roles are played by separate keys so the separation is visible: the issuer admin, the CUSTODIAN
 * (who alone can attest settled shares), PawaSave's minting/ops service, and two investors.
 * On a live network all roles are derived from one demo key's index so a single faucet top-up
 * works; locally they are Hardhat's test accounts.
 */
import { ethers, network } from "hardhat"
import { keccak256, toUtf8Bytes, Wallet, HDNodeWallet } from "ethers"

const line = (s = "") => console.log(s)
const step = (n: number, s: string) => { line(); line(`── ${n}. ${s}`) }
const ok = (s: string) => line(`   ✔ ${s}`)
const blocked = (s: string) => line(`   ✖ blocked: ${s}`)

async function expectRevert(p: Promise<unknown>, label: string) {
  try { await p; line(`   !! expected a revert: ${label}`) } catch (e: any) {
    const m = String(e?.shortMessage || e?.reason || e?.message || e).match(/reverted with reason string '([^']+)'|reason="([^"]+)"|'([^']+)'/)
    blocked(`${label} → "${m?.[1] || m?.[2] || m?.[3] || "reverted"}"`)
  }
}

async function main() {
  let signers: any[]
  if (network.name === "hardhat" || network.name === "localhost") {
    signers = (await ethers.getSigners()).slice(0, 6)
  } else {
    const seed = process.env.NGX_DEMO_KEY
    if (!seed) throw new Error("Set NGX_DEMO_KEY (a funded Base Sepolia test key) to run on a live network")
    const root = new Wallet(seed, ethers.provider)
    // The root key pays for everything; the other roles are fresh keys it funds with dust.
    const others = Array.from({ length: 5 }, (_, i) => HDNodeWallet.fromSeed(keccak256(toUtf8Bytes(seed + ":" + i))).connect(ethers.provider))
    for (const w of others) {
      if ((await ethers.provider.getBalance(w.address)) < ethers.parseEther("0.0002")) {
        await (await root.sendTransaction({ to: w.address, value: ethers.parseEther("0.0003") })).wait()
      }
    }
    signers = [root, ...others]
  }
  const [admin, custodian, ops, ada, bayo, stranger] = [...signers, Wallet.createRandom()]

  line("PawaSave × Base — tokenized NGX equity, end to end")
  line(`network: ${network.name}`)

  step(1, "Issuer deploys pMTNN: 1 token = 1 MTN Nigeria share (ISIN NGMTNN000002)")
  const F = await ethers.getContractFactory("PawaEquityToken", admin)
  const token: any = await F.deploy("PawaSave MTN Nigeria", "pMTNN", "MTNN", "NGMTNN000002", admin.address, custodian.address, 10_000n, 100_000n)
  await token.waitForDeployment()
  const addr = await token.getAddress()
  ok(`deployed at ${addr}`)
  ok(`custodian key: ${custodian.address}. Only this key can attest settled shares`)
  for (const r of ["REGISTRAR_ROLE", "RECONCILER_ROLE", "BURNER_ROLE", "PAUSER_ROLE", "MINTER_ROLE"]) {
    await (await token.grantRole(await token[r](), ops.address)).wait()
  }
  ok("roles separated: admin (multisig in production) · custodian · PawaSave ops service")

  step(2, "KYC: Ada and Bayo pass verification and join the issuer's register")
  await (await token.connect(ops).setVerifiedBatch([ada.address, bayo.address], true)).wait()
  ok(`Ada ${ada.address.slice(0, 10)}… and Bayo ${bayo.address.slice(0, 10)}… are verified`)

  const chainId = (await ethers.provider.getNetwork()).chainId
  const domain = { name: "PawaEquityToken", version: "1", chainId, verifyingContract: addr }
  const types = { MintAttestation: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "tradeRef", type: "bytes32" }, { name: "deadline", type: "uint256" }] }
  const latest = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp)

  step(3, "Ada buys 100 MTNN. The broker executes on NGX; CSCS settles at T+1; the custodian signs")
  const trade = keccak256(toUtf8Bytes("NGX-2026-10-07-MTNN-000123"))
  const dl = (await latest()) + 3600n
  const sig = await custodian.signTypedData(domain, types, { to: ada.address, amount: 100n, tradeRef: trade, deadline: dl })
  ok("custodian attestation signed for trade NGX-2026-10-07-MTNN-000123 (100 shares → Ada)")
  await (await token.connect(ops).mintWithAttestation(ada.address, 100n, trade, dl, sig)).wait()
  ok(`minted: Ada holds ${await token.balanceOf(ada.address)} pMTNN`)

  step(4, "Try to cheat the backing")
  const fakeSig = await ops.signTypedData(domain, types, { to: ada.address, amount: 1000n, tradeRef: keccak256(toUtf8Bytes("FAKE")), deadline: dl })
  await expectRevert(token.connect(ops).mintWithAttestation(ada.address, 1000n, keccak256(toUtf8Bytes("FAKE")), dl, fakeSig), "PawaSave tries to mint 1,000 without the custodian")
  await expectRevert(token.connect(ops).mintWithAttestation(ada.address, 100n, trade, dl, sig), "replaying the same settled trade")

  step(5, "Ada gifts 30 shares to Bayo, a verified PawaSave user, instantly and with no broker sale")
  await (await token.connect(ada).transfer(bayo.address, 30n)).wait()
  ok(`Ada ${await token.balanceOf(ada.address)} · Bayo ${await token.balanceOf(bayo.address)}`)
  await expectRevert(token.connect(ada).transfer(stranger.address, 1n), "sending to an unverified wallet")

  step(6, "Daily reconciliation: the custodian's CSCS pool statement is posted on-chain")
  await (await token.connect(ops).reportReserve(100n, keccak256(toUtf8Bytes("CSCS-STMT-2026-10-07")))).wait()
  ok(`pool 100 shares ≥ supply ${await token.totalSupply()} tokens: fully backed, minting open`)
  await (await token.connect(ops).reportReserve(95n, keccak256(toUtf8Bytes("CSCS-STMT-2026-10-08")))).wait()
  ok(`simulated exception: pool 95 < supply 100 → mintHalted = ${await token.mintHalted()} (${await token.haltReason()})`)
  const t2 = keccak256(toUtf8Bytes("NGX-2026-10-08-MTNN-000124"))
  const sig2 = await custodian.signTypedData(domain, types, { to: bayo.address, amount: 5n, tradeRef: t2, deadline: dl })
  await expectRevert(token.connect(ops).mintWithAttestation(bayo.address, 5n, t2, dl, sig2), "any new mint while the reserve is short")
  await (await token.connect(ops).reportReserve(100n, keccak256(toUtf8Bytes("CSCS-STMT-2026-10-08-R")))).wait()
  await (await token.connect(ops).setMintHalt(false, "statement corrected")).wait()
  ok("exception resolved: corrected statement posted, minting reopened")

  step(7, "Bayo redeems 30 for cash: lock first, burn only after settlement")
  await (await token.connect(bayo).requestRedemption(30n, 0)).wait()
  ok(`locked: Bayo ${await token.balanceOf(bayo.address)}, locked ${await token.lockedSupply()}, supply still ${await token.totalSupply()} (shares not yet sold)`)
  await (await token.connect(ops).completeRedemption(0, keccak256(toUtf8Bytes("NGX-SALE-000045 / cNGN payout")))).wait()
  ok(`sale settled and cNGN paid → burned. supply now ${await token.totalSupply()}`)

  step(8, "Ada redeems 10 for delivery to her own CSCS account; the transfer fails, so she is made whole")
  await (await token.connect(ada).requestRedemption(10n, 1)).wait()
  await (await token.connect(ops).cancelRedemption(1, "CHN mismatch at CSCS")).wait()
  ok(`tokens returned in full: Ada holds ${await token.balanceOf(ada.address)}`)

  step(9, "Corporate action: a 1-for-1 bonus issue is recorded on-chain without moving balances")
  await (await token.connect(admin).setMultiplier(2n * 10n ** 18n, "MTNN 1-for-1 bonus")).wait()
  ok(`multiplier = ${Number(await token.multiplier()) / 1e18} share(s) per token; Ada's ${await token.balanceOf(ada.address)} tokens = ${Number(await token.balanceOf(ada.address)) * 2} shares`)

  line()
  line("Every rule above is enforced by the contract, not by PawaSave's servers.")
  if (network.name === "baseSepolia") line(`Inspect it: https://sepolia.basescan.org/address/${addr}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
