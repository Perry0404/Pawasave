import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/admin/beta  — manage the beta cohort. Password-gated (ADMIN_PASSWORD).
 *
 * Body: { password, action, email?, mode? }
 *   action 'list'     → { mode, emails: [{email, note, added_at}] }
 *   action 'add'      → add email to allowlist        (requires email)
 *   action 'remove'   → remove email from allowlist   (requires email)
 *   action 'setMode'  → 'on' | 'off' beta gating      (requires mode)
 */
export const dynamic = 'force-dynamic'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aa = enc.encode(a)
  const bb = enc.encode(b)
  if (aa.byteLength !== bb.byteLength) return false
  return crypto.timingSafeEqual(aa, bb)
}

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })
  }

  let body: { password?: string; action?: string; email?: string; mode?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.password || !timingSafeEqual(body.password, ADMIN_PASSWORD)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const action = body.action
  const email = (body.email || '').trim().toLowerCase()

  try {
    if (action === 'list') {
      const [{ data: rows }, { data: setting }] = await Promise.all([
        supabase.from('beta_allowlist').select('email, note, added_at').order('added_at', { ascending: false }),
        supabase.from('platform_settings').select('value').eq('key', 'beta_mode').maybeSingle(),
      ])
      return NextResponse.json({ mode: (setting as any)?.value ?? 'off', emails: rows ?? [] })
    }

    if (action === 'add') {
      if (!email.includes('@')) return NextResponse.json({ error: 'Valid email required' }, { status: 400 })
      const { error } = await supabase.from('beta_allowlist').upsert({ email }, { onConflict: 'email' })
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (action === 'remove') {
      if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 })
      const { error } = await supabase.from('beta_allowlist').delete().eq('email', email)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (action === 'setMode') {
      const mode = body.mode === 'on' ? 'on' : 'off'
      const { error } = await supabase.from('platform_settings').upsert({ key: 'beta_mode', value: mode }, { onConflict: 'key' })
      if (error) throw error
      return NextResponse.json({ ok: true, mode })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e: unknown) {
    const err = e as { message?: string }
    console.error('[admin/beta] error:', err?.message || e)
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}