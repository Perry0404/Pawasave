import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'

/**
 * POST /api/admin/reconcile-withdrawals
 * Admin-only. Inspect + correct off-ramp withdrawal states.
 *
 * View (always returned): the 20 most recent withdrawals (all statuses) + the
 * wallet balances of the users involved, so the operator can see the truth.
 *
 * Actions (body):
 *   { markCompleted: [ref, …] } → set those refs to 'completed'
 *   { markFailed:    [ref, …] } → set those refs to 'failed'
 *   { autoCompleteOnchain: true } → complete every pending withdrawal that carries
 *                                   an on-chain send hash ("… on-chain: 0x…").
 *
 * Balance corrections (reversing a false refund) are done via SQL, not here — this
 * endpoint deliberately cannot mutate wallet balances.
 */
export const maxDuration = 30

export async function POST(request: NextRequest) {
  let body: {
    password?: string
    markCompleted?: string[]
    markFailed?: string[]
    autoCompleteOnchain?: boolean
  } = {}
  try { body = await request.json() } catch { /* no body */ }

  if (!process.env.ADMIN_PASSWORD || !isAuthorisedAdmin(request, body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const out: Record<string, unknown> = {}

  if (Array.isArray(body.markCompleted) && body.markCompleted.length) {
    const { data, error } = await supabase
      .from('transactions').update({ status: 'completed' })
      .eq('type', 'withdrawal').in('reference', body.markCompleted)
      .select('reference, amount_kobo, status')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    out.markedCompleted = data
  }

  if (Array.isArray(body.markFailed) && body.markFailed.length) {
    const { data, error } = await supabase
      .from('transactions').update({ status: 'failed' })
      .eq('type', 'withdrawal').in('reference', body.markFailed)
      .select('reference, amount_kobo, status')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    out.markedFailed = data
  }

  if (body.autoCompleteOnchain) {
    const { data, error } = await supabase
      .from('transactions').update({ status: 'completed' })
      .eq('type', 'withdrawal').eq('status', 'pending').like('description', '%on-chain:%')
      .select('reference, amount_kobo')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    out.autoCompleted = data
  }

  // ── Always return the current picture ──
  const { data: withdrawals } = await supabase
    .from('transactions')
    .select('user_id, reference, amount_kobo, status, description, created_at')
    .eq('type', 'withdrawal')
    .order('created_at', { ascending: false })
    .limit(20)
  out.withdrawals = (withdrawals ?? []).map((w) => ({
    user_id: w.user_id,
    reference: w.reference,
    naira: Number(w.amount_kobo) / 100,
    status: w.status,
    description: w.description,
    created_at: w.created_at,
  }))

  const userIds = [...new Set((withdrawals ?? []).map((w) => w.user_id))]
  if (userIds.length) {
    const { data: wallets } = await supabase
      .from('wallets')
      .select('user_id, usdc_balance_micro, cngn_pool_micro, cngn_yield_earned_micro, naira_balance_kobo')
      .in('user_id', userIds)
    out.wallets = (wallets ?? []).map((w) => ({
      user_id: w.user_id,
      spendable_cngn: Number(w.usdc_balance_micro) / 1e6,
      pool_cngn: Number(w.cngn_pool_micro) / 1e6,
      yield_cngn: Number(w.cngn_yield_earned_micro) / 1e6,
      naira_kobo: w.naira_balance_kobo,
    }))
  }

  return NextResponse.json(out)
}