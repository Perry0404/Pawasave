// Supply cNGN into the live PawasaveLend pool (provides borrower liquidity).
// Robust single-tx + on-chain confirmation polling (Base RPCs are flaky).
//
// Required env (.env):
//   BASE_MAINNET_RPC_URL        — a reliable Base RPC (publicnode works well)
//   SUPPLIER_PRIVATE_KEY        — key of the wallet that HOLDS the cNGN to supply
//                                 (falls back to DEPLOYER_PRIVATE_KEY)
//   SUPPLY_AMOUNT_CNGN          — whole cNGN to supply, e.g. 500000
// Optional:
//   PAWASAVE_LEND_ADDRESS       — defaults to the 7d live pool
//
// Run:  node scripts/supply-lend.mjs
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

const RPC  = process.env.BASE_MAINNET_RPC_URL || 'https://base-rpc.publicnode.com'
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'
const LEND = process.env.PAWASAVE_LEND_ADDRESS || '0x5583802FB2215d550f80DC42CD44C40E0EF8B7cF' // v3 lend
const KEY  = process.env.SUPPLIER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY
const AMOUNT_WHOLE = Number(process.env.SUPPLY_AMOUNT_CNGN || 0)

const LEND_ABI = [
  'function supply(uint256 cngnAmount) returns (uint256 shares)',
  'function getCash() view returns (uint256)',
  'function totalPoolAssets() view returns (uint256)',
  'function supplyCap() view returns (uint256)',
  'function paused() view returns (bool)',
]
const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]

const f = (v) => (Number(v) / 1e6).toLocaleString('en-NG', { maximumFractionDigits: 2 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!KEY) throw new Error('Set SUPPLIER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env')
  if (!Number.isFinite(AMOUNT_WHOLE) || AMOUNT_WHOLE <= 0) throw new Error('Set SUPPLY_AMOUNT_CNGN (whole cNGN, > 0)')

  const amount = BigInt(Math.round(AMOUNT_WHOLE * 1e6)) // 6 decimals
  const provider = new ethers.JsonRpcProvider(RPC, 8453)
  const signer = new ethers.Wallet(KEY, provider)
  const cngn = new ethers.Contract(CNGN, ERC20_ABI, signer)
  const lend = new ethers.Contract(LEND, LEND_ABI, signer)

  console.log(`Supplier:  ${signer.address}`)
  console.log(`Pool:      ${LEND}`)
  console.log(`Amount:    ${f(amount)} cNGN\n`)

  if (await lend.paused()) throw new Error('Pool is paused — cannot supply')

  const bal = await cngn.balanceOf(signer.address)
  console.log(`Supplier cNGN balance: ${f(bal)}`)
  if (bal < amount) throw new Error(`Insufficient cNGN: have ${f(bal)}, need ${f(amount)}`)

  const cap = await lend.supplyCap().catch(() => 0n)
  const before = await lend.getCash()
  if (cap > 0n && before + amount > cap) throw new Error(`Supply would exceed supplyCap (${f(cap)})`)
  console.log(`Pool cash before: ${f(before)} cNGN`)

  // 1) approve (only if needed)
  const allowance = await cngn.allowance(signer.address, LEND)
  if (allowance < amount) {
    console.log('Approving cNGN…')
    const a = await cngn.approve(LEND, amount)
    await a.wait()
    console.log(`  approved: ${a.hash}`)
  }

  // 2) supply
  console.log('Supplying…')
  const tx = await lend.supply(amount)
  console.log(`  supply tx: ${tx.hash}`)
  await tx.wait().catch(() => {}) // receipt may be flaky; confirm via state below

  // 3) confirm on-chain (poll getCash up ~by amount)
  for (let i = 0; i < 20; i++) {
    const after = await lend.getCash().catch(() => before)
    if (after >= before + amount - 10n) {
      console.log(`\n✅ Confirmed. Pool cash now: ${f(after)} cNGN (available to borrowers)`)
      return
    }
    await sleep(3000)
  }
  console.log('\n⚠️ Could not confirm via getCash() in time — check the tx hash on basescan.')
}

main().catch((e) => { console.error('\n❌', e.shortMessage || e.message); process.exit(1) })