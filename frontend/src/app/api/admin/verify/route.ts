import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { setAdminCookie } from '@/lib/admin-session'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return request.headers.get('x-real-ip') || 'unknown'
}

function adminDb(): SupabaseClient | null {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
}

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }

  const body = await request.json()
  const { password } = body

  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Password required' }, { status: 400 })
  }

  // V2-LOW-04: brute-force lockout. Bail before comparing if this IP is locked.
  const db = adminDb()
  const ip = clientIp(request)
  if (db) {
    const { data: lockedUntil } = await db.rpc('admin_login_locked', { p_ip: ip })
    if (lockedUntil) {
      return NextResponse.json(
        { error: 'Too many attempts. Try again later.' },
        { status: 429, headers: { 'Retry-After': '900' } },
      )
    }
  }

  // Constant-time comparison to prevent timing attacks
  const encoder = new TextEncoder()
  const a = encoder.encode(password)
  const b = encoder.encode(ADMIN_PASSWORD)

  const crypto = await import('crypto')
  const match = a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)

  // Record the attempt (success clears the counter, failure increments/locks).
  if (db) {
    await db.rpc('admin_login_record', { p_ip: ip, p_success: match })
  }

  if (!match) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  // Issue an httpOnly session cookie instead of having the client keep the
  // password around (V2-HIGH-03).
  return setAdminCookie(NextResponse.json({ ok: true }))
}