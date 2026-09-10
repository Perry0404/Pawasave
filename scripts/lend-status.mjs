// Read-only PawasaveLend status check (no funds moved).
// Usage: node scripts/lend-status.mjs
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

const RPC = process.env.BASE_MAINNET_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'
const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'

// Candidate LEND pools — the live one is whatever NEXT_PUBLIC_LEND_ADDRESS on
// Vercel points to. We probe both so we can see which has the active borrow.
const CANDIDATES = {
  'V3 live (frontend default)': process.env.PAWASAVE_LEND_ADDRESS || '0x5583802FB2215d550f80DC42CD44C40E0EF8B7cF',
  'abandoned 7d': '0x14c524Eb4b77c706D1eb786603F9885377442B93',
}

// Wallets that might hold cNGN to supply.
const WALLETS = {
  deployer: '0x4985d6Ed512E6403fd9133265c57677788f826AA',
  custody: process.env.FLIPEET_CUSTODY_ADDRESS || process.env.FLINT_CUSTODY_ADDRESS || '',
  safe: '0x04A68bB3056D95fFD64FE681f442BCfc04c79109',
}

const LEND_ABI = [
  'function paused() view returns (bool)',
  'function totalPoolAssets() view returns (uint256)',
  'function getCash() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function exchangeRate() view returns (uint256)',
  'function maxBorrowPerUser() view returns (uint256)',
]
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

const f = (v) => (Number(v) / 1e6).toLocaleString('en-NG', { maximumFractionDigits: 2 })

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 8453)
  console.log(`RPC: ${RPC}\n`)

  for (const [label, addr] of Object.entries(CANDIDATES)) {
    console.log(`── ${label}\n   ${addr}`)
    try {
      const code = await provider.getCode(addr)
      if (code === '0x') { console.log('   ❌ no contract at this address\n'); continue }
      const lend = new ethers.Contract(addr, LEND_ABI, provider)
      const [paused, pool, cash, borrows, supply] = await Promise.all([
        lend.paused().catch(() => null),
        lend.totalPoolAssets().catch(() => null),
        lend.getCash().catch(() => null),
        lend.totalBorrows().catch(() => null),
        lend.totalSupply().catch(() => null),
      ])
      console.log(`   paused:        ${paused}`)
      console.log(`   totalBorrows:  ${borrows == null ? '?' : f(borrows)} cNGN   ${borrows > 0n ? '← ACTIVE BORROWER' : ''}`)
      console.log(`   getCash:       ${cash == null ? '?' : f(cash)} cNGN  (available to lend)`)
      console.log(`   totalPool:     ${pool == null ? '?' : f(pool)} cNGN`)
      console.log(`   psNGN supply:  ${supply == null ? '?' : f(supply)}\n`)
    } catch (e) {
      console.log(`   error: ${e.shortMessage || e.message}\n`)
    }
  }

  console.log('── cNGN balances of candidate supplier wallets')
  const cngn = new ethers.Contract(CNGN, ERC20_ABI, provider)
  for (const [label, addr] of Object.entries(WALLETS)) {
    if (!addr) { console.log(`   ${label}: (address not set)`); continue }
    try {
      const bal = await cngn.balanceOf(addr)
      console.log(`   ${label.padEnd(9)} ${addr}  →  ${f(bal)} cNGN`)
    } catch (e) {
      console.log(`   ${label}: error ${e.shortMessage || e.message}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })