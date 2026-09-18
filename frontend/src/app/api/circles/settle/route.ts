import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/circles/settle  { groupId }
 *
 * Pays a COLLECTION / group-buy circle's pot to its beneficiary in one move (the seller, celebrant,
 * or harambee recipient). Only the owner or the beneficiary may trigger it. The credit + status flip
 * happen inside circle_settle (SECURITY DEFINER, FOR UPDATE, idempotent).
 */
export const dynamic = 'force-dynamic'

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

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const groupId = String(body?.groupId || '')
    if (!/^[0-9a-f-]{36}$/.test(groupId)) return NextResponse.json({ error: 'Invalid circle' }, { status: 400 })

    const admin = serviceDb()
    const { data: ok, error } = await admin.rpc('circle_settle', { p_group_id: groupId, p_actor: user.id })
    if (error || ok === false) {
      const m = error?.message || ''
      const msg = /only the owner or beneficiary/i.test(m) ? 'Only the circle owner or beneficiary can settle'
        : /no beneficiary/i.test(m) ? 'This circle has no beneficiary set'
        : /only collection/i.test(m) ? 'This circle type does not settle this way'
        : /cannot settle/i.test(m) ? 'This circle can no longer be settled'
        : 'Could not settle'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('[circles/settle] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
