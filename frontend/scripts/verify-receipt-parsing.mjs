/**
 * Checks the receipt-parsing attribution against real swaps custody already made, by
 * comparing what the logs say custody received to what the indexer reports.
 * Read-only. Run: node scripts/verify-receipt-parsing.mjs
 */
import { ethers } from 'ethers'

const RPC = process.env.BASE_WRITE_RPC_URL
const CUSTODY = '0xaBc8c660F6d217812D57c22db10c765fC63F4B5d'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'

const provider = new ethers.JsonRpcProvider(RPC, 8453)
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

// Same implementation as equity-broker.transferredTo, kept in step by hand.
function transferredTo(receipt, token, recipient) {
  const wantToken = token.toLowerCase()
  const wantTo = ethers.zeroPadValue(recipient, 32).toLowerCase()
  let total = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== wantToken) continue
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue
    if (log.topics[2].toLowerCase() !== wantTo) continue
    total += BigInt(log.data)
  }
  return total
}

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
    fromBlock: ethers.toBeHex(head - 200_000), toBlock: 'latest',
    toAddress: CUSTODY.toLowerCase(), category: ['erc20'],
    contractAddresses: [USDC, CNGN], withMetadata: true, maxCount: '0x3e8',
  }])

  // One row per transaction, so a multi-transfer tx is checked as a whole.
  const byTx = new Map()
  for (const t of res.transfers) {
    const token = (t.rawContract?.address ?? '').toLowerCase()
    const key = `${t.hash}|${token}`
    const e = byTx.get(key) || { hash: t.hash, token, expected: 0n, ts: t.metadata?.blockTimestamp, n: 0 }
    e.expected += BigInt(t.rawContract?.value ?? '0x0')
    e.n++
    byTx.set(key, e)
  }

  console.log(`checking ${byTx.size} (transaction, token) pairs where custody received funds\n`)
  let pass = 0
  let fail = 0
  for (const e of [...byTx.values()].slice(-18)) {
    const receipt = await provider.getTransactionReceipt(e.hash)
    if (!receipt) { console.log(`  SKIP ${e.hash} no receipt`); continue }
    const parsed = transferredTo(receipt, e.token, CUSTODY)
    const ok = parsed === e.expected
    ok ? pass++ : fail++
    const name = e.token === USDC.toLowerCase() ? 'USDC' : 'cNGN'
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${e.ts}  ${name}  ${e.n} transfer(s)  ` +
      `indexer ${e.expected}  parsed ${parsed}`,
    )
  }
  console.log(`\n${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
