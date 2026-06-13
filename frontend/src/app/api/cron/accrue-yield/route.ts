import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/accrue-yield
 *
 * Called once per day by Vercel Cron (see vercel.json).
 * Accrues daily yield on all users' cngn_pool_micro balances.
 *
 * Protected by the CRON_SECRET env var — Vercel sends this automatically
 * in the Authorization header when invoking cron routes.
 */
export async function GET(request: NextRequest) {
  // Validate the Vercel cron secret
  const denied = checkCronAuth(request)
  if (denied) return denied

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const { data, error } = await supabase.rpc('accrue_daily_yield')

  if (error) {
    console.error('accrue_daily_yield error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log('Yield accrual result:', data)
  return NextResponse.json({ ok: true, result: data })
}
