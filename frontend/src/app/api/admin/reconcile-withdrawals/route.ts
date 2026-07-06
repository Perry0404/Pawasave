import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'

/**
 * POST /api/admin/reconcile-withdrawals
 * Admin-only. Fixes off-ramp withdrawals stuck in 'pending'.
 *
 * Modes (body):
 *   {}                        → complete every pending withdrawal that carries an
 *                               on-chain send hash ("… on-chain: 0x…"); those have
 *                               irrevocably delivered cNGN to the provider.
 *   { markRecentPending: N }  → complete the N most-recent pending withdrawals,
 *                               regardless of description (operator asserts they
 *                               settled to the bank). Use when the description
 *                               update never landed so the on-chain marker is absent.
 *   { references: [ ... ] }   → complete these exact references.
 *
 * Always returns the current pending withdrawals so the operator can see state.
 */
export const maxDuration = 30

export async function POST(request: NextRequest) {
  let body: { password?: string; markRecentPending?: number; references?: string[] } = {}
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

  // Snapshot the pending withdrawals up front (for visibility + recent-N mode).
  const { data: pending } = await supabase
    .from('transactions')
    .select('id, reference, amount_kobo, description, created_at')
    .eq('type', 'withdrawal')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20)

  let completed: any[] = []

  if (Array.isArray(body.references) && body.references.length) {
    const { data, error } = await supabase
      .from('transactions')
      .update({ status: 'completed' })
      .eq('type', 'withdrawal').eq('status', 'pending')
      .in('reference', body.references)
      .select('id, reference, amount_kobo')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    completed = data ?? []
  } else if (typeof body.markRecentPending === 'number' && body.markRecentPending > 0) {
    const ids = (pending ?? []).slice(0, body.markRecentPending).map((r) => r.id)
    if (ids.length) {
      const { data, error } = await supabase
        .from('transactions')
        .update({ status: 'completed' })
        .in('id', ids)
        .select('id, reference, amount_kobo')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      completed = data ?? []
    }
  } else {
    // Default: complete only withdrawals that actually settled on-chain.
    const { data, error } = await supabase
      .from('transactions')
      .update({ status: 'completed' })
      .eq('type', 'withdrawal').eq('status', 'pending')
      .like('description', '%on-chain:%')
      .select('id, reference, amount_kobo')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    completed = data ?? []
  }

  return NextResponse.json({
    completed: completed.length,
    completedRefs: completed.map((r) => ({ reference: r.reference, naira: Number(r.amount_kobo) / 100 })),
    pendingBefore: (pending ?? []).map((r) => ({
      reference: r.reference,
      naira: Number(r.amount_kobo) / 100,
      description: r.description,
      created_at: r.created_at,
    })),
  })
}