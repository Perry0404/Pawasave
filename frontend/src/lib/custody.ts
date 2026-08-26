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
import { getWriteProvider, withBaseRead, alchemyAssetTransfers } from './rpc-provider'

async function getSigner() {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  // Sign through a SINGLE RPC (not the FallbackProvider) so sequential custody
  // txs — e.g. off-ramp's withdraw-from-pool then send-to-provider — get a
  // consistent nonce and don't stall with funds stuck in custody.
  return new ethers.Wallet(key, getWriteProvider())
}

const b = (v: unknown): bigint => BigInt(v as any ?? 0)

// Public Base RPCs (mainnet.base.org, etc.) are load balancers over many nodes
// with inconsistent state. ethers' default estimateGas preflight runs against
// whichever node answers "latest" — which may lag a just-mined tx (e.g. an
// approve), making the preflight revert ("insufficient allowance", "transfer
// exceeds balance") even though the real tx would succeed against consensus.
// Passing an explicit gasLimit skips that preflight so the tx goes straight to
// the mempool and executes against real state. Base gas is fractions of a cent,
// so generous headroom is free. (The durable fix is a paid, single-node RPC via
// BASE_WRITE_RPC_URL — these caps just make public RPCs survivable.)
const GAS = {
  erc20Transfer: 120_000n,
  approve:       120_000n,
  supply:        500_000n,
  withdraw:      500_000n,
} as const

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * The custody wallet address — where on-ramped cNGN is delivered and the wallet
 * off-ramps draw from. Falls back to the CUSTODY_PRIVATE_KEY wallet address when
 * FLIPEET_CUSTODY_ADDRESS isn't readable (it's marked "Sensitive" in production,
 * so code must never depend on reading the env var). Deriving from the signer
 * guarantees the on-ramp `destination` is always present.
 */
export async function custodyAddress(): Promise<string> {
  return process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address
}

// ── Token transfers ──────────────────────────────────────────────────────────

/** Send USDC from custody to an address (used for Flipeet off-ramp) */
export async function sendUsdc(to: string, amountUsdc: number): Promise<string> {
  const signer = await getSigner()
  const usdc    = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, signer)
  const micro   = BigInt(Math.floor(amountUsdc * 1_000_000))
  const tx      = await usdc.transfer(to, micro, { gasLimit: GAS.erc20Transfer })
  const receipt = await tx.wait()
  return receipt.hash
}

/**
 * Send cNGN from custody to an address (used for Flipeet off-ramp with cNGN).
 * Returns the tx hash as soon as the transfer is BROADCAST — it does NOT block on
 * confirmation. Waiting for the receipt (5s+ on a slow public RPC) is what pushed
 * the off-ramp request past its serverless timeout, so the DB "completed" update
 * never ran and delivered withdrawals sat stuck on 'pending'. The tx is already in
 * the mempool and will mine on its own even after the function returns; custody's
 * balance is verified before this is called, and gas is fixed, so it won't revert.
 */
export async function sendCngn(to: string, cngnMicro: bigint): Promise<string> {
  const signer = await getSigner()
  const cngn   = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, signer)
  const tx     = await cngn.transfer(to, cngnMicro, { gasLimit: GAS.erc20Transfer })
  return tx.hash
}

// ── PawasaveLend interactions ────────────────────────────────────────────────

/**
 * Supply cNGN from custody into PawasaveLend (flexible savings yield).
 * Returns psNGN shares minted.
 */
export async function supplyToLend(cngnMicro: bigint): Promise<{ txHash: string; shares: bigint }> {
  if (cngnMicro <= 0n) throw new Error('Zero supply amount')
  const signer = await getSigner()
  const owner  = await signer.getAddress()
  const cngn   = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, signer)
  const lend   = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, signer)

  // Approve only when the standing allowance is short, and approve the MAX so
  // future supplies never re-approve — that removes the approve→supply read-after
  // -write race on public RPCs (the "insufficient allowance" revert) for every
  // supply after the first. Wait a full confirmation so the approve is in a block
  // before we submit supply (which skips its own estimateGas via GAS.supply).
  const current = b(await cngn.allowance(owner, ADDRESSES.LEND))
  if (current < cngnMicro) {
    await (await cngn.approve(ADDRESSES.LEND, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
  }
  const tx      = await lend.supply(cngnMicro, { gasLimit: GAS.supply })
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

  const tx      = await lend.withdraw(shares, { gasLimit: GAS.withdraw })
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

/**
 * cNGN (micro) held by ANY address. Used to size a Strails sweep: their
 * getuserdetails response carries no balance field, so the chain is the only
 * authoritative source for how much a user's Strails wallet actually holds.
 */
export async function cngnBalanceOf(address: string): Promise<bigint> {
  return withBaseRead(async (provider) => {
    const cngn = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, provider)
    return b(await cngn.balanceOf(address))
  })
}

const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)']

/**
 * Did custody send cNGN to `target`? Returns the matching transfer's tx hash +
 * amount (micro), or null if none. This is the DETERMINISTIC settlement proof for
 * off-ramp reconciliation: `target` is the provider's unique per-withdrawal deposit
 * address, so a custody→target cNGN transfer proves that exact withdrawal left
 * custody — no amount/time guessing.
 *
 * Primary path is Alchemy's alchemy_getAssetTransfers (no block-range cap, so it
 * works on the free tier where a chunked getLogs scan 400s). Falls back to a
 * chunked getLogs scan for a non-Alchemy/paid RPC; `ageMinutes` sizes that window.
 */
export async function custodyCngnTransferTo(
  target: string,
  ageMinutes = 180,
): Promise<{ hash: string; amountMicro: bigint } | null> {
  const custody = await custodyAddress()

  // Primary: Alchemy enhanced API — no getLogs range cap.
  try {
    const transfers = await alchemyAssetTransfers({
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: custody,
      toAddress: target,
      contractAddresses: [CONTRACTS.CNGN],
      category: ['erc20'],
      excludeZeroValue: true,
      maxCount: '0xa',
      order: 'desc',
    })
    if (transfers.length > 0) {
      const t = transfers[0]
      const micro = t.rawContract?.value ? b(t.rawContract.value) : 0n
      return { hash: t.hash, amountMicro: micro }
    }
    return null
  } catch {
    // Fallback: chunked getLogs (works on a paid/uncapped RPC).
    return withBaseRead(async (provider) => {
      const cngn = new ethers.Contract(CONTRACTS.CNGN, TRANSFER_ABI, provider)
      const now = await provider.getBlockNumber()
      const span = Math.min(120_000, Math.ceil(ageMinutes * 30) + 1_000) // Base ~30 blk/min
      const chunk = 9_000
      for (let end = now; end > now - span; end -= chunk) {
        const start = Math.max(0, end - chunk + 1)
        const logs = await cngn.queryFilter(cngn.filters.Transfer(custody, target), start, end)
        if (logs.length > 0) {
          const l = logs[logs.length - 1] as ethers.EventLog
          return { hash: l.transactionHash, amountMicro: b(l.args.value) }
        }
        if (start === 0) break
      }
      return null
    })
  }
}

/** Current cNGN (micro) sitting free in the custody wallet (read-only). */
export async function custodyCngnBalance(): Promise<bigint> {
  const cust = process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address
  // Read via withBaseRead (single endpoint at a time) — this runs inside the
  // off-ramp critical path, where the FallbackProvider's "could not coalesce
  // error" on simultaneously rate-limited public RPCs stranded funds mid-flow.
  return withBaseRead(async (provider) => {
    const cngn = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, provider)
    return b(await cngn.balanceOf(cust))
  })
}

/**
 * cNGN (micro) sitting free in custody, read through the SINGLE write RPC
 * (BASE_WRITE_RPC_URL / Alchemy) rather than the public FallbackProvider pool.
 *
 * Use this right after a custody write (e.g. a pool withdraw) that must be
 * observed by its own follow-up logic: withBaseRead may answer from a lagging
 * public node that hasn't seen the just-mined block yet and report the stale
 * pre-write balance, which was making equity buys falsely fail "custody ~₦0
 * after pool withdraw" even though the LEND→custody redeem had mined. The write
 * provider is the same endpoint the tx was confirmed on, so it is read-after
 * -write consistent.
 */
export async function custodyCngnBalanceFresh(): Promise<bigint> {
  const cust = process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address
  const cngn = new ethers.Contract(CONTRACTS.CNGN, ERC20_ABI, getWriteProvider())
  return b(await cngn.balanceOf(cust))
}

/** Get current cNGN value of psNGN shares held by custody (read-only) */
export async function custodyLendValue(): Promise<bigint> {
  const cust = process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address
  return withBaseRead(async (provider) => {
    const lend = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, provider)
    const [totalShares, totalAssets, custShares] = await Promise.all([
      lend.totalSupply(),
      lend.totalPoolAssets(),
      lend.balanceOf(cust),
    ])
    const ts = b(totalShares)
    if (ts === 0n) return 0n
    return (b(custShares) * b(totalAssets)) / ts
  })
}

/** psNGN (Lend) shares currently held by custody (read-only). */
export async function custodyLendShares(): Promise<bigint> {
  const cust = process.env.FLIPEET_CUSTODY_ADDRESS || (await getSigner()).address
  return withBaseRead(async (provider) => {
    const lend = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, provider)
    return b(await lend.balanceOf(cust))
  })
}

/**
 * Calculate psNGN shares for a given cNGN withdrawal amount.
 * shares = cngnAmount * totalShares / totalPoolAssets
 * Reads via withBaseRead — it feeds the off-ramp redeem, so an opaque
 * FallbackProvider "coalesce" failure here must not strand the withdrawal.
 */
export async function cngnToShares(cngnMicro: bigint): Promise<bigint> {
  return withBaseRead(async (provider) => {
    const lend = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, provider)
    const [totalShares, totalAssets] = await Promise.all([
      lend.totalSupply(),
      lend.totalPoolAssets(),
    ])
    const ts = b(totalShares)
    const ta = b(totalAssets)
    if (ta === 0n || ts === 0n) return cngnMicro // 1:1 fallback
    return (cngnMicro * ts) / ta
  })
}
