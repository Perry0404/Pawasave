import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { STRAILS_ENABLED, getUserDetails } from '@/lib/strails'

/**
 * GET /api/strails/onboard-status
 *
 * Completes onboarding by PULL, not by waiting on the `user.onboarded` webhook.
 * That webhook is not a guarantee — the deposit webhook 401'd on signature
 * verification three times in a row live (see strails-reconcile), and the onboard
 * one is delivered the same way. Without this, a user whose BVN submit SUCCEEDED
 * (Strails returns status 'processing') is stranded on "Creating your account…"
 * forever because the NUBAN never lands in our DB.
 *
 * This asks Strails directly for the user's virtual account and, once it exists,
 * back-fills it via set_strails_account (the same RPC the webhook uses). The
 * pending-account UI polls this; "Check again" calls it too.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(_request: NextRequest) {
  if (!STRAILS_ENABLED) {
    return NextResponse.json({ ready: false, status: 'unavailable' })
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('strails_user_id, strails_onboard_status, strails_va_account_number, strails_va_bank_name, strails_va_account_name')
    .eq('id', user.id)
    .single()

  const p = profile as any

  // Already have the account — nothing to do.
  if (p?.strails_va_account_number) {
    return NextResponse.json({
      ready: true,
      account: {
        accountNumber: p.strails_va_account_number,
        bankName: p.strails_va_bank_name,
        accountName: p.strails_va_account_name,
      },
    })
  }

  // Never started onboarding (no BVN submitted yet) → let the UI show the BVN form.
  if (!p?.strails_user_id) {
    return NextResponse.json({ ready: false, status: 'none' })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ready: false, status: 'processing' })
  }

  // Ask Strails directly for the permanent account. It arrives ~2 min after onboard.
  try {
    const details = await getUserDetails(String(p.strails_user_id))
    const acctNumber = details.account.accountNumber
    if (!acctNumber) {
      return NextResponse.json({ ready: false, status: 'processing' })
    }

    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )
    // Direct write, not the set_strails_account RPC — that function isn't in
    // PostgREST's schema cache, so RPC-based onboarding writes silently no-op.
    await admin
      .from('profiles')
      .update({
        strails_va_account_number: acctNumber,
        strails_va_account_name: details.account.accountName || null,
        strails_va_bank_name: details.account.bankName || null,
        strails_onboard_status: 'completed',
        strails_onboarded_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    return NextResponse.json({
      ready: true,
      account: {
        accountNumber: acctNumber,
        bankName: details.account.bankName || null,
        accountName: details.account.accountName || null,
      },
    })
  } catch (e) {
    // Not ready yet (or a transient Strails error) — keep the UI on "processing".
    console.warn('[strails/onboard-status] getUserDetails:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ready: false, status: 'processing' })
  }
}