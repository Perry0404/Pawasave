import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { STRAILS_ENABLED, onboardUser, StrailsError } from '@/lib/strails'

/**
 * POST /api/strails/onboard  { bvn: "12345678901" }
 *
 * Starts Strails BVN onboarding for the signed-in, KYC-verified user so they get a
 * permanent Naira virtual account. Requires Sense liveness KYC already passed — the
 * BVN adds government-identity matching on top. The raw BVN is sent to Strails and
 * never stored; we keep only a salted hash. The permanent account arrives async via
 * the `user.onboarded` webhook.
 */
export const maxDuration = 30

export async function POST(request: NextRequest) {
  if (!STRAILS_ENABLED) {
    return NextResponse.json({ error: 'Naira accounts are not available yet' }, { status: 503 })
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { bvn } = await request.json().catch(() => ({}))
  if (!/^\d{11}$/.test(String(bvn || ''))) {
    return NextResponse.json({ error: 'A valid 11-digit BVN is required' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('kyc_status, kyc_first_name, kyc_last_name, phone, strails_onboard_status, strails_va_account_number')
    .eq('id', user.id)
    .single()

  if (profile?.kyc_status !== 'verified') {
    return NextResponse.json({ error: 'Complete identity verification first' }, { status: 403 })
  }
  if (profile?.strails_va_account_number) {
    return NextResponse.json({ ok: true, alreadyOnboarded: true })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const bvnHash = crypto
    .createHash('sha256')
    .update(String(bvn) + (process.env.BVN_HASH_SALT || ''))
    .digest('hex')

  try {
    const result = await onboardUser({
      bvn: String(bvn),
      userId: user.id, // echoed back on webhooks so we can map the account
      email: user.email || undefined,
      phoneNumber: (profile as any)?.phone || undefined,
      firstName: (profile as any)?.kyc_first_name || undefined,
      lastName: (profile as any)?.kyc_last_name || undefined,
    })

    // Store Strails' OWN identity (userHash) — it does not adopt our uuid, and every
    // later lookup and webhook keys off this value.
    await admin.rpc('set_strails_onboarding', {
      p_user_id: user.id,
      p_request_id: result.requestId || null,
      p_strails_uid: result.userHash || null,
      p_status: 'processing',
      p_bvn_hash: bvnHash,
    })

    return NextResponse.json({ ok: true, status: 'processing', requestId: result.requestId })
  } catch (e) {
    const msg = e instanceof StrailsError ? e.message : 'Onboarding failed, please try again'
    console.error('[strails/onboard] failed:', e instanceof Error ? e.message : e)
    try {
      await admin.rpc('set_strails_onboarding', {
        p_user_id: user.id, p_request_id: null, p_strails_uid: null, p_status: 'failed', p_bvn_hash: bvnHash,
      })
    } catch { /* best-effort status write */ }
    // BVN validation failures are actionable; surface them.
    return NextResponse.json({ error: msg }, { status: 422 })
  }
}