import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aa = enc.encode(a)
  const bb = enc.encode(b)
  if (aa.byteLength !== bb.byteLength) return false
  return crypto.timingSafeEqual(aa, bb)
}

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

  if (!body.password || !timingSafeEqual(body.password, ADMIN_PASSWORD)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const recentFeeLimit = Math.min(Math.max(body.recentFeeLimit ?? 30, 1), 200)

  const [{ data: fees, error: feesError }, { data: users, error: usersError }, { data: volume, error: volumeError }, { data: recentFees, error: recentFeesError }, { data: revenueSetting, error: revenueError }] = await Promise.all([
    supabase.rpc('admin_fee_summary'),
    supabase.rpc('admin_user_stats'),
    supabase.rpc('admin_tx_volume'),
    supabase.rpc('admin_recent_fees', { p_limit: recentFeeLimit }),
    supabase.from('platform_settings').select('value').eq('key', 'platform_revenue_kobo').single(),
  ])

  const error = feesError || usersError || volumeError || recentFeesError || revenueError
  if (error) {
    return NextResponse.json({
      error: error.message || 'Failed to load admin dashboard',
      detail: { feesError: feesError?.message, usersError: usersError?.message, volumeError: volumeError?.message, recentFeesError: recentFeesError?.message, revenueError: revenueError?.message },
    }, { status: 500 })
  }

  return NextResponse.json({
    fees: fees?.[0] ?? null,
    users: users?.[0] ?? null,
    volume: volume?.[0] ?? null,
    recentFees: recentFees ?? [],
    revenueKobo: Number(revenueSetting?.value || 0),
  })
}
