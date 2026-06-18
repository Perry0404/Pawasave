import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'

/**
 * POST /api/admin/revenue-balance
 * Auth: admin session cookie (V2-HIGH-03) or password in the JSON body
 * (FIND-API-02 — never in the URL query).
 */
export async function POST(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD || ''

  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  if (!adminPassword || !isAuthorisedAdmin(request, body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'platform_revenue_kobo')
    .single()

  return NextResponse.json({ revenueKobo: Number(data?.value || 0) })
}