import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { readYieldSources, blendYield, splitYield } from '@/lib/yield/aggregator'

/**
 * GET /api/cron/update-yield-apy
 *
 * Reads a live/quoted APY from every yield source, blends them by real
 * allocation, applies the user/platform split, and writes the result so
 * accrue_daily_yield credits users the honest rate (and books the spread as
 * platform revenue). Runs a few times a day (see vercel.json).
 */
export async function GET(request: NextRequest) {
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

  // Policy inputs from platform_settings.
  const { data: rows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['yield_allocations', 'yield_user_share_percent', 'yield_user_cap_percent', 'yield_bootstrap_apy_percent'])
  const settings = Object.fromEntries((rows || []).map((r: any) => [r.key, r.value]))

  let allocations: Record<string, number> = { pawasave_lend: 100 }
  try {
    const parsed = JSON.parse(settings.yield_allocations || '{}')
    if (parsed && typeof parsed === 'object') allocations = parsed
  } catch { /* keep default */ }

  const userSharePercent = Number(settings.yield_user_share_percent ?? 70)
  const userCapPercent = Number(settings.yield_user_cap_percent ?? 33)
  const bootstrapApy = Number(settings.yield_bootstrap_apy_percent ?? 0)

  // Read every source and blend by actual allocation.
  const sources = await readYieldSources()
  const blend = blendYield(sources, allocations)

  // A conscious subsidy floor: never credit below the bootstrap APY if one is set.
  const realized = Math.max(blend.realizedApyPercent, Number.isFinite(bootstrapApy) ? bootstrapApy : 0)
  const split = splitYield(realized, { userSharePercent, userCapPercent })

  const snapshot = {
    updatedAt: new Date().toISOString(),
    sources,
    allocations,
    realizedApyPercent: realized,
    potentialApyPercent: blend.potentialApyPercent,
    allocatedPercent: blend.allocatedPercent,
    bootstrapApyPercent: bootstrapApy,
    userApyPercent: split.userApyPercent,
    platformApyPercent: split.platformApyPercent,
    userSharePercent: split.userSharePercent,
  }

  const { error } = await supabase.rpc('set_yield_state', {
    p_market_apy: realized,
    p_user_apy: split.userApyPercent,
    p_snapshot: snapshot,
  })
  if (error) {
    console.error('[yield-cron] set_yield_state failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  console.info('[yield-cron]', JSON.stringify({ realized, user: split.userApyPercent, platform: split.platformApyPercent }))
  return NextResponse.json({ ok: true, snapshot })
}