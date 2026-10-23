import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/cron/compliance-scan   (hourly, see ops/cron/crontab)
 *
 * Runs the transaction-monitoring rules (migration 119, compliance_scan). New flags appear on
 * the admin compliance desk; a high-severity flag holds the account's outflows until cleared.
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
  const { data, error } = await supabase.rpc('compliance_scan')
  if (error) {
    console.error('[compliance-scan]', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, opened: data })
}
