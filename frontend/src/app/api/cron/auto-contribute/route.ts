import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * GET /api/cron/auto-contribute
 *
 * Called once per day by Vercel Cron (see vercel.json).
 * Processes all active savings goals due for their next scheduled contribution.
 *
 * Goals are processed in order of frequency:
 *   daily   → due every ~24h
 *   weekly  → due every ~7 days
 *   monthly → due every ~30 days
 *
 * Goals with insufficient wallet balance are skipped silently.
 * Protected by CRON_SECRET env var.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const { data, error } = await supabase.rpc('auto_contribute_goals')

  if (error) {
    console.error('auto_contribute_goals error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.log('Auto-contribute result:', data)
  return NextResponse.json({ ok: true, result: data })
}
