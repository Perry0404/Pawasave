import { ethers } from 'ethers'
import {
  PSS_DEMO_TOKEN, PSS_DEMO_DISTRIBUTOR, PSS_DEMO_CNGN, CHAIN_ID, ABI, DIST_ABI, DIVIDEND_PER_SHARE_NAIRA, G,
  keys, serial, topUp,
} from './pss-demo'

/**
 * Custodian & trustee console for the PSS-1 testnet demo (/pss/custodian).
 *
 * This is the screen the custodian's operations team and the trustee would use: settled CSCS
 * credits arrive in a queue, the custodian reviews and signs each one (which is what lets tokens
 * be minted), posts the daily pool statement, and the trustee approves dividends.
 *
 * In production the custodian signs with its own key in its own HSM and PawaSave never holds it.
 * On the testnet the demo key plays the custodian. The queue is in memory (it resets on redeploy).
 */

const ADA = '0xc943b344a66FE3D0FCa875c329120459CaA9A430'
const BAYO = '0xabC8185390Ba3Aa2F88B302373c62BF996e47680'
const INVESTORS: Record<string, string> = { [ADA]: 'Ada', [BAYO]: 'Bayo' }

type Tx = { label: string; hash: string }

export type Settlement = {
  id: string
  kind: 'trade' | 'transfer_in'
  investor: string
  investorName: string
  quantity: number
  cscsRef: string
  source: string
  receivedAt: number
  status: 'pending' | 'confirmed' | 'rejected'
  reason?: string
  signed?: { to: string; amount: number; tradeRef: string; deadline: number; signature: string }
  txs?: Tx[]
}

export type PendingDividend = {
  id: number
  snapshotId: number
  total: number
  supplyAt: number
  declaredAt: number
  approved: boolean
  paid?: { name: string; amount: number }[]
  txs: Tx[]
}

const queue: Settlement[] = []
let pendingDividend: PendingDividend | null = null

const TOKEN_ABI = [...ABI, 'function sharesRequired() view returns (uint256)', 'function lastReserveAt() view returns (uint64)']

function parse(contract: ethers.Contract, rc: ethers.TransactionReceipt | null, name: string) {
  return rc!.logs.map((l: ethers.Log) => { try { return contract.interface.parseLog(l) } catch { return null } })
    .find((p: ethers.LogDescription | null) => p?.name === name)!
}

/** CSCS credits the pool account: a settled NGX purchase, or a transfer in from another stockbroker. */
export function simulateCredit(kind: 'trade' | 'transfer_in') {
  const investor = Math.random() < 0.5 ? ADA : BAYO
  const quantity = 5 * (1 + Math.floor(Math.random() * 8))
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
  const day = new Date().toISOString().slice(0, 10)
  const item: Settlement = {
    id: `${Date.now()}-${n}`,
    kind,
    investor,
    investorName: INVESTORS[investor],
    quantity,
    cscsRef: kind === 'trade' ? `NGX-${day}-MTNN-${n}` : `CSCS-XFR-${day}-${n}`,
    source: kind === 'trade' ? 'NGX purchase, settled by the broker' : "Transfer in from the investor's previous stockbroker",
    receivedAt: Date.now(),
    status: 'pending',
  }
  queue.unshift(item)
  queue.splice(15)
  return item
}

export function rejectCredit(id: string, reason: string) {
  const item = queue.find((q) => q.id === id)
  if (!item || item.status !== 'pending') throw new Error('not pending')
  item.status = 'rejected'
  item.reason = reason.slice(0, 120) || 'Rejected by the custodian'
  return item
}

/** The custodian confirms: the pool balance is posted, the custodian signs, and only then is the token minted. */
export function confirmCredit(id: string) {
  return serial(async () => {
    const item = queue.find((q) => q.id === id)
    if (!item || item.status !== 'pending') throw new Error('not pending')
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, TOKEN_ABI, k.ops)
    await topUp(k, k.ops.address, ethers.parseEther('0.0001'), ethers.parseEther('0.0002'))
    if (!(await t.verified(item.investor))) throw new Error('investor not verified')

    const supply: bigint = await t.totalSupply()
    const reserveTx = await t.reportReserve(supply + BigInt(item.quantity), ethers.keccak256(ethers.toUtf8Bytes('CSCS-credit-' + item.cscsRef)), G)
    await reserveTx.wait(1)

    const tradeRef = ethers.keccak256(ethers.toUtf8Bytes(item.cscsRef))
    const deadline = Math.floor(Date.now() / 1000) + 600
    const signature = await k.custodian.signTypedData(
      { name: 'PawaEquityToken', version: '1', chainId: CHAIN_ID, verifyingContract: PSS_DEMO_TOKEN },
      { MintAttestation: [
        { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' },
        { name: 'tradeRef', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
      ] },
      { to: item.investor, amount: BigInt(item.quantity), tradeRef, deadline: BigInt(deadline) },
    )
    const mintTx = await t.mintWithAttestation(item.investor, BigInt(item.quantity), tradeRef, BigInt(deadline), signature, G)
    await mintTx.wait(1)
    item.status = 'confirmed'
    item.signed = { to: item.investor, amount: item.quantity, tradeRef, deadline, signature }
    item.txs = [{ label: 'Pool statement', hash: reserveTx.hash }, { label: 'Tokens issued', hash: mintTx.hash }]
    return item
  })
}

/** The daily CSCS statement. Shortfalls are refused on the public demo so a visitor cannot halt the shared token. */
export function postStatement(shares: number) {
  return serial(async () => {
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, TOKEN_ABI, k.ops)
    const required: bigint = await t.sharesRequired()
    if (BigInt(shares) < required) throw new Error('Shortfall statements are disabled on the public demo')
    const tx = await t.reportReserve(BigInt(shares), ethers.keccak256(ethers.toUtf8Bytes(`CSCS-STMT-${new Date().toISOString()}`)), G)
    await tx.wait(1)
    return { tx: tx.hash }
  })
}

/** The registrar's payment arrives for the pool, and the issuer declares the dividend against a fresh record date. */
export function declareDividend() {
  return serial(async () => {
    if (pendingDividend && !pendingDividend.approved) return pendingDividend
    const k = keys()
    const t = new ethers.Contract(PSS_DEMO_TOKEN, TOKEN_ABI, k.ops)
    const d = new ethers.Contract(PSS_DEMO_DISTRIBUTOR, DIST_ABI, k.ops)
    const cngn = new ethers.Contract(PSS_DEMO_CNGN, ['function mint(address to, uint256 amount)'], k.root)
    await topUp(k, k.ops.address, ethers.parseEther('0.0001'), ethers.parseEther('0.0002'))

    const snapTx = await t.snapshot('MTNN dividend (console)', G)
    const snap = parse(t, await snapTx.wait(1), 'RecordDateSnapshot')
    const supplyAt: bigint = snap.args.supply
    const total = supplyAt * DIVIDEND_PER_SHARE_NAIRA * 1_000_000n
    const fundTx = await cngn.mint(PSS_DEMO_DISTRIBUTOR, total, G)
    await fundTx.wait(1)
    const declareTx = await d.declare(snap.args.id, total, `MTNN-CONSOLE-${Date.now()}`, G)
    const declared = parse(d, await declareTx.wait(1), 'DividendDeclared')

    pendingDividend = {
      id: Number(declared.args.id), snapshotId: Number(snap.args.id), total: Number(total / 1_000_000n),
      supplyAt: Number(supplyAt), declaredAt: Date.now(), approved: false,
      txs: [{ label: 'Record date', hash: snapTx.hash }, { label: 'Funds received', hash: fundTx.hash }, { label: 'Declared', hash: declareTx.hash }],
    }
    return pendingDividend
  })
}

/** The trustee approves. Payments then go out from the contract; here, to the two standing demo investors. */
export function approveDividend() {
  return serial(async () => {
    const pd = pendingDividend
    if (!pd || pd.approved) throw new Error('Nothing to approve')
    const k = keys()
    await topUp(k, k.trustee.address, ethers.parseEther('0.00003'), ethers.parseEther('0.0001'))
    const d = new ethers.Contract(PSS_DEMO_DISTRIBUTOR, [
      ...DIST_ABI,
      'function payMany(uint256 id, address[] accounts)',
      'function entitlement(uint256 id, address account) view returns (uint256)',
    ], k.ops)
    const approveTx = await (d.connect(k.trustee) as ethers.Contract).approve(pd.id, G)
    await approveTx.wait(1)
    const paid = await Promise.all([ADA, BAYO].map(async (a) => ({ name: INVESTORS[a], amount: Number((await d.entitlement(pd.id, a)) as bigint) / 1e6 })))
    const payTx = await d.payMany(pd.id, [ADA, BAYO], { gasLimit: 600_000 })
    await payTx.wait(1)
    pd.approved = true
    pd.paid = paid
    pd.txs.push({ label: 'Trustee approval', hash: approveTx.hash }, { label: 'Payments', hash: payTx.hash })
    return pd
  })
}

export async function consoleStatus() {
  const k = keys()
  const t = new ethers.Contract(PSS_DEMO_TOKEN, TOKEN_ABI, k.provider)
  const [supply, required, reserve, reserveAt, halted] = await Promise.all([
    t.totalSupply(), t.sharesRequired(), t.lastReserveShares(), t.lastReserveAt(), t.mintHalted(),
  ])
  return {
    supply: Number(supply), required: Number(required), reserve: Number(reserve), reserveAt: Number(reserveAt), halted: Boolean(halted),
    custodian: k.custodian.address, trustee: k.trustee.address,
    queue, dividend: pendingDividend,
  }
}
