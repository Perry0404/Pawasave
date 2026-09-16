import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sendP2pReceivedEmail } from '@/lib/notify-tx'

/**
 * POST /api/p2p/claim   { transferId? }
 *
 * Claims money sent to the caller's email while they had no account. The binding is the caller's
 * VERIFIED email: we only ever credit a pending row whose recipient_email matches the
 * authenticated (and confirmed) address. No claim token travels in the invite link — controlling
 * the inbox and completing normal email verification IS the proof, which keeps the flow off the
 * fintech-phishing path.
 *
 * With no transferId, claims every pending transfer addressed to this email.
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

    const email = (user.email || '').trim().toLowerCase()
    // Only a confirmed address can claim — otherwise anyone could sign up with someone else's
    // email and grab their money without ever proving they control the inbox.
    const confirmed = Boolean((user as any).email_confirmed_at || (user as any).confirmed_at)
    if (!email || !confirmed) {
      return NextResponse.json({ error: 'Verify your email address to claim', code: 'email_unverified' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const onlyId = body?.transferId != null ? Number(body.transferId) : null

    const admin = serviceDb()

    let q = admin
      .from('p2p_transfers')
      .select('id, sender_id, amount_micro, note, reference, expires_at')
      .eq('status', 'pending')
      .eq('recipient_email', email)
    if (onlyId != null) q = q.eq('id', onlyId)
    const { data: rows } = await q

    const pending = (rows || []).filter((r: any) => !r.expires_at || new Date(r.expires_at).getTime() > Date.now())
    if (pending.length === 0) return NextResponse.json({ ok: true, claimed: 0, totalNgn: 0 })

    let claimed = 0
    let totalMicro = 0
    for (const t of pending) {
      const { data: ok, error } = await admin.rpc('p2p_claim', {
        p_transfer_id: t.id,
        p_recipient: user.id,
        p_recipient_email: email,
      })
      if (error) { console.error('[p2p/claim] rpc error', t.id, error.message); continue }
      if (ok === true) {
        claimed++
        totalMicro += Number(t.amount_micro || 0)
        // Receipt to the claimer, naming the sender.
        const { data: sp } = await admin.from('profiles').select('display_name').eq('id', t.sender_id).maybeSingle()
        const fromLabel = String(sp?.display_name || '').split(' ')[0] || 'A PawaSave friend'
        sendP2pReceivedEmail(user.id, {
          amountNgn: Number(t.amount_micro || 0) / 1_000_000,
          fromLabel, note: t.note, reference: t.reference,
        }).catch(() => {})
      }
    }

    return NextResponse.json({ ok: true, claimed, totalNgn: totalMicro / 1_000_000 })
  } catch (e: unknown) {
    console.error('[p2p/claim] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
