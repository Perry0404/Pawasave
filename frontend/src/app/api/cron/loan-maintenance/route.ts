import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { refreshEquityPrices } from '@/lib/equity-prices'

/**
 * GET /api/cron/loan-maintenance
 *
 * Two jobs for the custodial asset-backed lending book:
 *  1. accrue_loan_interest()    — roll interest forward on every active loan.
 *  2. liquidate_overdue_loans() — seize pledged collateral to settle a loan that
 *     is past its due date (after grace) or whose debt has reached the liquidation
 *     threshold of its collateral value. Surplus is returned to the borrower.
 *
 * Interest is computed from last_accrued_at, so the exact owed amount is correct
 * regardless of cadence; this cron just keeps the displayed figure fresh and runs
 * liquidations promptly. Both are idempotent, DB-side, SECURITY DEFINER RPCs.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const out: Record<string, unknown> = {}

  // Refresh prices for every pledged stock so liquidation judges undercollateralisation
  // on fresh values (a stale price only lets the overdue trigger fire, never a false one).
  try {
    const { data: pledged } = await admin
      .from('portfolio_holdings').select('symbol').not('pledged_loan_id', 'is', null).gt('shares', 0)
    const symbols = [...new Set((pledged || []).map((r: any) => r.symbol))]
    if (symbols.length) out.pricesRefreshed = await refreshEquityPrices(admin, symbols)
  } catch (e) {
    out.priceRefreshError = e instanceof Error ? e.message : String(e)
  }

  try {
    const { data, error } = await admin.rpc('accrue_loan_interest')
    if (error) throw error
    out.accrue = data
  } catch (e) {
    out.accrueError = e instanceof Error ? e.message : String(e)
  }
  try {
    const { data, error } = await admin.rpc('liquidate_overdue_loans')
    if (error) throw error
    out.liquidate = data
  } catch (e) {
    out.liquidateError = e instanceof Error ? e.message : String(e)
  }

  console.info('[loan-maintenance]', out)
  return NextResponse.json({ ok: true, ...out })
}