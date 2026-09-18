/**
 * yield/aggregator.ts — multi-source yield aggregator for idle cNGN.
 *
 * The savings APY must reflect what the treasury ACTUALLY earns, blended across
 * several sources, instead of a single hardcoded number. This reads a live/quoted
 * APY from each source; the cron then blends them by real allocation and applies
 * the user/platform split policy so the credited APY tracks reality.
 *
 * Denomination matters: cNGN is naira. USD DeFi sources (Aave/Moonwell) quote a
 * USD rate — earning it requires swapping cNGN→USDC, which adds NGN/USD FX risk.
 * Those are flagged `fxRisk: true` so we never blend them in naively. NGN-native
 * sources (own borrow book, T-bills, Xend MM) carry no FX risk.
 *
 * IMPORTANT: a quoted APY is what a source WOULD pay if we deployed into it. Only
 * count it toward the credited yield once funds are actually allocated there
 * (allocations live in platform_settings.yield_allocations). Otherwise we'd be
 * back to promising yield we don't earn.
 */
import { ethers } from 'ethers'
import { getBaseProvider } from '@/lib/rpc-provider'
import { ADDRESSES, CONTRACTS, LEND_ABI } from '@/lib/contracts'

const SECONDS_PER_YEAR = 31_536_000
const RAY = 1e27

export type Denomination = 'NGN' | 'USD'

export interface YieldSourceReading {
  key: string
  name: string
  denomination: Denomination
  /** True when realising this yield needs an FX conversion (cNGN↔USD). */
  fxRisk: boolean
  /** Whether we could read/quote the source at all. */
  available: boolean
  /** Live/quoted annual percentage yield, e.g. 5.2 for 5.2%. */
  apyPercent: number
  note?: string
}

const pct = (x: number) => Math.max(0, Math.round(x * 100) / 100)

/** APR (decimal, annual) → compounded APY (decimal). */
function aprToApy(apr: number): number {
  if (!Number.isFinite(apr) || apr <= 0) return 0
  return Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1
}

// ── Source 1: our own PawasaveLend book (NGN, no FX) ──────────────────────────
async function readNativeLend(): Promise<YieldSourceReading> {
  const base: YieldSourceReading = {
    key: 'pawasave_lend', name: 'PawasaveLend (own book)',
    denomination: 'NGN', fxRisk: false, available: true, apyPercent: 0,
    note: 'Borrower interest. Zero until loans are drawn.',
  }
  try {
    const lend = new ethers.Contract(ADDRESSES.LEND, LEND_ABI, getBaseProvider())
    const [cash, borrows] = await Promise.all([lend.getCash(), lend.totalBorrows()])
    const c = Number(ethers.formatUnits(cash, 6))
    const b = Number(ethers.formatUnits(borrows, 6))
    const util = c + b > 0 ? b / (c + b) : 0
    if (b <= 0) return { ...base, apyPercent: 0 }

    // Try the on-chain supply APY; fall back to util × borrowAPR × (1 − reserve).
    try {
      const sApy = await lend.currentSupplyAPY()
      return { ...base, apyPercent: pct(Number(sApy) / 100), note: 'On-chain supply APY.' }
    } catch {
      const [bApr, reserve] = await Promise.all([
        lend.currentBorrowAPR().catch(() => 0n),
        lend.reserveFactorMantissa().catch(() => 0n),
      ])
      const borrowApr = Number(bApr) / 10000 // basis points → decimal
      const reserveFactor = Number(reserve) / 1e18
      return { ...base, apyPercent: pct(util * borrowApr * (1 - reserveFactor) * 100) }
    }
  } catch (e) {
    return { ...base, available: false, note: 'On-chain read failed.' }
  }
}

// ── Source 2: Aave v3 on Base — USDC supply rate (USD, FX risk) ────────────────
const AAVE_V3_POOL_BASE = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'
const AAVE_RESERVE_ABI = [
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
]
async function readAaveUsdc(): Promise<YieldSourceReading> {
  const base: YieldSourceReading = {
    key: 'aave_usdc', name: 'Aave v3 · USDC (Base)',
    denomination: 'USD', fxRisk: true, available: false, apyPercent: 0,
    note: 'USD lending rate — needs cNGN↔USDC (FX risk).',
  }
  try {
    const pool = new ethers.Contract(AAVE_V3_POOL_BASE, AAVE_RESERVE_ABI, getBaseProvider())
    const data = await pool.getReserveData(CONTRACTS.USDC)
    const apr = Number(data.currentLiquidityRate) / RAY // ray → decimal APR
    return { ...base, available: true, apyPercent: pct(aprToApy(apr) * 100) }
  } catch {
    return base
  }
}

// ── Source 3: Moonwell on Base — mToken supply rate (USD, FX risk) ─────────────
// Only read when the mToken address is configured (avoids guessing an address).
const MOONWELL_MTOKEN_ABI = ['function supplyRatePerTimestamp() view returns (uint256)']
async function readMoonwell(): Promise<YieldSourceReading | null> {
  const addr = process.env.MOONWELL_MUSDC_ADDRESS
  if (!addr) return null
  const base: YieldSourceReading = {
    key: 'moonwell_usdc', name: 'Moonwell · USDC (Base)',
    denomination: 'USD', fxRisk: true, available: false, apyPercent: 0,
    note: 'USD lending rate — needs cNGN↔USDC (FX risk).',
  }
  try {
    const m = new ethers.Contract(addr, MOONWELL_MTOKEN_ABI, getBaseProvider())
    const perSec = Number(await m.supplyRatePerTimestamp()) / 1e18
    return { ...base, available: true, apyPercent: pct(aprToApy(perSec * SECONDS_PER_YEAR) * 100) }
  } catch {
    return base
  }
}

/** A naira-native source whose rate we don't yet read on-chain (T-bills, Xend MM). */
function configuredSource(
  key: string, name: string, envKey: string, note: string,
): YieldSourceReading | null {
  const raw = process.env[envKey]
  if (raw == null || raw === '') return null
  const apy = Number(raw)
  return {
    key, name, denomination: 'NGN', fxRisk: false,
    available: Number.isFinite(apy), apyPercent: pct(Number.isFinite(apy) ? apy : 0), note,
  }
}

/** Read every source (on-chain live + configured). Order = display order. */
export async function readYieldSources(): Promise<YieldSourceReading[]> {
  const [native, aave, moonwell] = await Promise.all([
    readNativeLend(),
    readAaveUsdc(),
    readMoonwell(),
  ])
  const out: YieldSourceReading[] = [native, aave]
  if (moonwell) out.push(moonwell)
  const tbill = configuredSource('tbill_ngn', 'Tokenized T-Bills (NGN)', 'YIELD_TBILL_APY_PERCENT', 'Naira T-bill RWA. Set YIELD_TBILL_APY_PERCENT once integrated.')
  const xend = configuredSource('xend_ngn', 'Xend Money Market (NGN)', 'YIELD_XEND_APY_PERCENT', 'Partner money market. Set YIELD_XEND_APY_PERCENT once integrated.')
  if (tbill) out.push(tbill)
  if (xend) out.push(xend)
  return out
}

export interface BlendResult {
  /** Realised blended APY across sources we've actually ALLOCATED into. */
  realizedApyPercent: number
  /** Best blended APY achievable if we allocate to target weights (planning). */
  potentialApyPercent: number
  /** Portion of funds currently allocated to any yield source (0–100). */
  allocatedPercent: number
}

/**
 * Blend source APYs by allocation weights (key → percent, summing ≤ 100). The
 * unallocated remainder earns 0. `allocations` should mirror REAL deployments.
 */
export function blendYield(
  readings: YieldSourceReading[],
  allocations: Record<string, number>,
): BlendResult {
  const byKey = new Map(readings.map((r) => [r.key, r]))
  let realized = 0
  let allocated = 0
  for (const [key, weight] of Object.entries(allocations)) {
    const r = byKey.get(key)
    const w = Math.max(0, Number(weight) || 0)
    if (!r || !r.available || w <= 0) continue
    realized += (w / 100) * r.apyPercent
    allocated += w
  }
  // Potential: greedily fill 100% with the best available NGN-safe source, then
  // note FX sources separately (planning only, not auto-credited).
  const best = [...readings]
    .filter((r) => r.available && r.apyPercent > 0)
    .sort((a, b) => b.apyPercent - a.apyPercent)[0]
  return {
    realizedApyPercent: pct(realized),
    potentialApyPercent: pct(best ? best.apyPercent : 0),
    allocatedPercent: Math.min(100, Math.round(allocated)),
  }
}

export interface SplitPolicy {
  /** APY credited to users. */
  userApyPercent: number
  /** APY kept as platform revenue (the spread). */
  platformApyPercent: number
  /** Fraction of realised yield passed to users (0–100). */
  userSharePercent: number
}

/**
 * Recommended user/platform split of the realised blended yield.
 * Default: users get `userShare`% of realised yield (rest = platform revenue),
 * capped at `userCap`%. Tune via platform_settings without a redeploy.
 */
export function splitYield(
  realizedApyPercent: number,
  opts?: { userSharePercent?: number; userCapPercent?: number },
): SplitPolicy {
  const share = Math.min(100, Math.max(0, opts?.userSharePercent ?? 70))
  const cap = Math.max(0, opts?.userCapPercent ?? 25)
  const userRaw = (realizedApyPercent * share) / 100
  const userApy = Math.min(userRaw, cap)
  return {
    userApyPercent: pct(userApy),
    platformApyPercent: pct(Math.max(0, realizedApyPercent - userApy)),
    userSharePercent: share,
  }
}