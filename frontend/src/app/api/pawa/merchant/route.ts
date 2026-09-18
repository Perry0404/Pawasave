import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET  /api/pawa/merchant           → the caller's own merchant status + Pawa Tag
 * POST /api/pawa/merchant           → enable/update the caller as a seller
 *   { enabled?: boolean, merchantName?: string, merchantBio?: string }
 *
 * The Pawa Tag is the user's existing @tag (084) — a seller doesn't get a second handle. A seller
 * MUST already have a @tag; if they don't, we tell them to set one first.
 */
export const dynamic = 'force-dynamic'

async function ctx() {
  const store = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return { user }
}

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

export async function GET() {
  const { user } = await ctx()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const admin = serviceDb()
  const { data } = await admin
    .from('profiles')
    .select('tag, merchant_enabled, merchant_name, merchant_bio')
    .eq('id', user.id).maybeSingle()
  return NextResponse.json({
    tag: data?.tag || null,
    enabled: Boolean(data?.merchant_enabled),
    merchantName: data?.merchant_name || null,
    merchantBio: data?.merchant_bio || null,
  })
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await ctx()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const body = await request.json().catch(() => ({}))
    const admin = serviceDb()

    const { data: prof } = await admin.from('profiles').select('tag').eq('id', user.id).maybeSingle()
    if (!prof?.tag) {
      return NextResponse.json({ error: 'Set your @tag first — it becomes your Pawa Tag', code: 'tag_required' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    if (body?.enabled !== undefined) patch.merchant_enabled = Boolean(body.enabled)
    if (body?.merchantName !== undefined) patch.merchant_name = String(body.merchantName || '').slice(0, 60) || null
    if (body?.merchantBio !== undefined) patch.merchant_bio = String(body.merchantBio || '').slice(0, 200) || null
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    const { error } = await admin.from('profiles').update(patch).eq('id', user.id)
    if (error) return NextResponse.json({ error: 'Could not update' }, { status: 400 })

    return NextResponse.json({ ok: true, tag: prof.tag })
  } catch (e: unknown) {
    console.error('[pawa/merchant] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
