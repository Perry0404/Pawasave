import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET  /api/p2p/tag           → { tag } (the caller's current @tag)
 * POST /api/p2p/tag  { tag }  → sets a new @tag (validated + unique) via set_user_tag
 *
 * The browser can't write profiles (migration 080), so the change goes through the SECURITY
 * DEFINER set_user_tag with the service role; this route enforces it's the caller's own account.
 */
export const dynamic = 'force-dynamic'

const TAG_RE = /^[a-z0-9_]{3,20}$/

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
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const admin = serviceDb()
  const { data } = await admin.from('profiles').select('tag').eq('id', user.id).maybeSingle()
  return NextResponse.json({ tag: data?.tag || null })
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const tag = String(body?.tag ?? '').replace(/^@+/, '').trim().toLowerCase()
    if (!TAG_RE.test(tag)) {
      return NextResponse.json({ error: 'Tag must be 3–20 letters, numbers or underscores' }, { status: 400 })
    }

    const admin = serviceDb()
    const { data, error } = await admin.rpc('set_user_tag', { p_user_id: user.id, p_tag: tag })
    if (error) {
      if (/tag_taken/i.test(error.message)) return NextResponse.json({ error: 'That tag is already taken' }, { status: 409 })
      if (/invalid_tag/i.test(error.message)) return NextResponse.json({ error: 'Tag must be 3–20 letters, numbers or underscores' }, { status: 400 })
      return NextResponse.json({ error: 'Could not update tag' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, tag: data })
  } catch (e: unknown) {
    console.error('[p2p/tag] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
