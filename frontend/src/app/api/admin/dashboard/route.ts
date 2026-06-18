import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })
  }

  let body: { password?: string; recentFeeLimit?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!isAuthorisedAdmin(request, body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const recentFeeLimit = Math.min(Math.max(body.recentFeeLimit ?? 30, 1), 200)

  // Run all RPCs independently — partial failures don't kill the dashboard
  // Wrap in Promise.resolve() so .catch() is available (supabase returns PromiseLike)
  const [feesRes, usersRes, volumeRes, recentFeesRes, revenueRes] = await Promise.all([
    Promise.resolve(supabase.rpc('admin_fee_summary')).catch(() => ({ data: null, error: null })),
    Promise.resolve(supabase.rpc('admin_user_stats')).catch(() => ({ data: null, error: null })),
    Promise.resolve(supabase.rpc('admin_tx_volume')).catch(() => ({ data: null, error: null })),
    Promise.resolve(supabase.rpc('admin_recent_fees', { p_limit: recentFeeLimit })).catch(() => ({ data: null, error: null })),
    Promise.resolve(supabase.from('platform_settings').select('value').eq('key', 'platform_revenue_kobo').maybeSingle()).catch(() => ({ data: null, error: null })),
  ])

  return NextResponse.json({
    fees: (feesRes.data as any)?.[0] ?? null,
    users: (usersRes.data as any)?.[0] ?? null,
    volume: (volumeRes.data as any)?.[0] ?? null,
    recentFees: (recentFeesRes.data as any) ?? [],
    revenueKobo: Number((revenueRes.data as any)?.value || 0),
  })
}
