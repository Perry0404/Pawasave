import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import { getNgxStocks, NGX_ENABLED } from '@/lib/ngx'

/**
 * GET /api/invest/ngx — NGX market data for the Invest tab's browse list.
 * Session-gated (so our free-tier NGN Market quota isn't exposed to the open internet) and served
 * from the shared server-side cache in lib/ngx.ts. Market info only — no trading.
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

async function sessionUser() {
  const store = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET() {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { stocks, asOf } = await getNgxStocks(60)
  return NextResponse.json({ enabled: NGX_ENABLED, asOf, stocks })
}
