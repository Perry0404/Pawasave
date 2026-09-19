/**
 * morpho-treasury.ts — phase 2 wiring of Morpho liquidity into the loan desk (SERVER, DARK).
 *
 * When a user takes a stock-backed loan (create_loan, migration 042), the loan is
 * disbursed to their ledger SYNCHRONOUSLY and works regardless of what happens here.
 * This module then runs in the BACKGROUND to back that disbursement with real cNGN:
 * post the pledged stock to Morpho → borrow USDC → HyperFX → cNGN in custody. On repay
 * or liquidation it unwinds (cNGN → USDC → repay Morpho → withdraw the collateral).
 *
 * Safety by construction:
 *   • Inert unless MORPHO_ENABLED + a configured market + HYPERFX_ENABLED (see lib/morpho.ts).
 *   • NEVER blocks or fails the user's loan — every path here is best-effort; a failure
 *     just means custody's existing float backs the loan (exactly as it does today), and
 *     the reconcile cron retries.
 *   • Borrows at the USER equity LTV (morpho_target_ltv_bps, default 40%), far under
 *     Morpho's own LLTV (~77%), so custody sits well clear of Morpho liquidation.
 *   • Per-loan accounting in morpho_loan_draws (089), so repay/liquidation unwinds only
 *     that loan's share of custody's aggregate Morpho position.
 *
 * Approximation accepted for the MVP: unwind repays each leg's borrowed principal, not
 * principal+accrued Morpho interest (a few bps over the loan's days). The user's loan APR
 * exceeds Morpho's borrow APR, so that residual is covered by interest revenue; it leaves
 * at most dust debt in custody's aggregate position. Precise per-loan interest settlement
 * is a later refinement.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { withLease } from './custody-lease'
import { HYPERFX_ENABLED, convertUsdcToCngn, convertCngnToUsdc } from './hyperfx'
import { custodyCngnBalance, cngnToShares, custodyLendShares, withdrawFromLend } from './custody'
import {
  isMorphoLive, morphoSymbols, supplyCollateral, borrowUsdc, repayShares,
  withdrawCollateral, owedUsdcForShares,
} from './morpho'

const B20_DECIMALS = 8
const DEFAULT_RATE = 1600

/**
 * Make sure custody holds `needMicro` of FREE cNGN before a HyperFX cNGN→USDC leg.
 * The reconcile sweep keeps custody's working cNGN in the PawasaveLend pool (as psNGN
 * shares) for yield, so custody's free balance is usually ~0 — redeem just enough back
 * (plus 1% rounding buffer, capped at held shares). Mirrors equity-broker.ensureFreeCngn.
 * MUST be called under the custody lease (withdrawFromLend signs). Throws if the pool
 * can't cover it.
 */
async function ensureFreeCngn(needMicro: bigint): Promise<void> {
  const free = await custodyCngnBalance()
  if (free >= needMicro) return
  const shortfall = needMicro - free
  let shares = await cngnToShares(shortfall + shortfall / 100n)
  const held = await custodyLendShares()
  if (shares > held) shares = held
  if (shares <= 0n) throw new Error('insufficient pool liquidity to free cNGN for unwind')
  await withdrawFromLend(shares)
}

interface Leg {
  symbol: string; collateral_base: string; usdc_micro: string
  borrow_shares: string; supply_tx: string; borrow_tx: string
  // Set as each unwind leg completes, so a retry resumes instead of re-repaying (which
  // would over-repay other loans' debt in the shared aggregate position).
  repaid?: boolean; withdrawn?: boolean
}

async function setting(admin: SupabaseClient, key: string, dflt: number): Promise<number> {
  const { data } = await admin.from('platform_settings').select('value').eq('key', key).maybeSingle()
  const n = Number((data as any)?.value)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/**
 * Back a freshly-disbursed loan with Morpho liquidity. Best-effort, fire-and-forget:
 * callers do `void fundLoanFromMorpho(admin, loanId).catch(() => {})`.
 */
export async function fundLoanFromMorpho(admin: SupabaseClient, loanId: string): Promise<void> {
  if (!isMorphoLive() || !HYPERFX_ENABLED) return
  const syms = new Set(morphoSymbols())

  const { data: loan } = await admin
    .from('loans').select('id,user_id,principal_micro,origination_fee_micro,status')
    .eq('id', loanId).maybeSingle()
  if (!loan || (loan as any).status !== 'active') return
  const targetCngn = Math.max(0, Number((loan as any).principal_micro) - Number((loan as any).origination_fee_micro || 0))
  if (targetCngn <= 0) return

  // Idempotency — never draw twice for one loan.
  const { data: existing } = await admin.from('morpho_loan_draws').select('id').eq('loan_id', loanId).maybeSingle()
  if (existing) return

  // Pledged equity collateral for this loan, joined to symbol + shares.
  const { data: coll } = await admin
    .from('loan_collateral').select('asset_ref,pledged_value_micro')
    .eq('loan_id', loanId).eq('asset_type', 'equity')
  if (!coll?.length) return
  const ids = coll.map((c: any) => c.asset_ref)
  const { data: holdings } = await admin
    .from('portfolio_holdings').select('id,symbol,shares').in('id', ids)
  const byId = new Map((holdings || []).map((h: any) => [String(h.id), h]))

  type Elig = { symbol: string; shares: number; pledgedMicro: number }
  const eligible: Elig[] = []
  for (const c of coll as any[]) {
    const h = byId.get(String(c.asset_ref))
    const symbol = String(h?.symbol || '').toUpperCase()
    if (!h || !syms.has(symbol) || !(Number(h.shares) > 0)) continue
    eligible.push({ symbol, shares: Number(h.shares), pledgedMicro: Number(c.pledged_value_micro) || 0 })
  }
  if (!eligible.length) return

  const rate = await setting(admin, 'usd_ngn_rate', DEFAULT_RATE)
  const ltvBps = await setting(admin, 'morpho_target_ltv_bps', 4000)
  const targetUsdc = BigInt(Math.floor(targetCngn / rate)) // cNGN-micro / (NGN/USD) = USDC-micro

  await admin.from('morpho_loan_draws').insert({ loan_id: loanId, user_id: (loan as any).user_id, status: 'pending' })

  const legs: Leg[] = []
  let borrowed = 0n
  try {
    const outcome = await withLease('custody:signer', async () => {
      for (const e of eligible) {
        if (borrowed >= targetUsdc) break
        const collateralBase = BigInt(Math.floor(e.shares * 10 ** B20_DECIMALS))
        const capacity = BigInt(Math.floor((e.pledgedMicro / rate) * (ltvBps / 10_000)))
        const want = targetUsdc - borrowed
        const borrowThis = want < capacity ? want : capacity
        if (borrowThis <= 0n || collateralBase <= 0n) continue
        const supply_tx = await supplyCollateral(e.symbol, collateralBase)
        const { txHash: borrow_tx, shares } = await borrowUsdc(e.symbol, borrowThis)
        legs.push({
          symbol: e.symbol, collateral_base: collateralBase.toString(), usdc_micro: borrowThis.toString(),
          borrow_shares: shares.toString(), supply_tx, borrow_tx,
        })
        borrowed += borrowThis
      }
      if (borrowed <= 0n) throw new Error('no Morpho capacity for this loan')
      // USDC → cNGN. A no-solver auction throws; the USDC is already borrowed and sits
      // in custody, so we park 'settling' (never re-borrow) for the reconcile cron.
      try {
        const cngn = await convertUsdcToCngn(borrowed)
        return { status: 'funded' as const, cngn }
      } catch {
        return { status: 'settling' as const, cngn: 0n }
      }
    }, { holder: `morpho-fund ${loanId}`, waitMs: 25_000 })

    await admin.from('morpho_loan_draws').update({
      status: outcome.status, legs, usdc_micro: borrowed.toString(),
      cngn_micro: outcome.cngn.toString(), updated_at: new Date().toISOString(),
    }).eq('loan_id', loanId)
  } catch (e) {
    // Record whatever legs executed so reconcile can unwind them; the loan is unaffected.
    await admin.from('morpho_loan_draws').update({
      status: legs.length ? 'settling' : 'failed', legs, usdc_micro: borrowed.toString(),
      error: (e instanceof Error ? e.message : 'fund failed').slice(0, 500), updated_at: new Date().toISOString(),
    }).eq('loan_id', loanId)
    console.error('[morpho-treasury] fund failed', { loanId, msg: e instanceof Error ? e.message : e })
  }
}

/**
 * Unwind a loan's Morpho position: cNGN → USDC → repay each leg → withdraw its collateral.
 * Called on full repayment or after liquidation. Best-effort; reconcile retries.
 */
export async function unwindLoanFromMorpho(admin: SupabaseClient, loanId: string): Promise<void> {
  if (!isMorphoLive() || !HYPERFX_ENABLED) return

  // Atomic claim: only ONE runner may unwind a draw. Flip funded/settling → unwinding;
  // a racing runner (inline repay vs reconcile cron) gets no row back and returns.
  const { data: claimed } = await admin
    .from('morpho_loan_draws')
    .update({ status: 'unwinding', updated_at: new Date().toISOString() })
    .eq('loan_id', loanId).in('status', ['funded', 'settling'])
    .select('*').maybeSingle()
  if (!claimed) return

  const legs = ((claimed as any).legs || []) as Leg[]
  const cngnIn = BigInt((claimed as any).cngn_micro || '0')
  let cngnRepaidAccum = BigInt((claimed as any).cngn_repaid_micro || '0')
  if (!legs.length) {
    await admin.rpc('record_morpho_unwind', { p_loan_id: loanId, p_cngn_repaid_micro: '0', p_financing_cost_micro: '0', p_repay_tx: null })
    return
  }
  const rate = await setting(admin, 'usd_ngn_rate', DEFAULT_RATE)

  let cngnUsedThisRun = 0n
  let repayTx = ''
  try {
    await withLease('custody:signer', async () => {
      // USDC still owed = legs not yet repaid (idempotent: a resumed run skips done legs).
      let owed = 0n
      for (const leg of legs) if (!leg.repaid) owed += await owedUsdcForShares(leg.symbol, BigInt(leg.borrow_shares || '0'))

      // Buy back enough USDC via HyperFX (3% headroom for FX drift + interest tick).
      if (owed > 0n) {
        const cngnToConvert = (owed * BigInt(Math.round(rate)) * 103n) / 100n
        // Custody's working cNGN lives in the lend pool — free up enough first, or the
        // HyperFX transfer reverts ("transfer amount exceeds balance").
        await ensureFreeCngn(cngnToConvert)
        const usdcGot = await convertCngnToUsdc(cngnToConvert)
        if (usdcGot < owed) throw new Error(`unwind FX short: got ${usdcGot} < owed ${owed}`)
        // Only the fraction of converted cNGN that actually clears the debt is a cost;
        // leftover USDC stays custody float (excluded).
        cngnUsedThisRun = (cngnToConvert * owed) / usdcGot
      }

      // Close each leg by SHARES (principal + interest) then pull its collateral. Each
      // step flips a flag so a mid-way failure resumes here instead of repeating.
      for (const leg of legs) {
        if (!leg.repaid) {
          const sh = BigInt(leg.borrow_shares || '0')
          if (sh > 0n) repayTx = await repayShares(leg.symbol, sh)
          leg.repaid = true
        }
        if (!leg.withdrawn) {
          await withdrawCollateral(leg.symbol, BigInt(leg.collateral_base))
          leg.withdrawn = true
        }
      }
    }, { holder: `morpho-unwind ${loanId}`, waitMs: 60_000 })

    cngnRepaidAccum += cngnUsedThisRun
    const allDone = legs.every((l) => l.repaid && l.withdrawn)
    if (allDone) {
      const financingCost = cngnRepaidAccum - cngnIn
      await admin.rpc('record_morpho_unwind', {
        p_loan_id: loanId,
        p_cngn_repaid_micro: cngnRepaidAccum.toString(),
        p_financing_cost_micro: financingCost.toString(),
        p_repay_tx: repayTx || null,
      })
    } else {
      // Shouldn't happen (loop completes or throws), but persist and let reconcile resume.
      await admin.from('morpho_loan_draws').update({
        status: 'funded', legs, cngn_repaid_micro: cngnRepaidAccum.toString(), updated_at: new Date().toISOString(),
      }).eq('loan_id', loanId)
    }
  } catch (e) {
    // Persist per-leg progress + cNGN spent so far, and hand back to 'funded' so the
    // reconcile cron resumes ONLY the remaining legs (never re-repaying a done one).
    cngnRepaidAccum += cngnUsedThisRun
    await admin.from('morpho_loan_draws').update({
      status: 'funded', legs, cngn_repaid_micro: cngnRepaidAccum.toString(),
      error: (e instanceof Error ? e.message : 'unwind failed').slice(0, 500), updated_at: new Date().toISOString(),
    }).eq('loan_id', loanId)
    console.error('[morpho-treasury] unwind failed (will retry)', { loanId, msg: e instanceof Error ? e.message : e })
  }
}

/**
 * Cron: (1) finish 'settling' draws whose USDC→cNGN auction had no solver; (2) unwind
 * draws whose loan has since been repaid/liquidated; (3) warn on any position drifting
 * toward Morpho's LLTV. Best-effort and idempotent.
 */
export async function reconcileMorphoDraws(admin: SupabaseClient): Promise<{ settled: number; unwound: number }> {
  const out = { settled: 0, unwound: 0 }
  if (!isMorphoLive() || !HYPERFX_ENABLED) return out

  // 0) Recover draws stuck 'unwinding' (a process died mid-unwind). After a grace period,
  //    hand them back to 'funded' so the unwind (idempotent per-leg) resumes.
  const staleIso = new Date(Date.now() - 5 * 60_000).toISOString()
  await admin.from('morpho_loan_draws')
    .update({ status: 'funded', updated_at: new Date().toISOString() })
    .eq('status', 'unwinding').lt('updated_at', staleIso)

  // 1) settling → retry the USDC→cNGN conversion.
  const { data: settling } = await admin
    .from('morpho_loan_draws').select('loan_id,usdc_micro').eq('status', 'settling').limit(50)
  for (const d of (settling || []) as any[]) {
    try {
      const cngn = await withLease('custody:signer', () => convertUsdcToCngn(BigInt(d.usdc_micro || '0')),
        { holder: `morpho-settle ${d.loan_id}`, waitMs: 20_000 })
      if (cngn > 0n) {
        await admin.from('morpho_loan_draws').update({
          status: 'funded', cngn_micro: cngn.toString(), updated_at: new Date().toISOString(),
        }).eq('loan_id', d.loan_id)
        out.settled++
      }
    } catch { /* no solver yet — try next run */ }
  }

  // 2) unwind draws whose loan is no longer active.
  const { data: openDraws } = await admin
    .from('morpho_loan_draws').select('loan_id').in('status', ['funded', 'settling']).limit(100)
  for (const d of (openDraws || []) as any[]) {
    const { data: loan } = await admin.from('loans').select('status').eq('id', d.loan_id).maybeSingle()
    const st = String((loan as any)?.status || '')
    if (st === 'repaid' || st === 'liquidated') {
      await unwindLoanFromMorpho(admin, d.loan_id)
      out.unwound++
    }
  }
  return out
}
