import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sendP2pRevertedEmail } from '@/lib/notify-tx'

/**
 * POST /api/p2p/cancel  { transferId }
 * Sender cancels a still-pending claim and gets the held money back instantly. The revert RPC is
 * guarded (only flips a 'pending' row, under FOR UPDATE), so a cancel racing with a claim or the
 * expiry cron can never double-refund.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

async function sessionUser() {
  const store = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const transferId = Number(body?.transferId)
    if (!transferId) return NextResponse.json({ error: 'transferId required' }, { status: 400 })

    const admin = serviceDb()

    // Scope to this sender + pending, so nobody can cancel a transfer they didn't send.
    const { data: t } = await admin
      .from('p2p_transfers')
      .select('id, sender_id, recipient_email, amount_micro, reference, status')
      .eq('id', transferId)
      .eq('sender_id', user.id)
      .maybeSingle()
    if (!t) return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
    if (t.status !== 'pending') return NextResponse.json({ error: 'This transfer can no longer be cancelled' }, { status: 409 })

    const { data: ok, error } = await admin.rpc('p2p_revert', { p_transfer_id: transferId, p_reason: 'cancelled' })
    if (error) return NextResponse.json({ error: 'Could not cancel' }, { status: 400 })
    if (ok !== true) return NextResponse.json({ error: 'This transfer can no longer be cancelled' }, { status: 409 })

    sendP2pRevertedEmail(user.id, {
      amountNgn: Number(t.amount_micro || 0) / 1_000_000,
      toLabel: t.recipient_email || 'recipient',
      reason: 'cancelled',
      reference: t.reference,
    }).catch(() => {})

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('[p2p/cancel] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
