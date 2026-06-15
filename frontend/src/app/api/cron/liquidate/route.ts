import { NextRequest, NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { checkCronAuth } from '@/lib/cron-auth'
import { getSecret } from '@/lib/secrets'

/**
 * GET /api/cron/liquidate
 *
 * Liquidation keeper. Scans borrowers and closes any position that is
 * liquidatable — either under-collateralised OR past its due date + 4-day grace
 * (the loan maturity overlay). Third-party liquidators are also incentivised by
 * the 10% bonus; this keeper is the protocol's backstop so late/unhealthy loans
 * don't sit open.
 *
 * Required env:
 *   BASE_MAINNET_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL)
 *   LIQUIDATION_KEEPER_PRIVATE_KEY  — wallet that fronts cNGN to repay + holds ETH gas
 *   PAWASAVE_LEND_ADDRESS
 *   CRON_SECRET
 * Optional:
 *   LIQUIDATION_LOOKBACK_BLOCKS (default 200000) — how far back to scan Borrowed events
 *   LIQUIDATION_FROM_BLOCK — exact start block (overrides lookback)
 *
 * The keeper must hold cNGN to perform liquidations (it repays debt, then
 * receives collateral + bonus). If it has no cNGN, positions are reported but
 * left for third-party liquidators.
 */

export const dynamic = 'force-dynamic'

const CNGN = '0x46C85152bFe9f96829aA94755D9f915F9B10EF5F'
const COLLATERAL_TOKENS = [
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
  '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT
  CNGN,                                          // cNGN
]

const LEND_ABI = [
  'event Borrowed(address indexed borrower, uint256 cngnAmount, uint256 fee)',
  'function isLiquidatable(address) view returns (bool)',
  'function borrowBalanceCurrent(address) view returns (uint256)',
  'function collateralBalance(address,address) view returns (uint256)',
  'function closeFactor() view returns (uint256)',
  'function liquidate(address borrower, uint256 repayAmount, address collateralToken) external',
]
const ERC20_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]

export async function GET(request: NextRequest) {
  const auth = checkCronAuth(request)
  if (auth) return auth

  const rpcUrl    = process.env.BASE_MAINNET_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  const keeperKey = await getSecret('LIQUIDATION_KEEPER_PRIVATE_KEY')
  const lendAddr  = process.env.PAWASAVE_LEND_ADDRESS
  if (!rpcUrl || !keeperKey || !lendAddr) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Liquidation keeper not configured' })
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    const keeper   = new ethers.Wallet(keeperKey, provider)
    const lend     = new ethers.Contract(lendAddr, LEND_ABI, keeper)
    const cngn     = new ethers.Contract(CNGN, ERC20_ABI, keeper)

    // ── Discover borrowers from Borrowed events over a recent window ──────────
    const latest    = await provider.getBlockNumber()
    const lookback  = Number(process.env.LIQUIDATION_LOOKBACK_BLOCKS || 200_000)
    const fromBlock = process.env.LIQUIDATION_FROM_BLOCK
      ? Number(process.env.LIQUIDATION_FROM_BLOCK)
      : Math.max(0, latest - lookback)
    const CHUNK = 9_000
    const borrowers = new Set<string>()
    for (let start = fromBlock; start <= latest; start += CHUNK + 1) {
      const end = Math.min(start + CHUNK, latest)
      try {
        const logs = await lend.queryFilter(lend.filters.Borrowed(), start, end)
        for (const l of logs) borrowers.add(((l as ethers.EventLog).args.borrower as string).toLowerCase())
      } catch { /* RPC range hiccup — skip this chunk */ }
    }

    const keeperCngn  = await cngn.balanceOf(keeper.address) as bigint
    const closeFactor = await lend.closeFactor() as bigint
    const results: Record<string, unknown>[] = []
    let liquidated = 0

    for (const borrower of borrowers) {
      try {
        if (!(await lend.isLiquidatable(borrower))) continue
        const debt = await lend.borrowBalanceCurrent(borrower) as bigint
        if (debt === 0n) continue

        let repay = (debt * closeFactor) / (10n ** 18n) // up to closeFactor of the debt
        if (repay > keeperCngn) repay = keeperCngn
        if (repay === 0n) { results.push({ borrower, skipped: 'keeper holds no cNGN' }); continue }

        // pick a collateral token the borrower actually holds
        let token = ''
        for (const t of COLLATERAL_TOKENS) {
          if ((await lend.collateralBalance(borrower, t)) > 0n) { token = t; break }
        }
        if (!token) { results.push({ borrower, skipped: 'no seizable collateral' }); continue }

        const allowance = await cngn.allowance(keeper.address, lendAddr)
        if (allowance < repay) {
          const a = await cngn.approve(lendAddr, ethers.MaxUint256)
          await a.wait()
        }
        const tx = await lend.liquidate(borrower, repay, token)
        await tx.wait()
        liquidated++
        results.push({ borrower, repaid: repay.toString(), token, tx: tx.hash })
      } catch (e: unknown) {
        const err = e as { shortMessage?: string; message?: string }
        results.push({ borrower, error: err?.shortMessage || err?.message || 'liquidate failed' })
      }
    }

    return NextResponse.json({ ok: true, scanned: borrowers.size, liquidated, results })
  } catch (err: unknown) {
    const e = err as { message?: string }
    console.error('[liquidate] error:', e?.message || err)
    return NextResponse.json({ error: e?.message || 'liquidation failed' }, { status: 500 })
  }
}