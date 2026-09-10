import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { hashPin, verifyPin } from '@/lib/pin-hash'
import { pinLockGuard, recordPinResult } from '@/lib/pin-lockout'

/**
 * POST /api/security/pin — set or change the 4-digit transaction PIN, securely.
 *
 * The old flow wrote transaction_pin_hash directly from the client with NO check of
 * the current PIN — so a hijacked session could silently reset the PIN and then
 * authorise withdrawals/loans. This route:
 *   • requires an authenticated session,
 *   • requires (and verifies) the CURRENT pin when one already exists,
 *   • hashes the new PIN server-side with scrypt (never trusting a client hash),
 *   • writes with the service role — the only path allowed by the DB trigger in
 *     migration 045, which blocks any authenticated client from changing the hash.
 */
async function getUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return { user, supabase }
}

export async function POST(request: NextRequest) {
  const { user, supabase } = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const newPin = String(body.newPin || '')
  const currentPin = body.currentPin ? String(body.currentPin) : ''
  if (!/^\d{4}$/.test(newPin)) {
    return NextResponse.json({ error: 'PIN must be exactly 4 digits' }, { status: 400 })
  }

  const { data: profile } = await supabase.from('profiles').select('transaction_pin_hash').eq('id', user.id).single()

  // Changing an existing PIN requires proving you know the current one.
  if (profile?.transaction_pin_hash) {
    if (!/^\d{4}$/.test(currentPin)) {
      return NextResponse.json({ error: 'Enter your current PIN to change it' }, { status: 400 })
    }
    const lock = await pinLockGuard(user.id)
    if (lock.locked) return NextResponse.json({ error: lock.message }, { status: 429 })
    const { ok } = verifyPin(currentPin, profile.transaction_pin_hash)
    const attempt = await recordPinResult(user.id, ok)
    if (!ok) return NextResponse.json({ error: attempt.message || 'Current PIN is incorrect' }, { status: attempt.justLocked ? 429 : 401 })
    if (currentPin === newPin) {
      return NextResponse.json({ error: 'New PIN must be different from the current one' }, { status: 400 })
    }
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  const { error } = await admin
    .from('profiles')
    .update({ transaction_pin_hash: hashPin(newPin), pin_set_at: new Date().toISOString() })
    .eq('id', user.id)
  if (error) return NextResponse.json({ error: 'Could not update PIN' }, { status: 500 })

  return NextResponse.json({ ok: true })
}