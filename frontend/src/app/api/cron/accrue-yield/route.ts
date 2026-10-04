import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/accrue-yield
 *
 * Called once per day by the host crontab (see ops/cron/crontab).
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

  // A pool failure must not stop the savings accruals below (it used to return here, which
  // would have skipped every goal/circle/co-op credit for the night).
  if (error) console.error('accrue_daily_yield error:', error)
  else console.log('Yield accrual result:', data)

  // Goals: one day of interest on each active goal's actual balance, only while savings are
  // backed by gNTB (migration 115). Idempotent per day. A failure here must not hide the
  // pool result above, so it is reported separately.
  // Circles (migration 115) and cooperative funds (116) accrue the same way, each into its own
  // pot/fund, with our spread booked the same day.
  const savings: Record<string, unknown> = {}
  for (const [key, fn] of [['goals', 'accrue_goal_interest'], ['circles', 'accrue_circle_interest'], ['coops', 'accrue_coop_interest']] as const) {
    const { data: r, error: e } = await supabase.rpc(fn)
    if (e) console.error(`${fn} error:`, e)
    else console.log(`${fn}:`, r)
    savings[key] = e ? { error: e.message } : r
  }

  const failed = !!error || Object.values(savings).some((v) => (v as { error?: string })?.error)
  return NextResponse.json({ ok: !failed, result: error ? { error: error.message } : data, ...savings }, { status: failed ? 500 : 200 })
}
