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
import { custodyCngnBalance, cngnToShares, withdrawFromLend, custodyLendShares } from './custody'
import { acquireSupplyLock, releaseSupplyLock } from './supply-lock'

const BASE_CHAIN_ID = 8453

// Uniswap V3 on Base (the USDC↔stock leg lives here — verified pools).
const UNIV3 = {
  QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',   // QuoterV2
  ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481',   // SwapRouter02
} as const
const FEE_TIERS = [3000, 500, 10000, 100] as const // tried in this order; best quote wins

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

// Verified on-chain 2026-08-26 (symbol() + Uniswap-V3 route confirmed). 8 decimals.
const DEFAULT_STOCKS: Record<string, StockToken> = {
  AAPL:  { address: '0xb200000000000000000000C2e324d24d7eEcd1fb', decimals: 8, fee: 3000 },
  NVDA:  { address: '0xb20000000000000000000078ee7ce2fE4908108C', decimals: 8, fee: 3000 },
  META:  { address: '0xb2000000000000000000008bC8786B856E61707C', decimals: 8, fee: 3000 },
  GOOGL: { address: '0xb2000000000000000000002D0BA3164cc74f58B7', decimals: 8, fee: 3000 },
}

/** Built-in verified map, extended/overridden by STOCK_TOKEN_MAP (JSON) if present. */
function stockTokenMap(): Record<string, StockToken> {
  const out: Record<string, StockToken> = { ...DEFAULT_STOCKS }
  let raw: any
  try { raw = JSON.parse(process.env.STOCK_TOKEN_MAP || '{}') } catch { return out }
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.trim().toUpperCase()
    if (typeof v === 'string') { if (ethers.isAddress(v)) out[key] = { address: v, decimals: 8 } }
    else if (v && typeof v === 'object' && ethers.isAddress((v as any).address)) {
      out[key] = { address: (v as any).address, decimals: Number((v as any).decimals) || 8, fee: Number((v as any).fee) || undefined }
    }
  }
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

// ── Custody signer + Uniswap V3 direct swap ─────────────────────────────────────

async function getSigner(): Promise<ethers.Wallet> {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  return new ethers.Wallet(key, getWriteProvider())
}

const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)']
const ROUTER_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)']

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

/**
 * Swap tokenIn→tokenOut on Uniswap V3 from custody, returning the amount actually received
 * (on-chain balance delta). Quotes the best fee tier for the min-out slippage guard.
 */
async function uniV3Swap(tokenIn: string, tokenOut: string, amountIn: bigint, preferFee?: number): Promise<{ received: bigint; txHash: string }> {
  if (amountIn <= 0n) throw new Error('Zero swap amount')
  const signer = await getSigner()
  const owner = await signer.getAddress()
  const inC = new ethers.Contract(tokenIn, ERC20_ABI, signer)
  const outC = new ethers.Contract(tokenOut, ERC20_ABI, signer)

  const held = b(await inC.balanceOf(owner))
  if (held < amountIn) throw new Error('Insufficient custody balance for swap')

  const quote = await bestQuote(tokenIn, tokenOut, amountIn, preferFee)
  if (!quote) throw new Error('No Uniswap V3 route for this pair')
  const minOut = quote.out - (quote.out * BigInt(slippageBps())) / 10_000n

  const current = b(await inC.allowance(owner, UNIV3.ROUTER))
  if (current < amountIn) {
    await (await inC.approve(UNIV3.ROUTER, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
  }

  const before = b(await outC.balanceOf(owner))
  const router = new ethers.Contract(UNIV3.ROUTER, ROUTER_ABI, signer)
  const tx = await router.exactInputSingle(
    { tokenIn, tokenOut, fee: quote.fee, recipient: owner, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 },
    { gasLimit: GAS.swap },
  )
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Swap reverted')
  const received = b(await outC.balanceOf(owner)) - before
  if (received <= 0n) throw new Error('Swap settled but no output received')
  return { received, txHash: receipt.hash }
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
  if (shares > 0n) await withdrawFromLend(shares) // redeems cNGN back to custody (waits for receipt)
  const after = await custodyCngnBalance()
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
  const { received, txHash } = await uniV3Swap(CONTRACTS.USDC, token.address, usdcMicro, token.fee) // leg 2

  const shares = Number(received) / 10 ** token.decimals
  if (!(shares > 0)) throw new Error('Filled zero shares')
  return { brokerRef: txHash, usdcMicro, shares }
}

/**
 * Sell `sharesToSell` of a held stock: stock → USDC (Uniswap V3) → cNGN (HyperFX).
 * Returns the GROSS cNGN received; the flat ₦500 platform fee is deducted by the caller.
 * Throws on any failure so the caller leaves the holding intact.
 */
export async function sellEquity(symbol: string, sharesToSell: number): Promise<EquitySale> {
  if (!isEquityBrokerLive()) throw new Error('Equity broker not configured')
  if (!(sharesToSell > 0)) throw new Error('Zero shares to sell')
  const token = resolveStock(symbol)

  const tokenBase = BigInt(Math.floor(sharesToSell * 10 ** token.decimals))
  if (tokenBase <= 0n) throw new Error('Amount too small to sell')

  const sold = await uniV3Swap(token.address, CONTRACTS.USDC, tokenBase, token.fee) // stock → USDC
  const cngnGrossMicro = await convertUsdcToCngn(sold.received)                     // USDC → cNGN
  return {
    brokerRef: sold.txHash,
    usdcMicro: sold.received,
    cngnGrossMicro,
    shares: Number(tokenBase) / 10 ** token.decimals,
  }
}
