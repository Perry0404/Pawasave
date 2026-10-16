/**
 * PSS-1 on B20 — create a real B20 Asset token through Base's factory precompile, plug in PawaSave's
 * modules, and walk the lifecycle on Base Sepolia.
 *
 *   npx hardhat run scripts/b20-demo.ts --network baseSepolia   (needs NGX_DEMO_KEY funded)
 *
 * Roles (derived from the demo key exactly as scripts/ngx-token-demo.ts does): root = issuer admin and
 * gas, [0] custodian, [1] PawaSave ops (registrar, minter, reconciler, settler, dividend issuer),
 * [2] Ada, [3] Bayo, [5] trustee.
 */
import { ethers, network } from "hardhat"
import { AbiCoder, keccak256, toUtf8Bytes, Wallet, HDNodeWallet, Signature } from "ethers"
import fs from "fs"
import { buildTree, proRata } from "./lib/dividend-merkle"

const B20_FACTORY = "0xB20f000000000000000000000000000000000000"
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002"
const DEMO_CNGN = "0xF858125fA2cb724119366A5A20A298F5e4154D2d" // stand-in cNGN from the first demo (owner: root)
const UNIT = 1_000_000n
const G = { gasLimit: 1_500_000 }
const CONF = 2

const FACTORY_ABI = [
  "function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address)",
  "function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)",
  "function isB20(address token) view returns (bool)",
]
const REGISTRY_ABI = [
  "function createPolicyWithAccounts(address admin, uint8 policyType, address[] accounts) returns (uint64)",
  "function updateAllowlist(uint64 policyId, bool allowed, address[] accounts)",
  "function isAuthorized(uint64 policyId, address account) view returns (bool)",
  "event PolicyCreated(uint64 indexed policyId, address indexed creator, uint8 policyType)",
]
const TOKEN_ABI = [
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)", "function multiplier() view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function updatePolicy(bytes32 policyScope, uint64 newPolicyId)",
  "function policyId(bytes32 policyScope) view returns (uint64)",
]
const id = (s: string) => keccak256(toUtf8Bytes(s))
const line = (s = "") => console.log(s)
const step = (n: number, s: string) => { line(); line(`── ${n}. ${s}`) }
const ok = (s: string) => line(`   ✔ ${s}`)
const blocked = (s: string) => line(`   ✖ blocked: ${s}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function expectRevert(p: Promise<unknown>, label: string) {
  try { await p; line(`   !! expected a revert: ${label}`) } catch (e: any) {
    const m = String(e?.shortMessage || e?.message || e)
    const reason = e?.revert?.name ? `${e.revert.name}` : m.match(/reverted:?\s*"?([^"\n]+)/)?.[1] || m.slice(0, 90)
    blocked(`${label} → ${reason}`)
  }
}

async function waitCode(addr: string) {
  for (let i = 0; i < 30 && (await ethers.provider.getCode(addr)) === "0x"; i++) await sleep(2000)
}

async function main() {
  if (network.name !== "baseSepolia") throw new Error("run with --network baseSepolia")
  const seed = process.env.NGX_DEMO_KEY
  if (!seed) throw new Error("Set NGX_DEMO_KEY")
  const p = ethers.provider
  const root = new Wallet(seed, p)
  const d = (i: number) => HDNodeWallet.fromSeed(keccak256(toUtf8Bytes(seed + ":" + i))).connect(p)
  const [custodian, ops, ada, bayo, trustee] = [d(0), d(1), d(2), d(3), d(5)]
  for (const w of [ops, ada, bayo, trustee]) {
    if ((await p.getBalance(w.address)) < ethers.parseEther("0.0002")) await (await root.sendTransaction({ to: w.address, value: ethers.parseEther("0.0003") })).wait(CONF)
  }

  line("PawaSave × Base — NGX equity as a B20 Asset token, end to end")

  step(1, "Issuer creates pMTNN as a B20 Asset through Base's factory: 1 token = 1 MTN share")
  const factory = new ethers.Contract(B20_FACTORY, FACTORY_ABI, root)
  const salt = id(`pMTNN-${Date.now()}`)
  const params = AbiCoder.defaultAbiCoder().encode(["tuple(uint8,string,string,address,uint8)"], [[1, "PawaSave MTN Nigeria", "pMTNN", root.address, 6]])
  const tokenAddr: string = await factory.getB20Address(0, root.address, salt)
  await (await factory.createB20(0, salt, params, [], G)).wait(CONF)
  await waitCode(tokenAddr)
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, root)
  ok(`B20 token ${tokenAddr} · isB20 = ${await factory.isB20(tokenAddr)} · ${await token.symbol()} · ${await token.decimals()} decimals`)

  step(2, "PawaSave modules: mint gate (custodian-attested), whole-share router, redemption vault")
  const deploy = async (name: string, args: unknown[]) => {
    const c: any = await (await ethers.getContractFactory(name, root)).deploy(...args)
    await c.waitForDeployment(); const a = await c.getAddress(); await waitCode(a); return c
  }
  const gate = await deploy("PawaMintGate", [tokenAddr, root.address, custodian.address, 10_000n, 100_000n])
  const router = await deploy("WholeShareRouter", [tokenAddr])
  const vault = await deploy("PawaRedemptionVault", [tokenAddr, root.address])
  const [gateA, routerA, vaultA] = await Promise.all([gate.getAddress(), router.getAddress(), vault.getAddress()])
  ok(`gate ${gateA} · router ${routerA} · vault ${vaultA}`)

  step(3, "Policies in Base's registry: the verified register, and who may initiate transfers")
  const registry = new ethers.Contract(POLICY_REGISTRY, REGISTRY_ABI, root)
  const createPolicy = async (admin: string, accounts: string[]) => {
    const rc = await (await registry.createPolicyWithAccounts(admin, 1, accounts, G)).wait(CONF)
    for (const l of rc!.logs) { try { const e = registry.interface.parseLog(l); if (e?.name === "PolicyCreated") return e.args.policyId as bigint } catch { /* other log */ } }
    throw new Error("no PolicyCreated")
  }
  const verifiedId = await createPolicy(ops.address, [ada.address, bayo.address, vaultA])
  const executorId = await createPolicy(root.address, [routerA, vaultA])
  for (const scope of ["MINT_RECEIVER_POLICY", "TRANSFER_SENDER_POLICY", "TRANSFER_RECEIVER_POLICY"]) {
    await (await token.updatePolicy(id(scope), verifiedId, G)).wait(CONF)
  }
  await (await token.updatePolicy(id("TRANSFER_EXECUTOR_POLICY"), executorId, G)).wait(CONF)
  ok(`verified register = policy ${verifiedId} (KYC'd wallets + vault) on mint, send and receive`)
  ok(`transfer initiators = policy ${executorId} (router + vault only)`)

  await (await token.grantRole(id("MINT_ROLE"), gateA, G)).wait(CONF)
  await (await token.grantRole(id("BURN_ROLE"), vaultA, G)).wait(CONF)
  for (const r of ["MINTER_ROLE", "RECONCILER_ROLE"]) await (await gate.grantRole(id(r), ops.address, G)).wait(CONF)
  await (await vault.grantRole(id("SETTLER_ROLE"), ops.address, G)).wait(CONF)
  ok("MINT_ROLE → gate only · BURN_ROLE → vault only · ops runs the gate and settles redemptions")

  const chainId = (await p.getNetwork()).chainId
  const attest = async (to: string, shares: bigint, ref: string) => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900)
    const sig = await custodian.signTypedData(
      { name: "PawaMintGate", version: "1", chainId, verifyingContract: gateA },
      { MintAttestation: [{ name: "to", type: "address" }, { name: "shares", type: "uint256" }, { name: "settlementRef", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
      { to, shares, settlementRef: id(ref), deadline })
    return { deadline, sig }
  }
  const settle = async (to: string, shares: bigint, ref: string) => {
    await (await gate.connect(ops).reportReserve((await gate.sharesRequired()) + shares, id("CSCS-" + ref), G)).wait(CONF)
    const a = await attest(to, shares, ref)
    await (await gate.connect(ops).mintWithAttestation(to, shares, id(ref), a.deadline, a.sig, G)).wait(CONF)
  }

  step(4, "Ada buys 100 MTNN: broker executes, CSCS settles, the custodian signs, the gate mints")
  await settle(ada.address, 100n, "NGX-2026-10-16-MTNN-000123")
  ok(`Ada holds ${(await token.balanceOf(ada.address)) / UNIT} shares (${await token.balanceOf(ada.address)} raw units at 6 decimals)`)
  const fake = await ops.signTypedData({ name: "PawaMintGate", version: "1", chainId, verifyingContract: gateA },
    { MintAttestation: [{ name: "to", type: "address" }, { name: "shares", type: "uint256" }, { name: "settlementRef", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
    { to: ada.address, shares: 1000n, settlementRef: id("FAKE"), deadline: BigInt(Math.floor(Date.now() / 1000) + 900) })
  await expectRevert(gate.connect(ops).mintWithAttestation.staticCall(ada.address, 1000n, id("FAKE"), BigInt(Math.floor(Date.now() / 1000) + 900), fake), "PawaSave minting without the custodian")

  step(5, "Whole shares only: Ada cannot transfer directly; the router moves whole shares")
  await expectRevert(token.connect(ada).transfer.staticCall(bayo.address, UNIT / 2n), "Ada sends half a share straight from her wallet")
  await expectRevert(token.connect(ada).transfer.staticCall(bayo.address, UNIT), "Ada sends a whole share straight from her wallet")
  await (await token.connect(ada).approve(routerA, 30n * UNIT, G)).wait(CONF)
  await (await router.connect(ada).transfer(bayo.address, 30n, id("gift"), G)).wait(CONF)
  ok(`via the router: Ada ${(await token.balanceOf(ada.address)) / UNIT} · Bayo ${(await token.balanceOf(bayo.address)) / UNIT}`)
  await expectRevert(router.connect(ada).transfer.staticCall(Wallet.createRandom().address, 1n, id("x")), "sending to a wallet that has not done KYC")

  step(6, "Bayo cashes out 10: locked in the vault, burned only after the sale settles")
  await (await token.connect(bayo).approve(vaultA, 10n * UNIT, G)).wait(CONF)
  await (await vault.connect(bayo).requestRedemption(10n, 0, G)).wait(CONF)
  ok(`locked: vault holds ${(await token.balanceOf(vaultA)) / UNIT}, supply still ${(await token.totalSupply()) / UNIT}`)
  await (await vault.connect(ops).completeRedemption(0, id("NGX-SALE-000045"), G)).wait(CONF)
  await (await gate.connect(ops).reportReserve(await gate.sharesRequired(), id("CSCS-after-sale"), G)).wait(CONF)
  ok(`sale settled → burned. supply ${(await token.totalSupply()) / UNIT}, pool statement ${await gate.lastReserveShares()}`)

  step(7, "Dividend: ₦10 a share against a record block, approved by the trustee, paid in cNGN")
  const div = await deploy("PawaMerkleDividend", [tokenAddr, DEMO_CNGN, POLICY_REGISTRY, verifiedId, root.address])
  const divA = await div.getAddress()
  await (await div.grantRole(id("ISSUER_ROLE"), ops.address, G)).wait(CONF)
  await (await div.grantRole(id("TRUSTEE_ROLE"), trustee.address, G)).wait(CONF)
  const recordBlock = (await p.getBlockNumber()) - 1
  const holdings = []
  for (const a of [ada.address, bayo.address]) holdings.push({ account: a, units: await token.balanceOf(a, { blockTag: recordBlock }) })
  const supplyAt: bigint = await token.totalSupply({ blockTag: recordBlock })
  const total = (supplyAt / UNIT) * 10n * 1_000_000n
  const ents = proRata(total, holdings)
  const tree = buildTree(ents)
  const cngn = new ethers.Contract(DEMO_CNGN, ["function mint(address to, uint256 amount)", "function balanceOf(address) view returns (uint256)"], root)
  await (await cngn.mint(divA, total, G)).wait(CONF)
  await (await div.connect(ops).declare(tree.root, total, recordBlock, "MTNN-FY2026-FINAL / net of WHT", G)).wait(CONF)
  ok(`record block ${recordBlock}: ${ents.length} holders, list published as root ${tree.root.slice(0, 12)}…`)
  await expectRevert(div.connect(ops).approve.staticCall(0), "PawaSave approving its own dividend")
  await (await div.connect(trustee).approve(0, G)).wait(CONF)
  for (let i = 0; i < ents.length; i++) await (await div.connect(ops).pay(0, ents[i].account, ents[i].amount, tree.proof(i), G)).wait(CONF)
  ok(`trustee approved; paid Ada ₦${Number(await cngn.balanceOf(ada.address)) / 1e6} cNGN-total · Bayo ₦${Number(await cngn.balanceOf(bayo.address)) / 1e6} cNGN-total`)
  await expectRevert(div.connect(ops).pay.staticCall(0, ents[0].account, ents[0].amount, tree.proof(0)), "paying Ada twice")

  const out = {
    network: "baseSepolia", chainId: Number(chainId), standard: "B20 Asset (Base factory precompile)", createdAt: new Date().toISOString().slice(0, 10),
    token: tokenAddr, mintGate: gateA, router: routerA, redemptionVault: vaultA, dividend: divA, demoCngn: DEMO_CNGN,
    policyRegistry: POLICY_REGISTRY, verifiedPolicyId: verifiedId.toString(), executorPolicyId: executorId.toString(),
    custodianSigner: custodian.address, trustee: trustee.address, admin: root.address, ops: ops.address,
  }
  fs.writeFileSync("deployments/base-sepolia-pss-b20.json", JSON.stringify(out, null, 2) + "\n")
  line()
  line("Every rule above is enforced on-chain: by Base's B20 token and policy registry, and by PawaSave's modules.")
  line(`Token: https://sepolia.basescan.org/address/${tokenAddr}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
