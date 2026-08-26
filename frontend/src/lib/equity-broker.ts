/**
 * equity-broker.ts — server-only seam for buying tokenized equities + pre-IPO
 * tokens with a user's cNGN balance.
 *
 * REALITY (Aug 2026): Coinbase's tokenized US stocks went LIVE natively on Base
 * (24 Aug 2026) — the "B20" tokens NVDAc / AAPLc / METAc / GOOGLc, issued by
 * Coinbase Onchain SPV Ltd under Reg S (non-US persons only), with day-one
 * Aerodrome liquidity and secondary trading that is PERMISSIONLESS on-chain
 * (0x / 1inch / KyberSwap / CoW / Odos all route them). That removes the Solana
 * bridge the earlier scaffold assumed: a buy is now fully on Base —
 *
 *     cNGN → USDC → <stock token>       (two DEX-aggregator swaps, one wallet)
 *
 * custodying the ERC-20 in the PawaSave omnibus wallet and crediting the user's
 * portfolio. Backed's xStocks (also on Base) work through the exact same path —
 * only the token address changes.
 *
 * STAYS DARK until BOTH are true (mirrors STRAILS_ENABLED / GETEQUITY_ENABLED):
 *   EQUITY_ENABLED=true              master switch — nothing buys until this is set
 *   EQUITY_BROKER=base_dex           the on-Base aggregator path (this file)
 *   STOCK_TOKEN_MAP={"AAPL":"0x…"}   verified symbol→token address map (non-empty)
 * Until then isEquityBrokerLive() is false and the API returns "coming soon" — it
 * never debits and never fakes a fill. A buy also refunds cleanly on any swap
 * failure, because the caller settles 'failed' → place/settle RPC returns the cNGN.
 *
 * Optional env:
 *   EQUITY_SWAP_AGG=odos|0x          aggregator (default 'odos' — needs no API key)
 *   ZEROX_API_KEY                    required only when EQUITY_SWAP_AGG=0x
 *   EQUITY_SLIPPAGE_BPS=100          per-leg slippage guard (default 1%)
 *
 * Compliance gate: tokenized US equities + pre-IPO to non-US retail is a regulated
 * product. KYC ('verified') is enforced before any order (in the route AND the RPC),
 * and the issuer can freeze wallets in prohibited jurisdictions — so Nigeria's
 * eligibility MUST be confirmed before EQUITY_ENABLED is ever set to true.
 */

import { ethers } from 'ethers'
import { CONTRACTS, ERC20_ABI } from './contracts'
import { getSecret } from './secrets'
import { getWriteProvider, withBaseRead } from './rpc-provider'

const BASE_CHAIN_ID = 8453

export type EquityAssetType = 'tokenized_stock' | 'pre_ipo'

export interface EquityOrderParams {
  symbol: string                 // e.g. 'AAPL', 'SPCX'
  assetType: EquityAssetType
  amountCngnMicro: bigint        // cNGN already debited for this order
  provider: string               // 'base_dex' | 'coinbase' | ...
  /** wallet/account to receive the token (defaults to PawaSave omnibus custody) */
  receiver?: string
}

export interface EquityFill {
  brokerRef: string              // the on-chain swap tx hash
  usdcMicro: bigint              // USDC spent after the cNGN→USDC swap
  shares: number                 // filled share quantity (fractional)
}

const b = (v: unknown): bigint => BigInt((v as any) ?? 0)
const MAX_UINT256 = (1n << 256n) - 1n

// Explicit gas cap skips ethers' estimateGas preflight, which reverts spuriously
// against lagging public-RPC nodes on read-after-write (approve→swap). Same reason
// and pattern as custody.ts / getequity.ts. Aggregator swaps can be multi-hop, so
// the cap is generous; Base gas is fractions of a cent, so headroom is free.
const GAS = { approve: 120_000n, swap: 1_200_000n } as const

// ── Config ─────────────────────────────────────────────────────────────────────

/** Active provider, or '' if equities are not enabled. */
export function equityProvider(): string {
  return (process.env.EQUITY_BROKER || '').toLowerCase()
}

/**
 * Verified symbol → on-chain token map, from STOCK_TOKEN_MAP (JSON). A value is
 * either the bare address or { address, decimals }. Keys are upper-cased. We do
 * NOT hard-code addresses — a wrong stock-token address would send real money to
 * the wrong contract — so the operator pastes VERIFIED addresses here and the
 * symbol simply stays unavailable until they do.
 */
function stockTokenMap(): Record<string, { address: string; decimals?: number }> {
  let raw: any
  try { raw = JSON.parse(process.env.STOCK_TOKEN_MAP || '{}') } catch { return {} }
  const out: Record<string, { address: string; decimals?: number }> = {}
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.trim().toUpperCase()
    if (typeof v === 'string') { if (ethers.isAddress(v)) out[key] = { address: v } }
    else if (v && typeof v === 'object' && ethers.isAddress((v as any).address)) {
      out[key] = { address: (v as any).address, decimals: Number((v as any).decimals) || undefined }
    }
  }
  return out
}

function resolveStockToken(symbol: string): { address: string; decimals?: number } {
  const t = stockTokenMap()[String(symbol || '').trim().toUpperCase()]
  if (!t) throw new Error(`'${symbol}' is not available yet`)
  return t
}

/**
 * Equities are live only when the master switch is on AND the chosen provider is
 * actually usable. For base_dex that means at least one verified token in the map;
 * the legacy provider stubs stay false until implemented.
 */
export function isEquityBrokerLive(): boolean {
  if (process.env.EQUITY_ENABLED !== 'true') return false
  const p = equityProvider()
  if (p === 'base_dex')   return Object.keys(stockTokenMap()).length > 0
  if (p === 'coinbase')   return !!process.env.COINBASE_TOKENIZE_API_KEY
  if (p === 'solana_dex') return !!(process.env.SOLANA_RPC_URL && process.env.SOLANA_CUSTODY_SECRET)
  return false
}

// ── Custody signer ───────────────────────────────────────────────────────────

async function getSigner(): Promise<ethers.Wallet> {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  // Sign through a SINGLE RPC (not the FallbackProvider) so the sequential
  // approve→swap→swap txs get a consistent, monotonic nonce (same reason as the
  // custody off-ramp — a lagging RPC would reuse a nonce and strand funds).
  return new ethers.Wallet(key, getWriteProvider())
}

async function erc20Decimals(token: string): Promise<number> {
  return withBaseRead(async (provider) =>
    Number(await new ethers.Contract(token, ERC20_ABI, provider).decimals()),
  )
}

// ── DEX aggregator ─────────────────────────────────────────────────────────────

interface AggTx { to: string; data: string; value: bigint; gas?: bigint; spender: string }

const slippageBps = () => Number(process.env.EQUITY_SLIPPAGE_BPS) || 100

/**
 * Ask the configured aggregator for an executable swap of `sellAmount` sellToken →
 * buyToken for `taker`, with the slippage guard BAKED INTO the returned calldata
 * (so the swap tx itself reverts on-chain if the min-out isn't met — the real
 * protection, not a number we check off-chain). Returns the tx to send + the
 * ERC-20 spender to approve.
 */
async function aggregatorSwapTx(
  sellToken: string, buyToken: string, sellAmount: bigint, taker: string,
): Promise<AggTx> {
  const agg = (process.env.EQUITY_SWAP_AGG || 'odos').toLowerCase()
  if (agg === '0x') return zeroExSwapTx(sellToken, buyToken, sellAmount, taker)
  return odosSwapTx(sellToken, buyToken, sellAmount, taker)
}

/** Odos SOR — no API key. quote(pathId) → assemble(tx). Router is tx.to; approve it. */
async function odosSwapTx(
  sellToken: string, buyToken: string, sellAmount: bigint, taker: string,
): Promise<AggTx> {
  const quoteRes = await fetch('https://api.odos.xyz/sor/quote/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: BASE_CHAIN_ID,
      inputTokens: [{ tokenAddress: sellToken, amount: sellAmount.toString() }],
      outputTokens: [{ tokenAddress: buyToken, proportion: 1 }],
      userAddr: taker,
      slippageLimitPercent: slippageBps() / 100,
      referralCode: 0,
      compact: true,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!quoteRes.ok) throw new Error(`Odos quote HTTP ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 200)}`)
  const quote = await quoteRes.json()
  if (!quote?.pathId) throw new Error('Odos returned no route (no liquidity?)')

  const asmRes = await fetch('https://api.odos.xyz/sor/assemble', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userAddr: taker, pathId: quote.pathId, simulate: false }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!asmRes.ok) throw new Error(`Odos assemble HTTP ${asmRes.status}: ${(await asmRes.text()).slice(0, 200)}`)
  const asm = await asmRes.json()
  const tx = asm?.transaction
  if (!tx?.to || !tx?.data) throw new Error('Odos assemble returned no transaction')
  return { to: tx.to, data: tx.data, value: b(tx.value), gas: tx.gas ? b(tx.gas) : undefined, spender: tx.to }
}

/** 0x Swap API v2 (allowance-holder). Needs ZEROX_API_KEY. */
async function zeroExSwapTx(
  sellToken: string, buyToken: string, sellAmount: bigint, taker: string,
): Promise<AggTx> {
  const apiKey = process.env.ZEROX_API_KEY
  if (!apiKey) throw new Error('ZEROX_API_KEY not configured')
  const qs = new URLSearchParams({
    chainId: String(BASE_CHAIN_ID),
    sellToken, buyToken,
    sellAmount: sellAmount.toString(),
    taker,
    slippageBps: String(slippageBps()),
  })
  const res = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${qs}`, {
    headers: { '0x-api-key': apiKey, '0x-version': 'v2' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`0x quote HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const q = await res.json()
  const tx = q?.transaction
  if (!tx?.to || !tx?.data) throw new Error('0x returned no executable transaction (no liquidity?)')
  const spender = q?.issues?.allowance?.spender || tx.to
  return { to: tx.to, data: tx.data, value: b(tx.value), gas: tx.gas ? b(tx.gas) : undefined, spender }
}

/**
 * Execute one aggregator swap from custody and return how much buyToken ACTUALLY
 * arrived — measured as the on-chain balance delta, never trusted from the quote
 * (the fill can differ). Ensures the ERC-20 allowance to the aggregator's spender,
 * sends the router calldata, waits for the receipt, and diffs the balance.
 */
async function swapExact(
  sellToken: string, buyToken: string, sellAmount: bigint,
): Promise<{ received: bigint; txHash: string }> {
  if (sellAmount <= 0n) throw new Error('Zero swap amount')
  const signer = await getSigner()
  const owner = await signer.getAddress()

  const sell = new ethers.Contract(sellToken, ERC20_ABI, signer)
  const buy = new ethers.Contract(buyToken, ERC20_ABI, signer)

  // Custody must actually hold the sell token (its cNGN may be supplied to Lend or
  // already spent) — fail cleanly here so the order refunds instead of reverting mid-swap.
  const held = b(await sell.balanceOf(owner))
  if (held < sellAmount) throw new Error(`Insufficient custody ${sellToken === CONTRACTS.CNGN ? 'cNGN' : 'token'} for swap`)

  const swap = await aggregatorSwapTx(sellToken, buyToken, sellAmount, owner)

  // Approve the aggregator's spender when the standing allowance is short (MAX so
  // future swaps skip re-approval), and wait a confirmation so the swap tx — which
  // skips its own estimateGas via the fixed gasLimit — sees the allowance.
  const current = b(await sell.allowance(owner, swap.spender))
  if (current < sellAmount) {
    await (await sell.approve(swap.spender, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
  }

  const before = b(await buy.balanceOf(owner))
  const gasLimit = swap.gas ? (swap.gas * 15n) / 10n : GAS.swap // 50% headroom over the quote's estimate
  const tx = await signer.sendTransaction({ to: swap.to, data: swap.data, value: swap.value, gasLimit })
  const receipt = await tx.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Swap transaction reverted')

  const received = b(await buy.balanceOf(owner)) - before
  if (received <= 0n) throw new Error('Swap settled but no output token received')
  return { received, txHash: receipt.hash }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** cNGN → USDC on Base for the equity purchase (aggregator, with slippage guard). */
async function swapCngnToUsdc(amountCngnMicro: bigint): Promise<bigint> {
  const { received } = await swapExact(CONTRACTS.CNGN, CONTRACTS.USDC, amountCngnMicro)
  return received
}

/**
 * Buy the tokenized asset from custody: cNGN → USDC → <stock token>, custodying the
 * token in the omnibus wallet. Returns the fill (shares actually received, USDC
 * spent, final tx hash) so the caller records it. Throws on ANY failure so the
 * caller settles 'failed' and the RPC refunds the debited cNGN.
 */
export async function placeEquityOrder(params: EquityOrderParams): Promise<EquityFill> {
  if (!isEquityBrokerLive()) throw new Error('Equity broker not configured')
  const p = equityProvider()
  if (p !== 'base_dex') {
    // Legacy provider paths (coinbase institutional API / solana bridge) are not
    // implemented — base_dex superseded them once stocks went live on Base.
    throw new Error(`Equity provider '${p}' integration not yet implemented`)
  }

  const token = resolveStockToken(params.symbol)

  // Leg 1: cNGN → USDC.
  const usdcMicro = await swapCngnToUsdc(params.amountCngnMicro)

  // Leg 2: USDC → stock token, held in custody.
  const { received, txHash } = await swapExact(CONTRACTS.USDC, token.address, usdcMicro)

  // Shares = token amount received, scaled by the token's own decimals (read on-chain).
  const decimals = token.decimals ?? await erc20Decimals(token.address)
  const shares = Number(received) / 10 ** decimals
  if (!(shares > 0)) throw new Error('Filled zero shares')

  return { brokerRef: txHash, usdcMicro, shares }
}
