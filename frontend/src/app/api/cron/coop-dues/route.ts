import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/coop-dues   (hourly, see ops/cron/crontab)
 *
 * The hourly auto-debits:
 *   • Cooperative societies (migration 116): expires stale payout proposals, raises each
 *     society's dues when a new period starts, and auto-pays them for members who have
 *     auto-pay on (spendable balance; anyone short stays owing and can pay later).
 *   • Ajo (migration 117): pays the contribution of every auto-debit member whose cycle is
 *     due, through esusu_contribute, then runs the payout.
 * Goals auto-save in the daily auto-contribute job. Each part is reported separately so one
 * failing doesn't hide the other.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const out: Record<string, unknown> = {}
  let failed = false
  for (const [key, fn] of [['coops', 'coop_run_dues'], ['ajo', 'esusu_auto_contribute']] as const) {
    const { data, error } = await supabase.rpc(fn)
    if (error) { failed = true; console.error(`${fn} error:`, error) } else console.log(`${fn}:`, data)
    out[key] = error ? { error: error.message } : data
  }
  return NextResponse.json({ ok: !failed, ...out }, { status: failed ? 500 : 200 })
}
