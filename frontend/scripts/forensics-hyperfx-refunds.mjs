/**
 * Checks whether the stranded HyperFX orders were refunded, and who paid to make that happen.
 * Read-only. Run: node scripts/forensics-hyperfx-refunds.mjs
 */
import { ethers } from 'ethers'

const RPC = process.env.BASE_WRITE_RPC_URL
const CUSTODY = '0xabc8c660f6d217812d57c22db10c765fc63f4b5d'
const GATEWAY = '0xae041f7b0cb581876832830baeb6a2aa2a3c9716'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CNGN = '0x46c85152bfe9f96829aa94755d9f915f9b10ef5f'

const provider = new ethers.JsonRpcProvider(RPC, 8453)
const fmt = (v) => (Number(v) / 1e6).toFixed(6)

// What we escrowed on 7 Sep, from the placeOrder calldata.
const ESCROWED = [
  ['0xbdd5bd90e7f10da271946fa496ca0ae1f5d0937a887dbef44932eecaffb9d867', 1259736n, 3],
  ['0x43e43cce885e022517bd1d4ba94e5c61b8330d399f7e50d58f7397277c2d935b', 1225739n, 6],
  ['0x36b2505d2dbc57665951e2357c1c7e9701b26eaff0faa2135be37b7e0f2e9676', 1225739n, 6],
  ['0xf1d6773c569888669bc49db2fb800d7b082d8c78d2342a2345659eadb23d26ed', 1225739n, 6],
  ['0x955260c13b79f8e552b2f86db107957a06f0f1c4bb2c83a7bd87d0edb4437229', 723356n, 7],
  ['0x0d1d5bbbdc63ae3d4d0ecfc32d126c4027ea7f55e986a8343729454899bb8ddd', 723356n, 7],
]

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

async function main() {
  const head = await provider.getBlockNumber()

  const res = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: ethers.toBeHex(head - 60_000), toBlock: 'latest',
    toAddress: CUSTODY, category: ['erc20'],
    contractAddresses: [ethers.getAddress(USDC), ethers.getAddress(CNGN)],
    withMetadata: true, maxCount: '0x3e8',
  }])

  const fromGateway = res.transfers.filter((t) => (t.from ?? '').toLowerCase() === GATEWAY)
  console.log(`${fromGateway.length} transfers from the gateway back to custody\n`)

  let refundedTotal = 0n
  const byTx = new Map()
  for (const t of fromGateway) {
    const amt = BigInt(t.rawContract?.value ?? '0x0')
    refundedTotal += amt
    const e = byTx.get(t.hash) || { ts: t.metadata?.blockTimestamp, legs: [] }
    e.legs.push(amt)
    byTx.set(t.hash, e)
  }

  console.log('Refund transactions, and who sent them\n')
  for (const [hash, e] of byTx) {
    const tx = await provider.getTransaction(hash)
    const who = (tx?.from ?? '').toLowerCase() === CUSTODY ? 'CUSTODY paid for this' : `sent by ${tx?.from}`
    console.log(`${e.ts}  ${e.legs.map(fmt).join(' + ')} USDC  ${who}`)
    console.log(`    ${hash}  to ${tx?.to}`)
  }

  const escrowedTotal = ESCROWED.reduce((s, [, a]) => s + a, 0n)
  console.log(`\nescrowed inputs on 7 Sep : ${fmt(escrowedTotal)} USDC`)
  console.log(`came back from gateway    : ${fmt(refundedTotal)} USDC  (includes the solver fees)`)

  console.log('\nCurrent custody position\n')
  console.log(`  ETH  ${ethers.formatEther(await provider.getBalance(CUSTODY))}`)
  for (const [name, addr] of [['USDC', USDC], ['cNGN', CNGN]]) {
    const c = new ethers.Contract(ethers.getAddress(addr), ['function balanceOf(address) view returns (uint256)'], provider)
    console.log(`  ${name} ${fmt(await c.balanceOf(CUSTODY))}`)
  }

  // Anything still escrowed would show as a later placeOrder with no matching return.
  const out = await rpc('alchemy_getAssetTransfers', [{
    fromBlock: ethers.toBeHex(head - 60_000), toBlock: 'latest',
    fromAddress: CUSTODY, category: ['erc20'],
    contractAddresses: [ethers.getAddress(USDC), ethers.getAddress(CNGN)],
    withMetadata: true, maxCount: '0x3e8',
  }])
  const toGateway = out.transfers.filter((t) => (t.to ?? '').toLowerCase() === GATEWAY)
  console.log(`\n${toGateway.length} transfers into the gateway in the same window`)
  for (const t of toGateway) {
    console.log(`  ${t.metadata?.blockTimestamp}  ${fmt(BigInt(t.rawContract?.value ?? '0x0'))}  ${t.hash}`)
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
