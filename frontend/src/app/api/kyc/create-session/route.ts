import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { isSenseConfigured, createSenseSession, senseEnvironment } from '@/lib/kyc-sense'

/**
 * POST /api/kyc/create-session
 * Records the user's identity details (BVN/NIN hashed, name, DOB) as a pending
 * submission and opens a Sense biometric session. Returns the session creds the
 * client SDK needs to capture liveness. The final verified/rejected decision
 * arrives asynchronously on /api/kyc/webhook — this route never verifies.
 */
export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const firstName = String(body.firstName || '').trim()
  const lastName = String(body.lastName || '').trim()
  const dob = String(body.dob || '').trim() // YYYY-MM-DD
  const kycType = body.kycType === 'nin' ? 'nin' : 'bvn'
  const idNumber = String(body.idNumber || '').replace(/\D/g, '')

  if (firstName.length < 2 || lastName.length < 2) {
    return NextResponse.json({ error: 'Enter your first and last name as on your ID' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return NextResponse.json({ error: 'Enter your date of birth' }, { status: 400 })
  }
  if (idNumber.length !== 11) {
    return NextResponse.json({ error: `${kycType.toUpperCase()} must be 11 digits` }, { status: 400 })
  }

  if (!isSenseConfigured()) {
    return NextResponse.json(
      { error: 'Identity verification is not available yet. Please try again shortly.' },
      { status: 503 },
    )
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Verification service not configured' }, { status: 503 })
  }

  // Never store the raw BVN/NIN — keep only a salted-less SHA-256 for later match.
  const idHash = crypto.createHash('sha256').update(idNumber).digest('hex')

  // Open the Sense biometric session (server-side, with the secret API key).
  let session
  try {
    session = await createSenseSession({
      externalUserId: user.id,
      sessionType: 'enrollment',
      metadata: { kyc_type: kycType },
    })
  } catch (e: any) {
    console.error('[kyc] Sense create-session failed:', e?.message || e)
    return NextResponse.json({ error: 'Could not start verification. Please try again.' }, { status: 502 })
  }

  // Record the pending submission (service role bypasses RLS). Status stays
  // 'submitted' until the Sense webhook delivers APPROVE/REJECT.
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  await admin.from('profiles').update({
    kyc_status: 'submitted',
    kyc_type: kycType,
    kyc_id_hash: idHash,
    kyc_first_name: firstName,
    kyc_last_name: lastName,
    kyc_dob: dob,
    kyc_provider: 'sense',
    kyc_session_id: session.session_id,
    kyc_submitted_at: new Date().toISOString(),
  }).eq('id', user.id)

  return NextResponse.json({
    sessionData: {
      session_id: session.session_id,
      session_token: session.session_token,
      nonce: session.nonce,
      expires_at: session.expires_at,
      policy: session.policy,
      upload: session.upload,
      geometric_coherence: session.geometric_coherence ?? null,
    },
    environment: senseEnvironment(),
  })
}