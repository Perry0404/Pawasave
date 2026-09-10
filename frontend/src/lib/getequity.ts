/**
 * getequity.ts — PawaSave ⇄ GetEquity on-chain RWA investment wrapper.
 *
 * GetEquity tokenises regulated Nigerian investment products (Treasury bills,
 * mutual funds, REITs, private raises) as ERC-20 "RWA tokens" on Base. Each token
 * trades against a single Market contract at an admin-set price, settles in a
 * per-asset payout token (cNGN or USDC — ALWAYS read `payoutToken()`, never assume),
 * and — for debt/fund instruments — accrues interest that is claimed via
 * `claimPayout()`. This is the yield inventory for PawaSave's Invest tab.
 *
 * We integrate at the CONTRACT layer (not their REST API) because PawaSave already
 * holds cNGN in custody and speaks Base — buying an RWA is the exact approve→call
 * shape as supplyToLend(). The API's fund-invest path routes through Flutterwave
 * fiat and their fees, which would break the cNGN settlement story.
 *
 * STATUS: DARK. GetEquity is on Base Sepolia (chain 84532); mainnet is pending
 * (~ Aug 2026 per their team). Nothing here runs unless GETEQUITY_ENABLED is set
 * AND GETEQUITY_MARKET_ADDRESS is configured — every export is a no-op / throws
 * clearly otherwise, so this file is inert dead code until we flip it on. Built
 * behind a flag the same way the Strails ramp was (see [[strails-ramp]]).
 *
 * Required env when enabled:
 *   GETEQUITY_ENABLED=1
 *   GETEQUITY_RPC_URL         — RPC for GetEquity's chain (Base Sepolia now, Base mainnet later)
 *   GETEQUITY_MARKET_ADDRESS  — the Market contract (0x68543Dc7…C4bc on Sepolia)
 *   CUSTODY_PRIVATE_KEY       — reused; the custody wallet buys/holds the positions
 *
 * Contracts (Base Sepolia testnet — swap for mainnet on their launch):
 *   Market   0x68543Dc71F76d0835e724dbEF898Dd010209C4bc
 *   cNGN     0x7E29CF1D8b1F4c847D0f821b79dDF6E67A5c11F8
 *   NTBL     0xda42AEaC0A2ab7938C20Eb75221e9678f0d431aD  (Nigerian Treasury Bill)
 *   ANMF     0xBdd5357A6c17B3d55Ab0A15C608d26A357c2C8C5  (ARM NGN Mutual Fund)
 */

import { ethers } from 'ethers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSecret } from './secrets'

export const GETEQUITY_ENABLED =
  !!process.env.GETEQUITY_ENABLED && !!process.env.GETEQUITY_MARKET_ADDRESS

const MARKET_ADDRESS = (process.env.GETEQUITY_MARKET_ADDRESS || '') as string

// GetEquity's chain is distinct from PawaSave custody's mainnet write RPC while
// they're on testnet, so this client carries its OWN provider. Once GetEquity is
// on Base mainnet, point GETEQUITY_RPC_URL at the same paid RPC as BASE_WRITE_RPC_URL.
function getProvider(): ethers.JsonRpcProvider {
  const url = process.env.GETEQUITY_RPC_URL
  if (!url) throw new Error('GETEQUITY_RPC_URL not configured')
  return new ethers.JsonRpcProvider(url)
}

async function getSigner(): Promise<ethers.Wallet> {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  return new ethers.Wallet(key, getProvider())
}

const b = (v: unknown): bigint => BigInt((v as any) ?? 0)
const MAX_UINT256 = (1n << 256n) - 1n

// Explicit gas caps skip ethers' estimateGas preflight, which reverts spuriously
// against lagging public-RPC nodes on read-after-write (approve→buy). Same reason
// and pattern as custody.ts. Base gas is fractions of a cent, so headroom is free.
const GAS = {
  approve: 120_000n,
  buy:     600_000n,
  sell:    600_000n,
  claim:   300_000n,
} as const

// ── ABIs (from GetEquity onchain docs — IMarket / IRWAToken) ──────────────────

const MARKET_ABI = [
  'function buy(address token, uint256 amount, uint256 maxCost) external',
  'function sell(address token, uint256 amount, uint256 minPayout) external',
  'function calculateBuyCost(address token, uint256 amount) view returns (uint256 baseCost, uint256 fee, uint256 totalCost)',
  'function calculateSellPayout(address token, uint256 amount) view returns (uint256 grossPayout, uint256 fee, uint256 netPayout)',
  'function getRegisteredTokens() view returns (address[])',
  'function isAssetTradeable(address token) view returns (bool)',
] as const

const RWA_ABI = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function payoutToken() view returns (address)',
  'function hasMaturity() view returns (bool)',
  'function maturityDate() view returns (uint256)',
  'function hasPeriodicPayouts() view returns (bool)',
  'function calculatePayout(address user) view returns (uint256 payout, uint256 periodsElapsed)',
  'function claimPayout() external returns (uint256)',
] as const

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
] as const

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GetEquityAsset {
  token: string          // RWA ERC-20 address
  symbol: string
  name: string
  decimals: number
  payoutToken: string    // settlement currency address (cNGN or USDC — read per asset)
  tradeable: boolean
  hasMaturity: boolean
  maturityDate: number   // unix seconds (0 if none)
  hasPeriodicPayouts: boolean
}

export interface BuyQuote { baseCost: bigint; fee: bigint; totalCost: bigint }
export interface SellQuote { grossPayout: bigint; fee: bigint; netPayout: bigint }

function ensureEnabled() {
  if (!GETEQUITY_ENABLED) throw new Error('GetEquity integration is disabled')
}

// ── Discovery / reads (view-only, no signer) ──────────────────────────────────

/** Every RWA token registered on the Market, with its on-chain metadata. */
export async function listAssets(): Promise<GetEquityAsset[]> {
  ensureEnabled()
  const provider = getProvider()
  const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, provider)
  const tokens: string[] = await market.getRegisteredTokens()

  return Promise.all(
    tokens.map(async (token) => {
      const rwa = new ethers.Contract(token, RWA_ABI, provider)
      const [symbol, name, decimals, payoutToken, tradeable, hasMaturity, hasPayouts] =
        await Promise.all([
          rwa.symbol().catch(() => 'RWA'),
          rwa.name().catch(() => 'GetEquity Asset'),
          rwa.decimals().catch(() => 18),
          rwa.payoutToken(),
          market.isAssetTradeable(token).catch(() => false),
          rwa.hasMaturity().catch(() => false),
          rwa.hasPeriodicPayouts().catch(() => false),
        ])
      let maturityDate = 0
      if (hasMaturity) maturityDate = Number(await rwa.maturityDate().catch(() => 0n))
      return {
        token,
        symbol,
        name,
        decimals: Number(decimals),
        payoutToken,
        tradeable: Boolean(tradeable),
        hasMaturity: Boolean(hasMaturity),
        maturityDate,
        hasPeriodicPayouts: Boolean(hasPayouts),
      }
    }),
  )
}

/** Cost (in the asset's payout token) to buy `amount` (token base units) of `token`. */
export async function quoteBuy(token: string, amount: bigint): Promise<BuyQuote> {
  ensureEnabled()
  const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, getProvider())
  const [baseCost, fee, totalCost] = await market.calculateBuyCost(token, amount)
  return { baseCost: b(baseCost), fee: b(fee), totalCost: b(totalCost) }
}

/** Proceeds (in the asset's payout token) from selling `amount` of `token`. */
export async function quoteSell(token: string, amount: bigint): Promise<SellQuote> {
  ensureEnabled()
  const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, getProvider())
  const [grossPayout, fee, netPayout] = await market.calculateSellPayout(token, amount)
  return { grossPayout: b(grossPayout), fee: b(fee), netPayout: b(netPayout) }
}

/** Custody's current holding of an RWA token (base units). */
export async function custodyAssetBalance(token: string): Promise<bigint> {
  ensureEnabled()
  const rwa = new ethers.Contract(token, RWA_ABI, getProvider())
  const cust = (await getSigner()).address
  return b(await rwa.balanceOf(cust))
}

/** Interest accrued and claimable by custody for a periodic-payout asset. */
export async function pendingPayout(token: string): Promise<bigint> {
  ensureEnabled()
  const rwa = new ethers.Contract(token, RWA_ABI, getProvider())
  const cust = (await getSigner()).address
  const [payout] = await rwa.calculatePayout(cust)
  return b(payout)
}

// ── Writes (custody wallet) ───────────────────────────────────────────────────

/**
 * Buy `amount` (token base units) of an RWA token from custody, paying in the
 * asset's own payout token. Approves the payout token to the Market when short,
 * quotes the cost, and applies `slippageBps` headroom to `maxCost` so an admin
 * price tick between quote and mine can't revert the buy.
 */
export async function buyAsset(
  token: string,
  amount: bigint,
  slippageBps = 100, // 1%
): Promise<{ txHash: string }> {
  ensureEnabled()
  if (amount <= 0n) throw new Error('Zero amount')
  const signer = await getSigner()
  const owner = await signer.getAddress()
  const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, signer)

  const { totalCost } = await quoteBuy(token, amount)
  const maxCost = totalCost + (totalCost * BigInt(slippageBps)) / 10_000n

  // Pay in whatever this asset settles in — read it, never assume cNGN/USDC.
  const rwaRead = new ethers.Contract(token, RWA_ABI, signer)
  const payToken: string = await rwaRead.payoutToken()
  const pay = new ethers.Contract(payToken, ERC20_ABI, signer)
  const current = b(await pay.allowance(owner, MARKET_ADDRESS))
  if (current < maxCost) {
    await (await pay.approve(MARKET_ADDRESS, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
  }

  const tx = await market.buy(token, amount, maxCost, { gasLimit: GAS.buy })
  const receipt = await tx.wait()
  return { txHash: receipt.hash }
}

/**
 * Buy an RWA token sized to a cNGN BUDGET (what the user actually spends), not a
 * unit count — the app takes a naira amount, the Market takes a token quantity.
 * Prices one whole token, derives how many units the budget affords, then buys
 * with `maxCost = budget` (the hard spend cap). Returns the tx hash + the whole-
 * token quantity to record on the ledger.
 *
 * TESTNET NOTE: decimals + price scaling must be verified against a live GetEquity
 * sandbox quote before mainnet — RWA tokens are 18-dp, cNGN is 6-dp, and totalCost
 * is denominated in the asset's payout token. This assumes a single admin-set price
 * per asset (their docs), i.e. cost is linear in quantity.
 */
export async function buyWithCngn(
  token: string,
  cngnMicroBudget: bigint,
  slippageBps = 100,
): Promise<{ txHash: string; units: number }> {
  ensureEnabled()
  if (cngnMicroBudget <= 0n) throw new Error('Zero budget')
  const signer = await getSigner()
  const owner = await signer.getAddress()
  const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, signer)

  const ONE = 10n ** 18n // one whole RWA token (18 dp)
  const per = await quoteBuy(token, ONE)
  if (per.totalCost <= 0n) throw new Error('Could not price asset')
  // Units (18-dp base) the budget affords, floored so cost never exceeds budget.
  const unitsBase = (cngnMicroBudget * ONE) / per.totalCost
  if (unitsBase <= 0n) throw new Error('Amount too small for this asset')

  // Approve the payout token to the Market once (MAX), then buy with the budget cap.
  const rwaRead = new ethers.Contract(token, RWA_ABI, signer)
  const payToken: string = await rwaRead.payoutToken()
  const pay = new ethers.Contract(payToken, ERC20_ABI, signer)
  const allowance = b(await pay.allowance(owner, MARKET_ADDRESS))
  if (allowance < cngnMicroBudget) {
    await (await pay.approve(MARKET_ADDRESS, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
  }

  // maxCost = full budget + slippage headroom, but the floored unitsBase already
  // costs ≤ budget, so this only absorbs a price tick between quote and mine.
  const maxCost = cngnMicroBudget + (cngnMicroBudget * BigInt(slippageBps)) / 10_000n
  const tx = await market.buy(token, unitsBase, maxCost, { gasLimit: GAS.buy })
  const receipt = await tx.wait()
  return { txHash: receipt.hash, units: Number(unitsBase) / 1e18 }
}

/**
 * Sell `amount` of an RWA token back to the Market, receiving the payout token
 * into custody. `minPayout` guards against an adverse price tick before mine.
 */
export async function sellAsset(
  token: string,
  amount: bigint,
  slippageBps = 100,
): Promise<{ txHash: string }> {
  ensureEnabled()
  if (amount <= 0n) throw new Error('Zero amount')
  const signer = await getSigner()
  const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, signer)

  const { netPayout } = await quoteSell(token, amount)
  const minPayout = netPayout - (netPayout * BigInt(slippageBps)) / 10_000n

  const tx = await market.sell(token, amount, minPayout, { gasLimit: GAS.sell })
  const receipt = await tx.wait()
  return { txHash: receipt.hash }
}

/** Claim accrued interest on a periodic-payout asset into custody. */
export async function claimPayout(token: string): Promise<{ txHash: string; claimed: bigint }> {
  ensureEnabled()
  const signer = await getSigner()
  const rwa = new ethers.Contract(token, RWA_ABI, signer)
  const tx = await rwa.claimPayout({ gasLimit: GAS.claim })
  const receipt = await tx.wait()
  // claimPayout returns the amount; re-read pending after mine would be 0, so we
  // surface the tx hash and let the caller reconcile the payout-token balance delta.
  return { txHash: receipt.hash, claimed: 0n }
}

// ── Collateral pricing (feeds the borrow engine) ──────────────────────────────

const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)']

/**
 * Refresh cached cNGN prices for a user's RWA (Naira asset) holdings, valued at the
 * Market's SELL payout — what custody would actually recover on liquidation, which is
 * the correct, conservative number for collateral. Writes into `equity_prices` so the
 * SQL borrow engine (migration 060) can value rwa collateral. No-op until GETEQUITY_ENABLED.
 *
 * ⚠️ Scaling caveat (same as buyWithCngn): price is cNGN(6dp) per WHOLE unit, so
 * portfolio_holdings.shares for rwa must be whole units for `shares * price` to be
 * correct. VERIFY decimals + the shares unit against LIVE GetEquity (mainnet) before
 * turning rwa collateral on for real money.
 */
export async function refreshRwaPrices(admin: SupabaseClient, userId: string): Promise<number> {
  if (!GETEQUITY_ENABLED) return 0
  const { data: holds } = await admin
    .from('portfolio_holdings')
    .select('symbol')
    .eq('user_id', userId)
    .eq('asset_type', 'rwa')
    .gt('shares', 0)
  const want = new Set((holds || []).map((r: any) => String(r.symbol || '').toUpperCase()))
  if (want.size === 0) return 0

  const provider = getProvider()
  const assets = await listAssets()
  let updated = 0
  for (const a of assets) {
    if (!want.has(a.symbol.toUpperCase())) continue
    try {
      const oneUnit = 10n ** BigInt(a.decimals)
      const { netPayout } = await quoteSell(a.token, oneUnit) // payout-token base units per whole unit
      const payDec = Number(await new ethers.Contract(a.payoutToken, ERC20_DECIMALS_ABI, provider).decimals())
      const priceNgnMicro = Number((netPayout * 1_000_000n) / (10n ** BigInt(payDec)))
      if (priceNgnMicro > 0) {
        const { error } = await admin
          .from('equity_prices')
          .upsert(
            { symbol: a.symbol.toUpperCase(), price_ngn_micro: priceNgnMicro, updated_at: new Date().toISOString() },
            { onConflict: 'symbol' },
          )
        if (!error) updated++
      }
    } catch {
      /* best-effort, like the stock price refresh — a hiccup just omits this asset */
    }
  }
  return updated
}