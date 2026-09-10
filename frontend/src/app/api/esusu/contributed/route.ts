import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { sendAjoContributeEmail } from '@/lib/notify-tx'

/**
 * POST /api/esusu/contributed   { group_id }
 *
 * Fire-and-forget: sends the "you contributed to <circle>" confirmation email after a
 * successful Ajo contribution (the contribution itself is an RPC from the client). The
 * ledger record is written by esusu_contribute (migration 069); this only emails.
 * Auth: must be a logged-in member of the group.
 */
export async function POST(request: NextRequest) {
  let body: { group_id?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const groupId = body.group_id
  if (!groupId || !/^[0-9a-f-]{36}$/i.test(groupId)) {
    return NextResponse.json({ error: 'Invalid group_id' }, { status: 400 })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const cookieStore = await cookies()
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  const { data: membership } = await admin
    .from('esusu_members').select('id').eq('group_id', groupId).eq('user_id', user.id).maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Not a member of this group' }, { status: 403 })

  const { data: group } = await admin
    .from('esusu_groups').select('name, contribution_amount_kobo, current_cycle').eq('id', groupId).maybeSingle()
  if (!group) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  await sendAjoContributeEmail(user.id, {
    amountNgn: Number(group.contribution_amount_kobo || 0) / 100,
    groupName: group.name || 'Ajo',
    cycle: group.current_cycle ?? null,
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}
