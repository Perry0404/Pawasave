/**
 * Decodes the placeOrder calldata of custody's HyperFX orders so each escrowed order can
 * be reconstructed exactly, which is what cancelOrder needs to reclaim the input.
 * Read-only. Run: node scripts/forensics-hyperfx-decode.mjs
 */
import { ethers } from 'ethers'

const RPC = process.env.BASE_WRITE_RPC_URL
const provider = new ethers.JsonRpcProvider(RPC, 8453)

// The six usdc->cngn orders that escrowed USDC and never returned cNGN, plus the six
// cngn->usdc orders that did fill, for comparison.
const STUCK = [
  ['2026-09-07T18:29:01Z', '0xbdd5bd90e7f10da271946fa496ca0ae1f5d0937a887dbef44932eecaffb9d867'],
  ['2026-09-07T22:19:31Z', '0x43e43cce885e022517bd1d4ba94e5c61b8330d399f7e50d58f7397277c2d935b'],
  ['2026-09-07T22:22:59Z', '0x36b2505d2dbc57665951e2357c1c7e9701b26eaff0faa2135be37b7e0f2e9676'],
  ['2026-09-07T22:40:13Z', '0xf1d6773c569888669bc49db2fb800d7b082d8c78d2342a2345659eadb23d26ed'],
  ['2026-09-07T22:43:33Z', '0x955260c13b79f8e552b2f86db107957a06f0f1c4bb2c83a7bd87d0edb4437229'],
  ['2026-09-07T22:46:59Z', '0x0d1d5bbbdc63ae3d4d0ecfc32d126c4027ea7f55e986a8343729454899bb8ddd'],
]
const FILLED = [
  ['2026-09-05T14:24:19Z', '0x43e452a88b91fb9cf35e72fa2b74235c1f9cb31540287e7b4e892d8b0255aaed'],
  ['2026-09-04T17:51:43Z', '0xd233982f78ad92a81b21431000a45e8b473ae9e0b0781b7e046768f7ed0662ac'],
]

// Word layout of the placeOrder head, confirmed against real calldata. The order struct
// starts at word 2 because word 0 is its offset and word 1 is the graffiti.
const FIELDS = { 2: 'user', 5: 'deadline', 6: 'nonce', 7: 'fees', 8: 'session' }

async function main() {
  for (const [label, list] of [['UNFILLED usdc->cngn', STUCK], ['FILLED cngn->usdc', FILLED]]) {
    console.log(`\n===== ${label} =====\n`)
    for (const [ts, hash] of list) {
      const tx = await provider.getTransaction(hash)
      const rcpt = await provider.getTransactionReceipt(hash)
      console.log(`${ts}  ${hash}`)
      console.log(`  block ${tx.blockNumber}  to ${tx.to}  status ${rcpt.status}  selector ${tx.data.slice(0, 10)}`)
      console.log(`  calldata ${tx.data.length / 2 - 1} bytes, ${rcpt.logs.length} logs`)

      // The order struct is ABI-encoded in the calldata after the 4-byte selector. Rather
      // than guess the exact tuple layout, pull the two fields that matter for a cancel:
      // deadline and nonce sit at fixed word offsets in the head of the struct.
      const body = '0x' + tx.data.slice(10)
      const words = []
      for (let i = 0; i < Math.min(body.length - 2, 20 * 64); i += 64) {
        words.push(body.slice(2 + i, 2 + i + 64))
      }
      words.forEach((w, i) => {
        const n = BigInt('0x' + w)
        const label = FIELDS[i] ? ` ${FIELDS[i]}` : ''
        const val = n < 10n ** 12n ? `   (${n})` : ''
        console.log(`    word ${String(i).padStart(2)}${label.padEnd(10)} 0x${w}${val}`)
      })
      console.log()
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
