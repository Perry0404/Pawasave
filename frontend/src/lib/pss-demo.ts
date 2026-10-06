import { ethers } from 'ethers'

/**
 * Server side of the PSS-1 testnet demo (/pss/demo): plays the issuer's ops service, the broker
 * and the custodian on Base Sepolia so a visitor can buy, transfer and redeem real testnet tokens.
 *
 * TESTNET ONLY. NGX_DEMO_KEY is a Base Sepolia key with no mainnet value. The role keys are
 * derived from it exactly as scripts/ngx-token-demo.ts derives them:
 *   root (admin / gas), [0] custodian, [1] ops (registrar, minter, burner, reconciler).
 */

export const PSS_DEMO_TOKEN = process.env.NEXT_PUBLIC_PSS_DEMO_TOKEN || '0xde5636D192bdF5DfD164107D804826B69b9DE35C'
const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
const CHAIN_ID = 84532n

const ABI = [
  'function verified(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function lastReserveShares() view returns (uint256)',
  'function mintHalted() view returns (bool)',
  'function redemptions(uint256) view returns (address holder, uint256 amount, uint8 kind, uint8 status, uint64 createdAt)',
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
  return { provider, root: new ethers.Wallet(seed, provider), custodian: derive(0), ops: derive(1) }
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
 * Buy: the broker "executes" on NGX and CSCS "settles", so the custodian's pool rises first and
 * is reported on-chain. The custodian then signs an attestation for this trade, and only then
 * does the minting service mint against it.
 */
export function buy(address: string, quantity: number) {
  return serial(async () => {
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, ABI, k.ops)
    await topUp(k, k.ops.address, ethers.parseEther('0.0001'), ethers.parseEther('0.0002'))
    if (!(await t.verified(address))) throw new Error('wallet not verified')

    const tradeId = `NGX-DEMO-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
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
