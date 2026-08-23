import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import { lookupFlipeetAccount, FlipeetApiError } from '@/lib/flipeet'

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

  try {
    const data = await lookupFlipeetAccount({ bankCode: bank, accountNumber: account })
    const name = data?.account_name
    if (name) return NextResponse.json({ accountName: String(name) })
    return NextResponse.json(
      { error: 'We couldn’t find that account. Check the number and bank.' },
      { status: 422 },
    )
  } catch (e) {
    // A 4xx from Flipeet means the account/bank couldn't be resolved (user-fixable);
    // anything else is a provider/outage error the user can't do anything about.
    const status = e instanceof FlipeetApiError && e.status >= 400 && e.status < 500 ? 422 : 502
    return NextResponse.json(
      {
        error: status === 422
          ? 'We couldn’t find that account. Check the number and bank.'
          : 'Account lookup is temporarily unavailable.',
      },
      { status },
    )
  }
}