import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/reconcile-withdrawals
 *
 * Marks off-ramp withdrawals that were debited but never delivered as 'failed'
 * and refunds the user. Covers the case where the off-ramp request died mid-flow
 * (e.g. a serverless timeout during the on-chain send) and the refund catch never
 * ran, leaving the tx stuck 'pending'. Only refunds when the on-chain send never
 * happened (fail_stale_withdrawals guards against double-refund via the tx
 * description). Runs every 15 min (see vercel.json).
 */
export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const wdMinutes = Number(process.env.WITHDRAWAL_RECONCILE_MINUTES) || 20
  const depMinutes = Number(process.env.DEPOSIT_RECONCILE_MINUTES) || 90
  const { data, error } = await supabase.rpc('reconcile_stale_transactions', {
    p_user_id: null,
    p_withdrawal_minutes: wdMinutes,
    p_deposit_minutes: depMinutes,
  })

  if (error) {
    console.error('[reconcile-withdrawals] error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.info('[reconcile-withdrawals] result:', data)
  return NextResponse.json({ ok: true, result: data })
}