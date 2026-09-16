import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

/**
 * GET /api/p2p/pending
 * Returns the caller's:
 *   • outgoing — their still-pending claims (cancellable), and
 *   • incoming — pending claims addressed to their VERIFIED email (so the app can show a
 *     "you have money waiting → Claim" banner). Incoming is resolved server-side against the
 *     confirmed session email, never by an email guess through RLS.
 */
export const dynamic = 'force-dynamic'

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

export async function GET() {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const admin = serviceDb()
    const nowIso = new Date().toISOString()

    const { data: out } = await admin
      .from('p2p_transfers')
      .select('id, recipient_email, amount_micro, note, expires_at, created_at')
      .eq('sender_id', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    const outgoing = (out || []).map((r: any) => ({
      id: r.id,
      toEmail: r.recipient_email,
      amountNgn: Number(r.amount_micro || 0) / 1_000_000,
      note: r.note,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }))

    let incoming: any[] = []
    const email = (user.email || '').trim().toLowerCase()
    const confirmed = Boolean((user as any).email_confirmed_at || (user as any).confirmed_at)
    if (email && confirmed) {
      const { data: inc } = await admin
        .from('p2p_transfers')
        .select('id, sender_id, amount_micro, note, expires_at')
        .eq('status', 'pending')
        .eq('recipient_email', email)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
      const senderIds = Array.from(new Set((inc || []).map((r: any) => r.sender_id)))
      const names: Record<string, string> = {}
      if (senderIds.length) {
        const { data: profs } = await admin.from('profiles').select('id, display_name').in('id', senderIds)
        for (const p of profs || []) names[p.id] = String(p.display_name || '').split(' ')[0] || 'A PawaSave friend'
      }
      incoming = (inc || []).map((r: any) => ({
        id: r.id,
        fromName: names[r.sender_id] || 'A PawaSave friend',
        amountNgn: Number(r.amount_micro || 0) / 1_000_000,
        note: r.note,
        expiresAt: r.expires_at,
      }))
    }

    return NextResponse.json({ outgoing, incoming })
  } catch (e: unknown) {
    console.error('[p2p/pending] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
