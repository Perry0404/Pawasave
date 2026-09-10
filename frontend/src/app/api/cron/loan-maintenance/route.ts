import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { refreshEquityPrices } from '@/lib/equity-prices'
import { sendPushToUser } from '@/lib/push-send'

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

  // "Loan due in ≤3 days" reminder — once per loan (due_reminder_sent flag, mig 051).
  try {
    const soon = new Date(Date.now() + 3 * 864e5).toISOString()
    const now = new Date().toISOString()
    const { data: dueLoans } = await admin
      .from('loans')
      .select('id, user_id, principal_micro, accrued_interest_micro, due_date')
      .eq('status', 'active').eq('due_reminder_sent', false)
      .gte('due_date', now).lte('due_date', soon)
    let sent = 0
    for (const l of dueLoans || []) {
      const owed = (Number(l.principal_micro) + Number(l.accrued_interest_micro)) / 1e6
      await sendPushToUser(l.user_id, {
        title: 'Loan due soon',
        body: `Your ₦${owed.toLocaleString('en-NG', { maximumFractionDigits: 2 })} loan is due ${new Date(l.due_date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}. Repay to keep your collateral.`,
        url: '/', tag: 'loan-due',
      }).catch(() => {})
      await admin.from('loans').update({ due_reminder_sent: true }).eq('id', l.id)
      sent++
    }
    out.dueReminders = sent
  } catch (e) {
    out.reminderError = e instanceof Error ? e.message : String(e)
  }

  console.info('[loan-maintenance]', out)
  return NextResponse.json({ ok: true, ...out })
}