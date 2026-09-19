/**
 * morpho.ts — borrow-side liquidity from Morpho Blue on Base (SERVER ONLY, DARK).
 *
 * THE IDEA (see docs + the Morpho "stock-backed loans on Base" launch, Sep 2026):
 * custody already holds Coinbase B20 tokenized stocks (AAPLc/GOOGLc/NVDAc/METAc/SPCXc)
 * for users. Morpho now runs USDC lending markets collateralised by exactly those
 * tokens. So instead of PawaSave needing its own LPs to fund a naira loan, custody can:
 *   1. supply the (already-held) B20 stock as collateral on Morpho,
 *   2. borrow USDC against it,
 *   3. convert USDC → cNGN via HyperFX ([[hyperfx]]),
 *   4. lend that cNGN to the user (the existing asset-backed loan).
 * Repayment reverses it: cNGN → USDC (HyperFX) → repay Morpho → withdraw collateral.
 *
 * STAYS DARK until ALL of these hold (mirrors STRAILS/GETEQUITY/EQUITY_ENABLED):
 *   MORPHO_ENABLED=true                 master switch
 *   MORPHO_MARKETS=<json>               per-symbol market params (see below) — REQUIRED,
 *                                       because posting collateral against the wrong
 *                                       oracle/IRM/LLTV is unsafe to hardcode. Copy the
 *                                       exact values from each market page in Morpho's
 *                                       app (app.morpho.org, Base).
 *   HYPERFX_ENABLED=true (+deps)        only for the cNGN legs (the borrow/repay orchestrators)
 * Until then every export throws — inert dead code, typechecks clean, not wired into
 * the live loan flow. Wiring loan disbursement to draw from here is a SEPARATE, guarded
 * step (custody-signing + on-chain liquidation risk) — do that behind a design pass.
 *
 * MORPHO_MARKETS shape (loanToken defaults to USDC; collateralToken defaults to the
 * built-in B20 address for that symbol, so usually you only supply oracle/irm/lltv):
 *   {"SPCX":{"oracle":"0x…","irm":"0x…","lltv":"770000000000000000"}, "AAPL":{…}}
 * lltv is 1e18-scaled (e.g. 0.77 => "770000000000000000").
 *
 * Compliance: Coinbase issues these under Reg S / ADGM prospectus, non-US only — the
 * same eligibility gate as the equity desk. Confirm Nigeria eligibility before enabling.
 */

import { ethers } from 'ethers'
import { CONTRACTS, ERC20_ABI } from './contracts'
import { getSecret } from './secrets'
import { getWriteProvider, withBaseRead } from './rpc-provider'
import { HYPERFX_ENABLED, convertUsdcToCngn, convertCngnToUsdc } from './hyperfx'
import { withLease } from './custody-lease'

// Morpho Blue singleton on Base (env-overridable in case it ever changes).
const MORPHO_BLUE = (process.env.MORPHO_BLUE_ADDRESS || '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')

// Built-in collateral addresses for the five B20 tokens Morpho lists on Base
// (verified in lib/equity-broker.ts). Only the oracle/irm/lltv differ per market, so
// MORPHO_MARKETS usually needs just those three; collateralToken falls back to here.
const B20_COLLATERAL: Record<string, string> = {
  AAPL:  '0xb200000000000000000000C2e324d24d7eEcd1fb',
  GOOGL: '0xb2000000000000000000002D0BA3164cc74f58B7',
  NVDA:  '0xb20000000000000000000078ee7ce2fE4908108C',
  META:  '0xb2000000000000000000008bC8786B856E61707C',
  SPCX:  '0xb2000000000000000000007b9fcbd005511aCBd5',
}

const MAX_UINT256 = (1n << 256n) - 1n
const GAS = { approve: 120_000n, supply: 250_000n, borrow: 400_000n, repay: 350_000n, withdraw: 300_000n } as const
const b = (v: unknown): bigint => BigInt((v as any) ?? 0)

// ── Market registry ──────────────────────────────────────────────────────────

export interface MarketParams {
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: bigint
}

/** Morpho MarketParams as the on-chain tuple (order matters — matches the struct). */
function toTuple(m: MarketParams): [string, string, string, string, bigint] {
  return [m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv]
}

/** Market id = keccak256(abi.encode(MarketParams)) — the key Morpho stores positions under. */
export function marketId(m: MarketParams): string {
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address', 'uint256'],
    toTuple(m),
  )
  return ethers.keccak256(enc)
}

function parseMarkets(): Record<string, MarketParams> {
  let raw: any = {}
  try { raw = JSON.parse(process.env.MORPHO_MARKETS || '{}') } catch { raw = {} }
  const out: Record<string, MarketParams> = {}
  for (const [k, v] of Object.entries(raw || {})) {
    const sym = k.trim().toUpperCase()
    const o = (v || {}) as any
    const collateralToken = o.collateralToken || B20_COLLATERAL[sym]
    const loanToken = o.loanToken || CONTRACTS.USDC
    if (!ethers.isAddress(collateralToken) || !ethers.isAddress(o.oracle) || !ethers.isAddress(o.irm)) continue
    let lltv: bigint
    try { lltv = BigInt(o.lltv) } catch { continue }
    if (lltv <= 0n) continue
    out[sym] = { loanToken, collateralToken, oracle: o.oracle, irm: o.irm, lltv }
  }
  return out
}

export function isMorphoLive(): boolean {
  if (process.env.MORPHO_ENABLED !== 'true') return false
  if (!ethers.isAddress(MORPHO_BLUE)) return false
  return Object.keys(parseMarkets()).length > 0
}

/** Symbols with a configured Morpho market right now. */
export function morphoSymbols(): string[] {
  return isMorphoLive() ? Object.keys(parseMarkets()) : []
}

function marketFor(symbol: string): MarketParams {
  if (!isMorphoLive()) throw new Error('Morpho is not enabled')
  const m = parseMarkets()[String(symbol || '').trim().toUpperCase()]
  if (!m) throw new Error(`No Morpho market configured for '${symbol}'`)
  return m
}

// ── Signer + ABI ─────────────────────────────────────────────────────────────

const MORPHO_ABI = [
  'function supplyCollateral((address,address,address,address,uint256) marketParams, uint256 assets, address onBehalf, bytes data)',
  'function withdrawCollateral((address,address,address,address,uint256) marketParams, uint256 assets, address onBehalf, address receiver)',
  'function borrow((address,address,address,address,uint256) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256 assetsBorrowed, uint256 sharesBorrowed)',
  'function repay((address,address,address,address,uint256) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256 assetsRepaid, uint256 sharesRepaid)',
  'function accrueInterest((address,address,address,address,uint256) marketParams)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
]

async function getSigner(): Promise<ethers.Wallet> {
  const key = await getSecret('CUSTODY_PRIVATE_KEY')
  if (!key) throw new Error('CUSTODY_PRIVATE_KEY not configured')
  return new ethers.Wallet(key, getWriteProvider())
}

async function ensureApproval(token: string, owner: string, spender: string, need: bigint, signer: ethers.Wallet): Promise<void> {
  const c = new ethers.Contract(token, ERC20_ABI, signer)
  const current = b(await c.allowance(owner, spender))
  if (current >= need) return
  await (await c.approve(spender, MAX_UINT256, { gasLimit: GAS.approve })).wait(1)
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface MorphoPosition { collateral: bigint; borrowShares: bigint; supplyShares: bigint }

/** Custody's position in a symbol's market (base units / shares). Read-only. */
export async function readPosition(symbol: string): Promise<MorphoPosition> {
  const m = marketFor(symbol)
  const owner = (await getSigner()).address
  return withBaseRead(async (provider) => {
    const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, provider)
    const p = await morpho.position(marketId(m), owner)
    return { supplyShares: b(p[0]), borrowShares: b(p[1]), collateral: b(p[2]) }
  })
}

// ── Primitives (each takes the custody lease; call them from an orchestrator that
//     holds one lease across a whole sequence rather than nesting these) ─────────

/** Post `collateralBase` of the B20 token as collateral. Assumes custody holds it. */
export async function supplyCollateral(symbol: string, collateralBase: bigint): Promise<string> {
  const m = marketFor(symbol)
  if (collateralBase <= 0n) throw new Error('Zero collateral')
  const signer = await getSigner()
  const owner = signer.address
  await ensureApproval(m.collateralToken, owner, MORPHO_BLUE, collateralBase, signer)
  const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, signer)
  const tx = await morpho.supplyCollateral(toTuple(m), collateralBase, owner, '0x', { gasLimit: GAS.supply })
  const r = await tx.wait(); if (!r || r.status !== 1) throw new Error('supplyCollateral reverted')
  return r.hash
}

/** Borrow `usdcMicro` USDC against the market, received into custody. */
export async function borrowUsdc(symbol: string, usdcMicro: bigint): Promise<string> {
  const m = marketFor(symbol)
  if (usdcMicro <= 0n) throw new Error('Zero borrow')
  const signer = await getSigner()
  const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, signer)
  const tx = await morpho.borrow(toTuple(m), usdcMicro, 0n, signer.address, signer.address, { gasLimit: GAS.borrow })
  const r = await tx.wait(); if (!r || r.status !== 1) throw new Error('borrow reverted')
  return r.hash
}

/** Repay `usdcMicro` USDC of debt (custody must hold the USDC). */
export async function repayUsdc(symbol: string, usdcMicro: bigint): Promise<string> {
  const m = marketFor(symbol)
  if (usdcMicro <= 0n) throw new Error('Zero repay')
  const signer = await getSigner()
  await ensureApproval(m.loanToken, signer.address, MORPHO_BLUE, usdcMicro, signer)
  const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, signer)
  const tx = await morpho.repay(toTuple(m), usdcMicro, 0n, signer.address, '0x', { gasLimit: GAS.repay })
  const r = await tx.wait(); if (!r || r.status !== 1) throw new Error('repay reverted')
  return r.hash
}

/** Withdraw `collateralBase` of collateral back to custody. */
export async function withdrawCollateral(symbol: string, collateralBase: bigint): Promise<string> {
  const m = marketFor(symbol)
  if (collateralBase <= 0n) throw new Error('Zero withdraw')
  const signer = await getSigner()
  const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, signer)
  const tx = await morpho.withdrawCollateral(toTuple(m), collateralBase, signer.address, signer.address, { gasLimit: GAS.withdraw })
  const r = await tx.wait(); if (!r || r.status !== 1) throw new Error('withdrawCollateral reverted')
  return r.hash
}

// ── Orchestrators (cNGN legs via HyperFX) ────────────────────────────────────

export interface CngnDraw { cngnMicro: bigint; usdcMicro: bigint; borrowTx: string; supplyTx?: string }

/**
 * Draw cNGN liquidity against a stock: (optionally supply collateral →) borrow USDC →
 * convert to cNGN via HyperFX. Runs under ONE custody lease across every leg (the
 * signer is shared and HyperFX's auction must not race the idle-supply cron). Returns
 * the cNGN received. Caller decides how much collateral to post and how much to borrow
 * (respect the market's LLTV with a safety buffer — DO NOT borrow to the limit).
 *
 * NB: the USDC→cNGN leg can find no solver and throw (see [[hyperfx]] / equity-broker's
 * EquitySellCngnPending) — in that case the USDC is already borrowed and sits in custody;
 * the caller must record that and finish the conversion later rather than double-borrow.
 */
export async function borrowCngnAgainstStock(
  symbol: string,
  opts: { usdcToBorrowMicro: bigint; collateralToSupplyBase?: bigint },
): Promise<CngnDraw> {
  if (!isMorphoLive()) throw new Error('Morpho is not enabled')
  if (!HYPERFX_ENABLED) throw new Error('HyperFX is required for the USDC→cNGN leg')
  if (opts.usdcToBorrowMicro <= 0n) throw new Error('Zero borrow amount')
  return withLease('custody:signer', async () => {
    let supplyTx: string | undefined
    if (opts.collateralToSupplyBase && opts.collateralToSupplyBase > 0n) {
      supplyTx = await supplyCollateral(symbol, opts.collateralToSupplyBase)
    }
    const borrowTx = await borrowUsdc(symbol, opts.usdcToBorrowMicro)
    const cngnMicro = await convertUsdcToCngn(opts.usdcToBorrowMicro)
    return { cngnMicro, usdcMicro: opts.usdcToBorrowMicro, borrowTx, supplyTx }
  }, { holder: `morpho-borrow ${symbol}`, waitMs: 25_000 })
}

/**
 * Repay a stock loan from cNGN: convert cNGN → USDC (HyperFX) → repay Morpho →
 * (optionally) withdraw the freed collateral back to custody. One lease across all legs.
 */
export async function repayStockLoanFromCngn(
  symbol: string,
  opts: { cngnMicro: bigint; withdrawCollateralBase?: bigint },
): Promise<{ usdcMicro: bigint; repayTx: string; withdrawTx?: string }> {
  if (!isMorphoLive()) throw new Error('Morpho is not enabled')
  if (!HYPERFX_ENABLED) throw new Error('HyperFX is required for the cNGN→USDC leg')
  if (opts.cngnMicro <= 0n) throw new Error('Zero cNGN amount')
  return withLease('custody:signer', async () => {
    const usdcMicro = await convertCngnToUsdc(opts.cngnMicro)
    const repayTx = await repayUsdc(symbol, usdcMicro)
    let withdrawTx: string | undefined
    if (opts.withdrawCollateralBase && opts.withdrawCollateralBase > 0n) {
      withdrawTx = await withdrawCollateral(symbol, opts.withdrawCollateralBase)
    }
    return { usdcMicro, repayTx, withdrawTx }
  }, { holder: `morpho-repay ${symbol}`, waitMs: 25_000 })
}
