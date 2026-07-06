import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'

/**
 * POST /api/admin/reconcile-withdrawals
 * Admin-only. Fixes off-ramp withdrawals stuck in 'pending'.
 *
 * An off-ramp that reached the on-chain send ("… on-chain: 0x…" in the
 * description) has irrevocably delivered cNGN to the provider — that's the point
 * of no return, so it is COMPLETED. New off-ramps mark themselves completed at
 * send time (see ramp/route.ts), but ones settled BEFORE that fix, or whose
 * Flipeet callback never fired, sit 'pending' forever. Mark them completed so the
 * app and the admin transaction-volume numbers reflect reality.
 *
 * Body: { password? }
 */
export const maxDuration = 30

export async function POST(request: NextRequest) {
  let body: { password?: string } = {}
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

  // Only complete withdrawals that actually settled on-chain — never a bare
  // 'pending' with no send (that's a genuine failure the reconcile cron refunds).
  const { data, error } = await supabase
    .from('transactions')
    .update({ status: 'completed' })
    .eq('type', 'withdrawal')
    .eq('status', 'pending')
    .like('description', '%on-chain:%')
    .select('id, reference, amount_kobo, description')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    completed: data?.length ?? 0,
    withdrawals: (data ?? []).map((r) => ({
      reference: r.reference,
      naira: Number(r.amount_kobo) / 100,
    })),
  })
}