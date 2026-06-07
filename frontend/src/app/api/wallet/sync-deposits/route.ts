import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { scanAndCredit } from '@/lib/deposit-scan'

/**
 * POST /api/wallet/sync-deposits
 * Quick recent-window scan for the signed-in user only. Lets the app credit a
 * fresh cNGN deposit on demand (e.g. when the user opens Home) without waiting
 * for the cron. Idempotent — safe to call repeatedly.
 */
export async function POST() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const { credited } = await scanAndCredit({ onlyUserId: user.id })
    return NextResponse.json({
      ok: true,
      credited: credited.length,
      deposits: credited.map(d => ({ txHash: d.txHash, amountCngnMicro: d.amountCngnMicro })),
    })
  } catch (e: any) {
    // Not configured yet, or RPC hiccup — don't surface as a hard error to the UI
    return NextResponse.json({ ok: false, credited: 0, error: e?.message || 'sync failed' })
  }
}
