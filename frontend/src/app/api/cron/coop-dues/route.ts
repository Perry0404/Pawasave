import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/coop-dues   (hourly, see ops/cron/crontab)
 *
 * Cooperative societies (migration 116): expires stale payout proposals, raises each society's
 * dues when a new period starts, and auto-pays them for members who have auto-pay on (from
 * their spendable balance; anyone short simply stays owing and can pay later).
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
  const { data, error } = await supabase.rpc('coop_run_dues')
  if (error) {
    console.error('coop_run_dues error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  console.log('coop_run_dues:', data)
  return NextResponse.json(data)
}
