import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aa = enc.encode(a)
  const bb = enc.encode(b)
  if (aa.byteLength !== bb.byteLength) return false
  return crypto.timingSafeEqual(aa, bb)
}

/**
 * POST /api/admin/revenue-balance
 * Auth: admin password in the JSON body (FIND-API-02 — never in the URL query,
 * which would leak into server/CDN logs, browser history and Referer headers).
 */
export async function POST(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD || ''

  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!body.password || !adminPassword || !timingSafeEqual(body.password, adminPassword)) {
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