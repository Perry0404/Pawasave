import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'
import { readYieldSources, blendYield, splitYield } from '@/lib/yield/aggregator'

/**
 * POST /api/admin/yield
 * Admin-only. Returns the current yield picture: live per-source APY, the blended
 * realised rate, and the user/platform split — computed fresh so you can decide
 * allocations and the user share before the cron persists them.
 * Auth: admin session cookie or password in the JSON body.
 */
export async function POST(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD || ''
  let body: { password?: string } = {}
  try { body = await request.json() } catch { /* no body */ }

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

  const { data: rows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['yield_allocations', 'yield_user_share_percent', 'yield_user_cap_percent', 'yield_bootstrap_apy_percent'])
  const settings = Object.fromEntries((rows || []).map((r: any) => [r.key, r.value]))

  let allocations: Record<string, number> = { pawasave_lend: 100 }
  try { const p = JSON.parse(settings.yield_allocations || '{}'); if (p && typeof p === 'object') allocations = p } catch {}

  const userSharePercent = Number(settings.yield_user_share_percent ?? 70)
  const userCapPercent = Number(settings.yield_user_cap_percent ?? 33)
  const bootstrapApy = Number(settings.yield_bootstrap_apy_percent ?? 0)

  const sources = await readYieldSources()
  const blend = blendYield(sources, allocations)
  const realized = Math.max(blend.realizedApyPercent, Number.isFinite(bootstrapApy) ? bootstrapApy : 0)
  const split = splitYield(realized, { userSharePercent, userCapPercent })

  return NextResponse.json({
    sources,
    allocations,
    blend,
    policy: { userSharePercent, userCapPercent, bootstrapApyPercent: bootstrapApy },
    realizedApyPercent: realized,
    userApyPercent: split.userApyPercent,
    platformApyPercent: split.platformApyPercent,
  })
}