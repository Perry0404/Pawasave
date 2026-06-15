import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/auth/beta-check  { email }  →  { allowed: boolean }
 *
 * Friendly pre-signup check so the UI can show a clear "beta is invite-only"
 * message instead of a generic database error. This is UX only — the real,
 * un-bypassable gate is the handle_new_user DB trigger (migration 029).
 *
 * Fails OPEN (allowed: true) on any misconfig/error, because the trigger is the
 * authoritative backstop and we don't want a transient issue to block signups.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let email = ''
  try {
    const body = await request.json()
    email = String(body?.email || '').trim().toLowerCase()
  } catch {
    return NextResponse.json({ allowed: true })
  }
  if (!email || !email.includes('@')) return NextResponse.json({ allowed: true })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ allowed: true })

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } })
    const { data, error } = await supabase.rpc('is_signup_allowed', { p_email: email })
    if (error) return NextResponse.json({ allowed: true })
    return NextResponse.json({ allowed: data === true })
  } catch {
    return NextResponse.json({ allowed: true })
  }
}