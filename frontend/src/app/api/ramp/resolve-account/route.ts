import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { lookupFlipeetAccount, FlipeetApiError } from '@/lib/flipeet'
import { STRAILS_ENABLED, resolveStrailsAccountName } from '@/lib/strails'

/**
 * GET /api/ramp/resolve-account?bank=<code>&account=<10 digits>
 *
 * Name enquiry (like a normal Nigerian bank transfer): resolves the account
 * holder name for a bank code + account number so the withdraw screen can show
 * it automatically. Uses Flipeet's own lookup — the SAME provider and bank codes
 * used for the actual payout, so no extra API key is needed (FLIPEET_API_KEY).
 *
 * Auth-gated (logged-in users only) to prevent account-name harvesting, and the
 * middleware already rate-limits /api/ramp per IP. Returns { accountName } on
 * success, or a non-200 with { error } so the client can fall back to manual entry.
 */
export async function GET(req: NextRequest) {
  const bank = (req.nextUrl.searchParams.get('bank') || '').trim()
  const bankName = (req.nextUrl.searchParams.get('name') || '').trim()
  const account = (req.nextUrl.searchParams.get('account') || '').replace(/\D/g, '')

  if (!bank || !/^\d{10}$/.test(account)) {
    return NextResponse.json({ error: 'Enter a 10-digit account number and select a bank.' }, { status: 400 })
  }

  // Require an authenticated session.
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Try Flipeet first (same provider/codes as its payout). If it's a 4xx the details are
  // genuinely wrong; if it's an outage (like Flipeet being down), fall back to Strails.
  let flipeetUserError = false
  try {
    const data = await lookupFlipeetAccount({ bankCode: bank, accountNumber: account })
    const name = data?.account_name
    if (name) return NextResponse.json({ accountName: String(name), source: 'flipeet' })
  } catch (e) {
    flipeetUserError = e instanceof FlipeetApiError && e.status >= 400 && e.status < 500
  }

  // Strails name-enquiry fallback (works while Flipeet is down). Needs the bank NAME to map the
  // app's 3-digit code to Strails' NIBSS code.
  if (STRAILS_ENABLED && bankName) {
    const strailsName = await resolveStrailsAccountName(account, bankName, bank).catch(() => null)
    if (strailsName) return NextResponse.json({ accountName: strailsName, source: 'strails' })
  }

  // A definite Flipeet 4xx means the details are wrong (user-fixable); otherwise it's an outage.
  return NextResponse.json(
    { error: flipeetUserError ? 'We couldn’t find that account. Check the number and bank.' : 'Account lookup is temporarily unavailable.' },
    { status: flipeetUserError ? 422 : 502 },
  )
}