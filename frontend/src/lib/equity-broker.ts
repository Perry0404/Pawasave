/**
 * equity-broker.ts — server-only seam for buying/selling tokenized equities with cNGN.
 *
 * REALITY verified on Base mainnet (Aug 2026):
 *  - Coinbase's tokenized US stocks are live natively on Base — "B20" tokens (8 decimals):
 *    AAPLc/NVDAc/METAc/GOOGLc, issued by Coinbase Onchain SPV Ltd under Reg S (non-US only).
 *    They have REAL Uniswap-V3 USDC liquidity (confirmed on-chain: USDC/AAPLc ~$310/sh, etc.).
 *  - BUT cNGN has ~zero on-chain DEX liquidity (its Uniswap/Aerodrome pools are empty), and
 *    the public swap aggregators (Odos/KyberSwap) block our datacenter IP. So the cNGN→USD
 *    leg CANNOT go through a Base DEX or an aggregator API.
 *
 * So a buy is two stages, each on the rail that actually works:
 *     1. cNGN → USDC   via HyperFX (Hyperbridge Intent Gateway) — a solver provides the USDC
 *                      (lib/hyperfx.ts). This is the "HyperFX converts" step; Daya is the
 *                      cNGN-side solver/liquidity when that deal is live.
 *     2. USDC → <stock> via Uniswap V3 DIRECT (on-chain, no API → no IP block), custodying
 *                      the token in the omnibus wallet.
 * A sell reverses it: <stock> → USDC (Uniswap V3) → cNGN (HyperFX). The flat ₦500 sell fee
 * is applied by the settlement RPC/route, not here.
 *
 * STAYS DARK until ALL hold (mirrors STRAILS_ENABLED / GETEQUITY_ENABLED):
 *   EQUITY_ENABLED=true          master switch
 *   EQUITY_BROKER=base_dex       this path
 *   HYPERFX_ENABLED=true (+deps) the cNGN↔USDC conversion is available (see lib/hyperfx.ts)
 * The 4 verified B20 tokens are built-in; STOCK_TOKEN_MAP (JSON) can add/override more.
 * Until live: the API returns "coming soon", never debits, and a buy refunds on any failure.
 *
 * Optional env: EQUITY_SLIPPAGE_BPS=100 (USDC↔stock DEX slippage guard, default 1%).
 *
 * Compliance: tokenized US equities to non-US retail is regulated; KYC ('verified') is
 * enforced before any order, and the issuer can freeze wallets in prohibited jurisdictions —
 * so Nigeria eligibility MUST be confirmed before EQUITY_ENABLED is set.
 */

import { ethers } from 'ethers'
import { CONTRACTS, ERC20_ABI } from './contracts'
import { getSecret } from './secrets'
import { getWriteProvider, withBaseRead } from './rpc-provider'
import { HYPERFX_ENABLED, convertCngnToUsdc, convertUsdcToCngn } from './hyperfx'
import { custodyCngnBalance, custodyCngnBalanceFresh, cngnToShares, withdrawFromLend, custodyLendShares } from './custody'
import { acquireSupplyLock, releaseSupplyLock } from './supply-lock'

const BASE_CHAIN_ID = 8453

// Uniswap V3 on Base (a USDC↔stock venue — thin for these B20 tokens: fine for small
// buys, but >~$300/order slips badly).
const UNIV3 = {
  QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',   // QuoterV2
  ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481',   // SwapRouter02
} as const
const FEE_TIERS = [3000, 500, 10000, 100] as const // tried in this order; best quote wins

// Aerodrome Slipstream (concentrated liquidity) — where the B20 stock pools hold their DEEP
// liquidity ($1M+ each, ~flat price even at $3k vs Uniswap V3's 30% slippage at $1k). These
// pools sit on Aerodrome's NEWER CLFactory (0xf8f2eB49…), so we MUST use the matching
// periphery the same deployer shipped (verified on-chain to quote these pools) — NOT the
// widely-documented legacy Slipstream router, which targets the old factory and can't reach
// them. CL pools key on tickSpacing (not a fee tier); their SwapRouter takes a deadline.
const AERO = {
  QUOTER: '0x514c8B5f54112481E28028F1166Bd78501089259',   // Slipstream QuoterV2 (new factory)
  ROUTER: '0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F',   // Slipstream SwapRouter (new factory)
} as const
const TICK_SPACINGS = [10, 50, 100, 200, 1, 2000] as const // tried in this order; best quote wins

export type EquityAssetType = 'tokenized_stock' | 'pre_ipo'

export interface EquityOrderParams {
  symbol: string
  assetType: EquityAssetType
  amountCngnMicro: bigint        // cNGN already debited for this order
  provider: string
  receiver?: string
}

export interface EquityFill {
  brokerRef: string              // the on-chain stock-swap tx hash
  usdcMicro: bigint              // USDC spent on the stock
  shares: number                 // filled share quantity (fractional)
}

export interface EquitySale {
  brokerRef: string              // the on-chain stock-sell tx hash
  usdcMicro: bigint              // USDC received from the stock
  cngnGrossMicro: bigint         // cNGN received from HyperFX (BEFORE the ₦500 fee)
  shares: number                 // shares actually sold
}

const b = (v: unknown): bigint => BigInt((v as any) ?? 0)
const MAX_UINT256 = (1n << 256n) - 1n
const GAS = { approve: 120_000n, swap: 800_000n } as const
const slippageBps = () => Number(process.env.EQUITY_SLIPPAGE_BPS) || 100

// ── Token registry ─────────────────────────────────────────────────────────────

interface StockToken { address: string; decimals: number; fee?: number }

// Verified on-chain (symbol() + decimals()=8 + live USDC pool confirmed via paid RPC).
// All route through Aerodrome Slipstream CL (tickSpacing 10), auto-discovered by the
// router; `fee` is only the Uniswap-V3 fallback hint. First 4 verified 2026-08-26.
// Batch of 6 added 2026-09-04 with these USDC pool depths at enable time:
//   AMZN ~$54.6k · SNDK ~$5.3k · SPCX ~$5.2k · MSFT ~$5.1k · MSTR ~$5.1k · TSLA ~$5.0k
// The thin (~$5k) pools support normal retail buys; oversized buys refund via the
// slippage guard (EQUITY_SLIPPAGE_BPS) rather than filling badly.
const DEFAULT_STOCKS: Record<string, StockToken> = {
  AAPL:  { address: '0xb200000000000000000000C2e324d24d7eEcd1fb', decimals: 8, fee: 3000 },
  NVDA:  { address: '0xb20000000000000000000078ee7ce2fE4908108C', decimals: 8, fee: 3000 },
  META:  { address: '0xb2000000000000000000008bC8786B856E61707C', decimals: 8, fee: 3000 },
  GOOGL: { address: '0xb2000000000000000000002D0BA3164cc74f58B7', decimals: 8, fee: 3000 },
  AMZN:  { address: '0xb200000000000000000000d9192b6B456483C2E8', decimals: 8, fee: 3000 },
  MSFT:  { address: '0xB200000000000000000000Ab99cFa739E253872B', decimals: 8, fee: 3000 },
  MSTR:  { address: '0xb2000000000000000000004884b426556b92883d', decimals: 8, fee: 3000 },
  SNDK:  { address: '0xb200000000000000000000397293Cb8cda9a10c5', decimals: 8, fee: 3000 },
  SPCX:  { address: '0xb2000000000000000000007b9fcbd005511aCBd5', decimals: 8, fee: 3000 },
  TSLA:  { address: '0xb2000000000000000000001e800a7f5189430cD0', decimals: 8, fee: 3000 },
}

// Per-symbol kill-switch default. Founder decision (2026-09-04): keep ALL verified
// stocks enabled through redeploys — accepting that the ultra-thin pools (TSLA/MSFT/
// MSTR/SNDK, <40 shares of depth) can occasionally refund a buy ("Swap settled but no
// output received"; cNGN is safely refunded, no loss). So the DEFAULT disables nothing;
// a redeploy won't drop them. To disable a misbehaving symbol WITHOUT a redeploy, set
// EQUITY_DISABLED_SYMBOLS (comma list) in the env — that overrides this default.
const DEFAULT_DISABLED_SYMBOLS = ''

/** Built-in verified map, extended by STOCK_TOKEN_MAP (JSON), minus disabled symbols. */
function stockTokenMap(): Record<string, StockToken> {
  const out: Record<string, StockToken> = { ...DEFAULT_STOCKS }
  let raw: any = {}
  try { raw = JSON.parse(process.env.STOCK_TOKEN_MAP || '{}') } catch { raw = {} }
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.trim().toUpperCase()
    if (typeof v === 'string') { if (ethers.isAddress(v)) out[key] = { address: v, decimals: 8 } }
    else if (v && typeof v === 'object' && ethers.isAddress((v as any).address)) {
      out[key] = { address: (v as any).address, decimals: Number((v as any).decimals) || 8, fee: Number((v as any).fee) || undefined }
    }
  }
  // Operational per-symbol kill-switch (env unset → the safe default above). Applies to
  // supportedEquitySymbols() AND resolveStock(), so a disabled symbol is hidden in the UI
  // and refused by the API BEFORE any debit — instant disable without a code redeploy.
  const disRaw = process.env.EQUITY_DISABLED_SYMBOLS ?? DEFAULT_DISABLED_SYMBOLS
  for (const d of disRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)) delete out[d]
  return out
}

function resolveStock(symbol: string): StockToken {
  const t = stockTokenMap()[String(symbol || '').trim().toUpperCase()]
  if (!t) throw new Error(`'${symbol}' is not available yet`)
  return t
}

export function equityProvider(): string {
  return (process.env.EQUITY_BROKER || '').toLowerCase()
}

/**
 * Live only when the master switch is on, the provider is base_dex, and the cNGN↔USDC
 * conversion rail (HyperFX) is enabled — without it the buy can't get from cNGN to USD.
 */
export function isEquityBrokerLive(): boolean {
  if (process.env.EQUITY_ENABLED !== 'true') return false
  if (equityProvider() !== 'base_dex') return false
  if (!HYPERFX_ENABLED) return false
  return Object.keys(stockTokenMap()).length > 0
}

/**
 * Symbols that are actually BUYABLE right now — those with a resolved on-chain token
 * (and therefore an Aerodrome/Uniswap route). Currently AAPL/NVDA/META/GOOGL plus the
 * 2026-09-04 batch (AMZN/MSFT/MSTR/SNDK/SPCX/TSLA), all with a verified live USDC pool.
 * Any ticker NOT in this set must render as "coming soon — verification pending" rather
 * than letting a user debit cNGN into a buy that can only refund. Empty when broker off.
 */
export function supportedEquitySymbols(): string[] {
  if (!isEquityBrokerLive()) return []
  return Object.keys(stockTokenMap())
}

// ── Custody signer + Uniswap V3 direct swap ─────────────────────────────────────

async function getSigner(): Promise<ethers.Wallet> {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  return new ethers.Wallet(key, getWriteProvider())
}

const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']
const ROUTER_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)']
// Aerodrome Slipstream: quoter keys on tickSpacing (int24); router adds a deadline field.
const AERO_QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']
const AERO_ROUTER_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)']

/** Best (feeTier, quotedOut) for tokenIn→tokenOut across V3 fee tiers, or null if no pool. */
async function bestQuote(tokenIn: string, tokenOut: string, amountIn: bigint, preferFee?: number): Promise<{ fee: number; out: bigint } | null> {
  return withBaseRead(async (provider) => {
    const quoter = new ethers.Contract(UNIV3.QUOTER, QUOTER_ABI, provider)
    const tiers = preferFee ? [preferFee, ...FEE_TIERS.filter((f) => f !== preferFee)] : [...FEE_TIERS]
    let best: { fee: number; out: bigint } | null = null
    for (const fee of tiers) {
      try {
        const q = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 })
        const out = b(q[0])
        if (out > 0n && (!best || out > best.out)) best = { fee, out }
      } catch { /* no pool at this tier */ }
    }
    return best
  })
}

/** Best (tickSpacing, quotedOut) for tokenIn→tokenOut on Aerodrome Slipstream, or null. */
async function aeroBestQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ tickSpacing: number; out: bigint } | null> {
  return withBaseRead(async (provider) => {
    const quoter = new ethers.Contract(AERO.QUOTER, AERO_QUOTER_ABI, provider)
    let best: { tickSpacing: number; out: bigint } | null = null
    for (const tickSpacing of TICK_SPACINGS) {
      try {
        const q = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96: 0 })
        const out = b(q[0])
        if (out > 0n && (!best || out > best.out)) best = { tickSpacing, out }
      } catch { /* no CL pool at this tickSpacing */ }
    }
    return best
  })
}

/**
 * Swap tokenIn→tokenOut from custody through the DEEPER of Uniswap V3 and Aerodrome
 * Slipstream, returning the amount actually received (on-chain balance delta). Both venues
 * are quoted; the one with the larger output wins, so a big buy routes to Aerodrome's deep
 * CL pool while a pair that only exists on one venue still works. The winning quote sets the
 * min-out slippage guard, so a thin route can only fail — never fill at a bad price.
 */
async function swapBestVenue(tokenIn: string, tokenOut: string, amountIn: bigint, preferFee?: number, minAcceptableOut?: bigint): Promise<{ received: bigint; txHash: string; venue: 'aerodrome' | 'univ3' }> {
  if (amountIn <= 0n) throw new Error('Zero swap amount')
  const signer = await getSigner()
  const owner = await signer.getAddress()
  const inC = new ethers.Contract(tokenIn, ERC20_ABI, signer)
  const outC = new ethers.Contract(tokenOut, ERC20_ABI, signer)

  const held = b(await inC.balanceOf(owner))
  if (held < amountIn) throw new Error('Insufficient custody balance for swap')

  const [v3, aero] = await Promise.all([
    bestQuote(tokenIn, tokenOut, amountIn, preferFee),
    aeroBestQuote(tokenIn, tokenOut, amountIn),
  ])
  const v3Out = v3?.out ?? 0n
  const aeroOut = aero?.out ?? 0n
  if (v3Out === 0n && aeroOut === 0n) throw new Error('No DEX route for this pair')

  const useAero = aeroOut >= v3Out
  const quotedOut = useAero ? aeroOut : v3Out
  // Fair-value floor (sell side): if the best DEX quote is below the caller's floor
  // — i.e. selling would dump into a thin pool well under the stock's real market
  // value — REFUSE before the irreversible swap. The caller (sell route) restores the
  // shares, so the user keeps them and can try a smaller amount or later, instead of
  // being fleeced. The 1% minOut below only guards quote→exec movement, not the price
  // impact already baked into quotedOut, which is why this separate floor is needed.
  if (minAcceptableOut !== undefined && quotedOut < minAcceptableOut) {
    throw new Error(`Route too thin: quote ${quotedOut} below fair-value floor ${minAcceptableOut} — try a smaller amount or later`)
  }
  const minOut = quotedOut - (quotedOut * BigInt(slippageBps())) / 10_000n
  const routerAddr = useAero ? AERO.ROUTER : UNIV3.ROUTER

  const current = b(await inC.allowance(owner, routerAddr))
  if (current < amountIn) {
    await (await inC.approve(routerAddr, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
  }

  const before = b(await outC.balanceOf(owner))
  let tx
  if (useAero) {
    const router = new ethers.Contract(AERO.ROUTER, AERO_ROUTER_ABI, signer)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
    tx = await router.exactInputSingle(
      { tokenIn, tokenOut, tickSpacing: aero!.tickSpacing, recipient: owner, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 },
      { gasLimit: GAS.swap },
    )
  } else {
    const router = new ethers.Contract(UNIV3.ROUTER, ROUTER_ABI, signer)
    tx = await router.exactInputSingle(
      { tokenIn, tokenOut, fee: v3!.fee, recipient: owner, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 },
      { gasLimit: GAS.swap },
    )
  }
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Swap reverted')
  const received = b(await outC.balanceOf(owner)) - before
  if (received <= 0n) throw new Error('Swap settled but no output received')
  console.info('[equity] swap filled', { venue: useAero ? 'aerodrome' : 'univ3', received: received.toString() })
  return { received, txHash: receipt.hash, venue: useAero ? 'aerodrome' : 'univ3' }
}

// ── Custody cNGN liquidity ─────────────────────────────────────────────────────

/**
 * Ensure custody holds `needMicro` of FREE cNGN before a buy. The reconcile sweeps
 * idle custody cNGN into PawasaveLend for yield, so custody's free balance is usually
 * ~0 — the working cNGN lives as psNGN shares in the pool. Redeem just enough (plus a
 * 1% rounding buffer, capped at what custody holds) back to custody so the HyperFX
 * escrow can pull it. Throws if the pool can't cover it (a real liquidity shortfall).
 */
async function ensureFreeCngn(needMicro: bigint): Promise<void> {
  const free = await custodyCngnBalance()
  if (free >= needMicro) return
  const shortfall = needMicro - free
  let shares = await cngnToShares(shortfall + shortfall / 100n)
  const held = await custodyLendShares()
  if (shares > held) shares = held
  if (shares <= 0n) {
    throw new Error(
      `Insufficient cNGN liquidity: pool holds no redeemable shares, need ₦${(Number(needMicro) / 1e6).toFixed(0)}`,
    )
  }
  // Redeems cNGN back to custody and WAITS for the receipt. `cngnMicro` is parsed
  // from the mined Withdrawn event, so it is authoritative proof the funds landed —
  // trust it over an immediate balance re-read, which can hit a lagging public RPC
  // and report the stale pre-withdraw 0 (which was failing buys spuriously).
  const { cngnMicro } = await withdrawFromLend(shares)
  if (cngnMicro > 0n) {
    if (free + cngnMicro < needMicro) {
      throw new Error(
        `Insufficient cNGN liquidity: redeemed ₦${(Number(free + cngnMicro) / 1e6).toFixed(0)}, need ₦${(Number(needMicro) / 1e6).toFixed(0)}`,
      )
    }
    return
  }
  // Fallback (Withdrawn event not parsed): confirm via the write RPC, which is
  // read-after-write consistent with the tx we just awaited — not withBaseRead.
  const after = await custodyCngnBalanceFresh()
  if (after < needMicro) {
    throw new Error(
      `Insufficient cNGN liquidity: custody has ~₦${(Number(after) / 1e6).toFixed(0)} after pool withdraw, need ₦${(Number(needMicro) / 1e6).toFixed(0)}`,
    )
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Buy: cNGN → USDC (HyperFX) → stock (Uniswap V3), custodied in the omnibus wallet.
 * Throws on ANY failure so the caller settles 'failed' and the RPC refunds the cNGN.
 */
export async function placeEquityOrder(params: EquityOrderParams): Promise<EquityFill> {
  if (!isEquityBrokerLive()) throw new Error('Equity broker not configured')
  if (equityProvider() !== 'base_dex') throw new Error(`Equity provider '${equityProvider()}' not implemented`)
  const token = resolveStock(params.symbol)

  // Hold the custody-supply lock across free→escrow: without it, the idle-supply cron
  // re-pools the cNGN we free during HyperFX's ~20s auction, so the escrow reverts
  // "transfer amount exceeds balance". Retry a few times in case a cron briefly holds it.
  let locked = false
  for (let i = 0; i < 4 && !locked; i++) {
    locked = await acquireSupplyLock()
    if (!locked) await new Promise((r) => setTimeout(r, 1500))
  }
  let released = false
  const release = async () => { if (locked && !released) { released = true; await releaseSupplyLock() } }

  let usdcMicro: bigint
  try {
    await ensureFreeCngn(params.amountCngnMicro)                        // free cNGN from the pool if needed
    usdcMicro = await convertCngnToUsdc(params.amountCngnMicro)         // leg 1 — cNGN escrowed into HyperFX
    await release()                                                    // escrowed → the supply cron may resume
  } finally {
    await release()
  }
  const { received, txHash } = await swapBestVenue(CONTRACTS.USDC, token.address, usdcMicro, token.fee) // leg 2

  const shares = Number(received) / 10 ** token.decimals
  if (!(shares > 0)) throw new Error('Filled zero shares')
  return { brokerRef: txHash, usdcMicro, shares }
}

/**
 * Sell `sharesToSell` of a held stock: stock → USDC (Uniswap V3) → cNGN (HyperFX).
 * Returns the GROSS cNGN received; the flat ₦500 platform fee is deducted by the caller.
 * Throws on any failure so the caller leaves the holding intact.
 */
export async function sellEquity(symbol: string, sharesToSell: number, minUsdcOutMicro?: bigint): Promise<EquitySale> {
  if (!isEquityBrokerLive()) throw new Error('Equity broker not configured')
  if (!(sharesToSell > 0)) throw new Error('Zero shares to sell')
  const token = resolveStock(symbol)

  const tokenBase = BigInt(Math.floor(sharesToSell * 10 ** token.decimals))
  if (tokenBase <= 0n) throw new Error('Amount too small to sell')

  // minUsdcOutMicro (optional) = fair-value floor for the stock→USDC leg, so a large
  // sell can't be dumped into a thin pool far below the stock's market price. Below the
  // floor the swap refuses and the caller restores the shares (see settle_equity_sell).
  const sold = await swapBestVenue(token.address, CONTRACTS.USDC, tokenBase, token.fee, minUsdcOutMicro) // stock → USDC
  const cngnGrossMicro = await convertUsdcToCngn(sold.received)                     // USDC → cNGN
  return {
    brokerRef: sold.txHash,
    usdcMicro: sold.received,
    cngnGrossMicro,
    shares: Number(tokenBase) / 10 ** token.decimals,
  }
}
