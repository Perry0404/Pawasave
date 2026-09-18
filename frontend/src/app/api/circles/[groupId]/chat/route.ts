import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET  /api/circles/<groupId>/chat        → recent messages (members only)
 * POST /api/circles/<groupId>/chat  { body }   → post a message (members only)
 *
 * The per-circle chat thread from §3.3. Membership is checked server-side against esusu_members; the
 * circle_messages RLS enforces the same, so a non-member can neither read nor write.
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

async function assertMember(admin: any, groupId: string, userId: string): Promise<boolean> {
  const { data } = await admin
    .from('esusu_members').select('id').eq('group_id', groupId).eq('user_id', userId).maybeSingle()
  return Boolean(data)
}

export async function GET(_request: NextRequest, { params }: { params: { groupId: string } }) {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const groupId = params.groupId
  if (!/^[0-9a-f-]{36}$/.test(groupId)) return NextResponse.json({ error: 'Invalid circle' }, { status: 400 })

  const admin = serviceDb()
  if (!(await assertMember(admin, groupId, user.id))) {
    return NextResponse.json({ error: 'Not a member of this circle' }, { status: 403 })
  }

  const { data: rows } = await admin
    .from('circle_messages')
    .select('id, user_id, body, created_at')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(100)

  const ids = Array.from(new Set((rows || []).map((r: any) => r.user_id)))
  const nameById: Record<string, string> = {}
  if (ids.length) {
    const { data: profs } = await admin.from('profiles').select('id, display_name, tag').in('id', ids)
    for (const p of profs || []) nameById[p.id] = p.display_name || (p.tag ? `@${p.tag}` : 'Member')
  }

  const messages = (rows || []).reverse().map((r: any) => ({
    id: r.id,
    body: r.body,
    createdAt: r.created_at,
    author: nameById[r.user_id] || 'Member',
    mine: r.user_id === user.id,
  }))
  return NextResponse.json({ messages })
}

export async function POST(request: NextRequest, { params }: { params: { groupId: string } }) {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const groupId = params.groupId
  if (!/^[0-9a-f-]{36}$/.test(groupId)) return NextResponse.json({ error: 'Invalid circle' }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const text = String(body?.body || '').trim().slice(0, 1000)
  if (!text) return NextResponse.json({ error: 'Empty message' }, { status: 400 })

  const admin = serviceDb()
  if (!(await assertMember(admin, groupId, user.id))) {
    return NextResponse.json({ error: 'Not a member of this circle' }, { status: 403 })
  }

  const { error } = await admin.from('circle_messages').insert({ group_id: groupId, user_id: user.id, body: text })
  if (error) return NextResponse.json({ error: 'Could not send' }, { status: 400 })
  return NextResponse.json({ ok: true })
}
