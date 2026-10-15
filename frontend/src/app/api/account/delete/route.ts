import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { verifyPin } from '@/lib/pin-hash'
import { pinLockGuard, recordPinResult } from '@/lib/pin-lockout'

/**
 * /api/account/delete — in-app account deletion (Google Play / App Store requirement).
 *
 *   GET   → { blockers: string[], hasPin }   what must be closed first (empty = can delete)
 *   POST  { pin, confirm: 'DELETE', reason? } → deletes
 *
 * Deletion never removes the auth user or profile row: profiles cascade from auth.users and the
 * financial records hang off profiles, which AML rules require us to keep (migration 118). So:
 *   1. delete_account() re-checks the account is empty, anonymises the profile, marks it deleted;
 *   2. the login is retired here: email replaced and the user banned, so it can never sign in again
 *      and the email address is free to register afresh.
 */
async function getUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export async function GET() {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  const db = admin()
  const [{ data: blockers, error }, { data: profile }] = await Promise.all([
    db.rpc('account_deletion_blockers', { p_user_id: user.id }),
    db.from('profiles').select('transaction_pin_hash').eq('id', user.id).single(),
  ])
  if (error) return NextResponse.json({ error: 'Could not check your account' }, { status: 500 })
  return NextResponse.json({ blockers: blockers || [], hasPin: !!profile?.transaction_pin_hash })
}

export async function POST(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  if (body?.confirm !== 'DELETE') return NextResponse.json({ error: 'Type DELETE to confirm' }, { status: 400 })
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null

  const db = admin()
  const { data: profile } = await db.from('profiles').select('transaction_pin_hash').eq('id', user.id).single()

  // Same PIN check as every money action, so a borrowed unlocked phone can't delete the account.
  if (profile?.transaction_pin_hash) {
    const pin = String(body.pin || '')
    if (!/^\d{4}$/.test(pin)) return NextResponse.json({ error: 'Enter your 4-digit PIN' }, { status: 400 })
    const lock = await pinLockGuard(user.id)
    if (lock.locked) return NextResponse.json({ error: lock.message }, { status: 429 })
    const { ok } = verifyPin(pin, profile.transaction_pin_hash)
    const attempt = await recordPinResult(user.id, ok)
    if (!ok) return NextResponse.json({ error: attempt.message || 'Incorrect PIN' }, { status: attempt.justLocked ? 429 : 401 })
  }

  const { error } = await db.rpc('delete_account', { p_user_id: user.id, p_reason: reason })
  if (error) {
    if (/account not empty/i.test(error.message)) {
      const { data: blockers } = await db.rpc('account_deletion_blockers', { p_user_id: user.id })
      return NextResponse.json({ error: 'Please close these first', blockers: blockers || [] }, { status: 409 })
    }
    console.error('[account-delete]', error.message)
    return NextResponse.json({ error: 'Could not delete your account. Please contact support.' }, { status: 500 })
  }

  const { error: authError } = await db.auth.admin.updateUserById(user.id, {
    email: `deleted-${user.id}@deleted.pawasave.xyz`,
    email_confirm: true,
    ban_duration: '876000h',
    user_metadata: {},
  })
  if (authError) {
    // The profile is already anonymised; a retry of this call completes the login retirement.
    console.error('[account-delete] auth', authError.message)
    return NextResponse.json({ error: 'Your data was removed but signing out failed. Please try again or contact support.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
