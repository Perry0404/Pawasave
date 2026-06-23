/**
 * custody.ts — executes on-chain transactions from PawaSave's custody wallet.
 *
 * The custody wallet (FLIPEET_CUSTODY_ADDRESS) holds all user funds.
 * It receives on-ramp cNGN, supplies to PawasaveLend for yield, and
 * sends cNGN to Flipeet's dynamic address on user withdrawals.
 *
 * Required env var: CUSTODY_PRIVATE_KEY
 */

import { ethers } from 'ethers'
import { CONTRACTS, ADDRESSES, LEND_ABI, ERC20_ABI } from './contracts'
import { getSecret } from './secrets'
import { getBaseProvider } from './rpc-provider'

async function getSigner() {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  return new ethers.Wallet(key, getBaseProvider())
}

const b = (v: unknown): bigint => BigInt(v as any ?? 0)

// ── Token transfers ──────────────────────────────────────────────────────────

/** Send USDC from custody to an address (used for Flipeet off-ramp) */
export async function sendUsdc(to: string, amountUsdc: number): Promise<string> {
  const signer = await getSigner()
  const usdc    = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, signer)
  const micro   = BigInt(Math.floor(amountUsdc * 1_000_000))
  const tx      = await usdc.transfer(to, micro)
  const receipt = await tx.wait()
  return receipt.hash
}

/** Send cNGN from custody to an address (used for Flipeet off-ramp with cNGN) */
export async function sendCngn(to: string, cngnMicro: bigint): Promise<string> {
  const signer  = await getSigner()
  const cngn    = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, signer)
  const tx      = await cngn.transfer(to, cngnMicro)
  const receipt = await tx.wait()
  return receipt.hash
}

// ── PawasaveLend interactions ────────────────────────────────────────────────

/**
 * Supply cNGN from custody into PawasaveLend (flexible savings yield).
 * Returns psNGN shares minted.
 */
export async function supplyToLend(cngnMicro: bigint): Promise<{ txHash: string; shares: bigint }> {
  if (cngnMicro <= 0n) throw new Error('Zero supply amount')
  const signer = await getSigner()
  const cngn   = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, signer)
  const lend   = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, signer)

  await (await cngn.approve(ADDRESSES.LEND, cngnMicro)).wait()
  const tx      = await lend.supply(cngnMicro)
  const receipt = await tx.wait()

  const iface = new ethers.Interface([
    'event Supplied(address indexed supplier, uint256 cngnAmount, uint256 shares)',
  ])
  let shares = 0n
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog(log)
      if (p?.name === 'Supplied') shares = b(p.args.shares)
    } catch {}
  }

  return { txHash: receipt.hash, shares }
}

/**
 * Withdraw cNGN from PawasaveLend back to custody (user off-ramp).
 * Pass psNGN shares to redeem. Returns cNGN amount received.
 */
export async function withdrawFromLend(shares: bigint): Promise<{ txHash: string; cngnMicro: bigint }> {
  if (shares <= 0n) throw new Error('Zero shares')
  const signer = await getSigner()
  const lend   = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, signer)

  const tx      = await lend.withdraw(shares)
  const receipt = await tx.wait()

  const iface = new ethers.Interface([
    'event Withdrawn(address indexed supplier, uint256 cngnAmount, uint256 shares)',
  ])
  let cngnMicro = 0n
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog(log)
      if (p?.name === 'Withdrawn') cngnMicro = b(p.args.cngnAmount)
    } catch {}
  }

  return { txHash: receipt.hash, cngnMicro }
}

/** Current cNGN (micro) sitting free in the custody wallet (read-only). */
export async function custodyCngnBalance(): Promise<bigint> {
  const provider = getBaseProvider()
  const cngn     = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, provider)
  const cust     = process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address
  return b(await cngn.balanceOf(cust))
}

/** Get current cNGN value of psNGN shares held by custody (read-only) */
export async function custodyLendValue(): Promise<bigint> {
  const provider = getBaseProvider()
  const lend     = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, provider)
  const cust     = process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address

  const [totalShares, totalAssets, custShares] = await Promise.all([
    lend.totalSupply(),
    lend.totalPoolAssets(),
    lend.balanceOf(cust),
  ])

  const ts = b(totalShares)
  if (ts === 0n) return 0n
  return (b(custShares) * b(totalAssets)) / ts
}

/**
 * Calculate psNGN shares for a given cNGN withdrawal amount.
 * shares = cngnAmount * totalShares / totalPoolAssets
 */
export async function cngnToShares(cngnMicro: bigint): Promise<bigint> {
  const provider = getBaseProvider()
  const lend     = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, provider)

  const [totalShares, totalAssets] = await Promise.all([
    lend.totalSupply(),
    lend.totalPoolAssets(),
  ])

  const ts = b(totalShares)
  const ta = b(totalAssets)
  if (ta === 0n || ts === 0n) return cngnMicro // 1:1 fallback
  return (cngnMicro * ts) / ta
}
