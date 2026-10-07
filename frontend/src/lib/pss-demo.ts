import { ethers } from 'ethers'

/**
 * Server side of the PSS-1 testnet demo (/pss/demo): plays the issuer's ops service, the broker
 * and the custodian on Base Sepolia so a visitor can buy, transfer and redeem real testnet tokens.
 *
 * TESTNET ONLY. NGX_DEMO_KEY is a Base Sepolia key with no mainnet value. The role keys are
 * derived from it exactly as scripts/ngx-token-demo.ts derives them:
 *   root (admin / gas), [0] custodian, [1] ops (registrar, minter, burner, reconciler, snapshots,
 *   dividend issuer), [5] trustee (approves dividends).
 */

export const PSS_DEMO_TOKEN = process.env.NEXT_PUBLIC_PSS_DEMO_TOKEN || '0xD9305D9CD07643745A30Fa3B79C0e8455f1104d3'
export const PSS_DEMO_DISTRIBUTOR = '0x7950439d39C58adE4530F96ca665c18C42Fd05B0'
export const PSS_DEMO_CNGN = '0xF858125fA2cb724119366A5A20A298F5e4154D2d' // stand-in cNGN, test network only
const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
const CHAIN_ID = 84532n

const ABI = [
  'function verified(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function lastReserveShares() view returns (uint256)',
  'function mintHalted() view returns (bool)',
  'function redemptions(uint256) view returns (address holder, uint256 amount, uint8 kind, uint8 status, uint64 createdAt, uint64 closedAt)',
  'function balanceOf(address) view returns (uint256)',
  'function snapshot(string reason) returns (uint256)',
  'event RecordDateSnapshot(uint256 indexed id, uint256 supply, string reason)',
  'function setVerified(address account, bool status)',
  'function mintWithAttestation(address to, uint256 amount, bytes32 tradeRef, uint256 deadline, bytes custodianSignature)',
  'function reportReserve(uint256 reserveShares, bytes32 statementHash)',
  'function completeRedemption(uint256 id, bytes32 settlementRef)',
]

export function demoEnabled(): boolean {
  return !!process.env.NGX_DEMO_KEY
}

function keys() {
  const seed = process.env.NGX_DEMO_KEY
  if (!seed) throw new Error('demo not configured')
  const provider = new ethers.JsonRpcProvider(RPC, Number(CHAIN_ID), { staticNetwork: true })
  const derive = (i: number) => ethers.HDNodeWallet.fromSeed(ethers.keccak256(ethers.toUtf8Bytes(seed + ':' + i))).connect(provider)
  return { provider, root: new ethers.Wallet(seed, provider), custodian: derive(0), ops: derive(1), trustee: derive(5) }
}

// One server process signs for the ops and root keys; serialise so nonces never collide.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

async function topUp(k: ReturnType<typeof keys>, to: string, min: bigint, amount: bigint) {
  if ((await k.provider.getBalance(to)) < min) {
    await (await k.root.sendTransaction({ to, value: amount })).wait(1)
  }
}

/** Mock KYC: put the visitor's demo wallet on the register and give it gas for transfers. */
export function onboard(address: string) {
  return serial(async () => {
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, ABI, k.ops)
    await topUp(k, k.ops.address, ethers.parseEther('0.0001'), ethers.parseEther('0.0002'))
    const txs: string[] = []
    if (!(await t.verified(address))) {
      const tx = await t.setVerified(address, true); await tx.wait(1); txs.push(tx.hash)
    }
    if ((await k.provider.getBalance(address)) < ethers.parseEther('0.000005')) {
      const tx = await k.root.sendTransaction({ to: address, value: ethers.parseEther('0.00001') }); await tx.wait(1); txs.push(tx.hash)
    }
    return { txs }
  })
}

/**
 * Issue tokens against shares that have just landed in the custodian's CSCS pool. The pool rises
 * first and is reported on-chain; the custodian then signs an attestation naming the settlement
 * reference, and only then does the minting service mint against it.
 *   buy         the broker bought on NGX and CSCS settled the trade into the pool
 *   transferIn  the investor moved shares they already own from their current broker into the pool
 */
export const buy = (address: string, quantity: number) => issue(address, quantity, 'NGX-DEMO')
export const transferIn = (address: string, quantity: number) => issue(address, quantity, 'CSCS-XFER-IN')

function issue(address: string, quantity: number, kind: 'NGX-DEMO' | 'CSCS-XFER-IN') {
  return serial(async () => {
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, ABI, k.ops)
    await topUp(k, k.ops.address, ethers.parseEther('0.0001'), ethers.parseEther('0.0002'))
    if (!(await t.verified(address))) throw new Error('wallet not verified')

    const tradeId = `${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const tradeRef = ethers.keccak256(ethers.toUtf8Bytes(tradeId))
    const supply: bigint = await t.totalSupply()
    const reserveTx = await t.reportReserve(supply + BigInt(quantity), ethers.keccak256(ethers.toUtf8Bytes('CSCS-' + tradeId)))
    await reserveTx.wait(1)

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
    const signature = await k.custodian.signTypedData(
      { name: 'PawaEquityToken', version: '1', chainId: CHAIN_ID, verifyingContract: PSS_DEMO_TOKEN },
      { MintAttestation: [
        { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'tradeRef', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
      ] },
      { to: address, amount: BigInt(quantity), tradeRef, deadline },
    )
    const mintTx = await t.mintWithAttestation(address, BigInt(quantity), tradeRef, deadline, signature)
    await mintTx.wait(1)
    return { tradeId, reserveTx: reserveTx.hash, mintTx: mintTx.hash }
  })
}

/** Settle a cash redemption the visitor started: the "sale" settles, the tokens burn, the pool falls. */
export function settle(id: number, address: string) {
  return serial(async () => {
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, ABI, k.ops)
    // The visitor's lock tx may not have reached the node we're reading from yet: retry.
    let r: { holder: string; status: bigint } | null = null
    for (let i = 0; i < 15 && !r; i++) {
      try { r = await t.redemptions(id) } catch { await new Promise((s) => setTimeout(s, 2000)) }
    }
    if (!r) throw new Error('redemption not visible yet, try again')
    if (String(r.holder).toLowerCase() !== address.toLowerCase()) throw new Error('not your redemption')
    if (Number(r.status) !== 0) return { alreadySettled: true }
    const burnTx = await t.completeRedemption(id, ethers.keccak256(ethers.toUtf8Bytes(`NGX-DEMO-SALE-${id}`)))
    await burnTx.wait(1)
    const supply: bigint = await t.totalSupply()
    const reserveTx = await t.reportReserve(supply, ethers.keccak256(ethers.toUtf8Bytes(`CSCS-after-sale-${id}`)))
    await reserveTx.wait(1)
    return { burnTx: burnTx.hash, reserveTx: reserveTx.hash }
  })
}

const DIST_ABI = [
  'function declare(uint256 snapshotId, uint256 total, string paymentRef) returns (uint256)',
  'function approve(uint256 id)',
  'function pay(uint256 id, address account)',
  'event DividendDeclared(uint256 indexed id, uint256 snapshotId, uint256 total, uint256 supplyAt, string paymentRef)',
]
const DIVIDEND_PER_SHARE_NAIRA = 10n
// Each step depends on the one before it, and a lagging node would mis-estimate gas: set it.
const G = { gasLimit: 400_000 }

/**
 * Dividend: the record date is fixed on-chain, the "registrar's payment" arrives as cNGN at the
 * distributor, the issuer declares, the TRUSTEE approves, and the visitor is paid pro-rata.
 */
export function dividend(address: string) {
  return serial(async () => {
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, ABI, k.ops)
    const d = new ethers.Contract(PSS_DEMO_DISTRIBUTOR, DIST_ABI, k.ops)
    const cngn = new ethers.Contract(PSS_DEMO_CNGN, ['function mint(address to, uint256 amount)'], k.root)
    await topUp(k, k.ops.address, ethers.parseEther('0.0001'), ethers.parseEther('0.0002'))
    await topUp(k, k.trustee.address, ethers.parseEther('0.00003'), ethers.parseEther('0.0001'))
    const held: bigint = await t.balanceOf(address)
    if (held === 0n) throw new Error('no shares held')

    const snapTx = await t.snapshot('MTNN dividend (demo)', G)
    const snapRc = await snapTx.wait(1)
    const snap = snapRc!.logs.map((l: ethers.Log) => { try { return t.interface.parseLog(l) } catch { return null } })
      .find((p: ethers.LogDescription | null) => p?.name === 'RecordDateSnapshot')
    const snapshotId: bigint = snap!.args.id
    const total: bigint = (snap!.args.supply as bigint) * DIVIDEND_PER_SHARE_NAIRA * 1_000_000n

    const fundTx = await cngn.mint(PSS_DEMO_DISTRIBUTOR, total, G); await fundTx.wait(1)
    const declareTx = await d.declare(snapshotId, total, `MTNN-DEMO-${Date.now()}`, G)
    const declareRc = await declareTx.wait(1)
    const declared = declareRc!.logs.map((l: ethers.Log) => { try { return d.interface.parseLog(l) } catch { return null } })
      .find((p: ethers.LogDescription | null) => p?.name === 'DividendDeclared')
    const id: bigint = declared!.args.id

    const approveTx = await (d.connect(k.trustee) as ethers.Contract).approve(id, G); await approveTx.wait(1)
    const payTx = await d.pay(id, address, G); await payTx.wait(1)
    return {
      shares: Number(held), perShare: Number(DIVIDEND_PER_SHARE_NAIRA), amount: Number(held * DIVIDEND_PER_SHARE_NAIRA),
      snapshotTx: snapTx.hash, approveTx: approveTx.hash, payTx: payTx.hash,
    }
  })
}
