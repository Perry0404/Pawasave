import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/p2p/resolve?to=<@tag | email>
 * Recipient preview for the send box, so the user confirms who they're paying before sending.
 * Returns a first name only (never email/id/phone) for an existing user; for an unknown email it
 * says a claim link will be sent; for an unknown tag it says not found. Requires a session so this
 * isn't an open handle/email enumeration endpoint, and only ever discloses a display name.
 */
export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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

const firstName = (dn?: string | null, fallback = 'PawaSave user') =>
  String(dn || '').trim().split(' ')[0] || fallback

export async function GET(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const raw = (request.nextUrl.searchParams.get('to') || '').trim()
    if (!raw) return NextResponse.json({ found: false, type: 'empty' })

    const admin = serviceDb()
    const isEmail = raw.includes('@') && EMAIL_RE.test(raw.toLowerCase())

    if (isEmail) {
      const email = raw.toLowerCase()
      if (email === (user.email || '').toLowerCase()) return NextResponse.json({ found: false, type: 'self' })
      const { data: id } = await admin.rpc('find_user_by_email', { p_email: email })
      if (id) {
        const { data: p } = await admin.from('profiles').select('display_name, tag').eq('id', id).maybeSingle()
        return NextResponse.json({ found: true, type: 'user', name: firstName(p?.display_name), tag: p?.tag || null, instant: true })
      }
      return NextResponse.json({ found: true, type: 'email-new', instant: false }) // will be a claim
    }

    // Tag path
    const tag = raw.replace(/^@+/, '').toLowerCase()
    if (!TAG_RE.test(tag)) return NextResponse.json({ found: false, type: 'invalid' })
    const { data: p } = await admin.from('profiles').select('id, display_name, tag').eq('tag', tag).maybeSingle()
    if (!p) return NextResponse.json({ found: false, type: 'tag-missing' })
    if (p.id === user.id) return NextResponse.json({ found: false, type: 'self' })
    return NextResponse.json({ found: true, type: 'user', name: firstName(p.display_name), tag: p.tag, instant: true })
  } catch (e: unknown) {
    console.error('[p2p/resolve] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
