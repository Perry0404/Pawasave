/**
 * equity-broker.ts — server-only seam for buying tokenized equities + pre-IPO
 * tokens (xStocks / tokenized SpaceX etc.) with a user's cNGN balance.
 *
 * REALITY (June 2026), so we don't pretend: xStocks and pre-IPO tokens are
 * issued by Backed Finance and live as SPL tokens on SOLANA (Coinbase/Kraken
 * list them). They are NOT on Base, and there is no cNGN pair, so a buy ALWAYS
 * routes cNGN → USDC → the token. There is no self-serve "buy AAPL" API key you
 * can just drop in. Two viable provider paths to implement here:
 *
 *   1. provider 'coinbase'  — Coinbase Tokenize institutional API (custody +
 *      USDC rails). Cleanest UX/custody, but needs partner onboarding with
 *      Coinbase, not a public key. Set COINBASE_TOKENIZE_API_KEY when onboarded.
 *
 *   2. provider 'solana_dex' — fully on-chain: bridge USDC(Base) → USDC(Solana)
 *      (CCTP/LI.FI), then swap USDC → xStock on Jupiter, custodying the SPL
 *      token in an omnibus wallet and crediting the user's portfolio. Needs
 *      Solana infra + a bridge. Set SOLANA_RPC_URL + SOLANA_CUSTODY_SECRET.
 *
 * Until one is configured, isEquityBrokerLive() returns false and the API
 * surfaces "coming soon" — it never debits and never fakes a fill. When ready,
 * implement placeEquityOrder(); the debit/order/settle/refund plumbing already
 * works for both 'tokenized_stock' and 'pre_ipo'.
 *
 * Compliance gate: tokenized US equities + pre-IPO to non-US retail is a
 * regulated product. KYC ('verified') is enforced before any order, and the
 * chosen provider's jurisdiction limits MUST be honoured (verify Nigeria is
 * supported before enabling).
 */

export type EquityAssetType = 'tokenized_stock' | 'pre_ipo'

export interface EquityOrderParams {
  symbol: string                 // e.g. 'AAPL', 'SPCX'
  assetType: EquityAssetType
  amountCngnMicro: bigint        // cNGN already debited for this order
  provider: string               // 'coinbase' | 'solana_dex' | ...
  /** wallet/account to receive the token (user self-custody or PawaSave omnibus) */
  receiver?: string
}

export interface EquityFill {
  brokerRef: string              // external broker / on-chain tx id
  usdcMicro: bigint              // USDC spent after the cNGN→USDC swap
  shares: number                 // filled share quantity (may be fractional)
}

/** Active provider, or '' if equities are not enabled. */
export function equityProvider(): string {
  return (process.env.EQUITY_BROKER || '').toLowerCase()
}

/** Equities are live only when a provider is configured AND credentialed. */
export function isEquityBrokerLive(): boolean {
  const p = equityProvider()
  if (p === 'coinbase')   return !!process.env.COINBASE_TOKENIZE_API_KEY
  if (p === 'solana_dex') return !!(process.env.SOLANA_RPC_URL && process.env.SOLANA_CUSTODY_SECRET)
  return false
}

/**
 * cNGN → USDC on Base for the equity purchase.
 * TODO(real): route through a DEX aggregator (Odos/1inch/Aerodrome) with a hard
 * slippage guard — do NOT assume ~1:1; cNGN depth is the gating issue.
 */
async function swapCngnToUsdc(_amountCngnMicro: bigint): Promise<bigint> {
  throw new Error('cNGN→USDC swap not implemented (needs a DEX route with a slippage guard)')
}

/**
 * Buy the tokenized asset. Returns the fill so the caller settles (records
 * shares). Throws on any failure so the caller refunds the cNGN.
 */
export async function placeEquityOrder(params: EquityOrderParams): Promise<EquityFill> {
  if (!isEquityBrokerLive()) throw new Error('Equity broker not configured')
  const p = equityProvider()

  // const usdcMicro = await swapCngnToUsdc(params.amountCngnMicro)
  // if (p === 'coinbase')   return coinbaseTokenizeBuy(params, usdcMicro)
  // if (p === 'solana_dex') return solanaBridgeAndSwap(params, usdcMicro)
  void swapCngnToUsdc
  throw new Error(`Equity provider '${p}' integration not yet implemented`)
}