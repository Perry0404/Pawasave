// Raise the per-user borrow cap (maxBorrowPerUser) on the live PawasaveLend.
// Reads current owner + cap, then prints the exact call to make from the Safe.
// If OWNER_PRIVATE_KEY is set AND it equals the on-chain owner (i.e. owner is an
// EOA, not the Safe), it sends the tx directly; otherwise it just prints the
// Safe transaction for you to execute at app.safe.global.
//
// Env: BASE_MAINNET_RPC_URL, PAWASAVE_LEND_ADDRESS (optional), NEW_MAX_CNGN
//      (whole cNGN, default 200000000), OWNER_PRIVATE_KEY (optional).
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

const RPC  = process.env.BASE_MAINNET_RPC_URL || 'https://base-rpc.publicnode.com'
const LEND = process.env.PAWASAVE_LEND_ADDRESS || '0x14c524Eb4b77c706D1eb786603F9885377442B93'
const NEW_MAX_WHOLE = Number(process.env.NEW_MAX_CNGN || 200_000_000)
const newMax = BigInt(Math.round(NEW_MAX_WHOLE * 1e6)) // 6 decimals

const ABI = [
  'function owner() view returns (address)',
  'function maxBorrowPerUser() view returns (uint256)',
  'function getCash() view returns (uint256)',
  'function setMaxBorrowPerUser(uint256 newMax)',
]
const f = (v) => (Number(v) / 1e6).toLocaleString('en-NG', { maximumFractionDigits: 2 })

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453)
  const iface = new ethers.Interface(ABI)
  const lend = new ethers.Contract(LEND, ABI, provider)

  const [owner, current, cash] = await Promise.all([
    lend.owner(), lend.maxBorrowPerUser(), lend.getCash(),
  ])
  console.log(`Pool:               ${LEND}`)
  console.log(`Owner:              ${owner}`)
  console.log(`Current per-user cap: ${f(current)} cNGN`)
  console.log(`New per-user cap:     ${f(newMax)} cNGN  (raw ${newMax})`)
  console.log(`Pool liquidity now:   ${f(cash)} cNGN\n`)

  const calldata = iface.encodeFunctionData('setMaxBorrowPerUser', [newMax])
  console.log('── Safe transaction (execute at app.safe.global)')
  console.log(`   To:        ${LEND}`)
  console.log(`   Value:     0`)
  console.log(`   Method:    setMaxBorrowPerUser(uint256)`)
  console.log(`   newMax:    ${newMax}`)
  console.log(`   Calldata:  ${calldata}\n`)

  const key = process.env.OWNER_PRIVATE_KEY
  if (key) {
    const wallet = new ethers.Wallet(key, provider)
    if (wallet.address.toLowerCase() === owner.toLowerCase()) {
      console.log('OWNER_PRIVATE_KEY matches the on-chain owner — sending tx…')
      const tx = await new ethers.Contract(LEND, ABI, wallet).setMaxBorrowPerUser(newMax)
      console.log(`  tx: ${tx.hash}`)
      await tx.wait().catch(() => {})
      const after = await lend.maxBorrowPerUser()
      console.log(`  confirmed cap: ${f(after)} cNGN`)
    } else {
      console.log(`OWNER_PRIVATE_KEY (${wallet.address}) is NOT the owner — use the Safe tx above.`)
    }
  }
}

main().catch((e) => { console.error('\n❌', e.shortMessage || e.message); process.exit(1) })