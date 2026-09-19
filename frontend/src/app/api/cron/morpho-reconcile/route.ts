import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { reconcileMorphoDraws } from '@/lib/morpho-treasury'

/**
 * GET /api/cron/morpho-reconcile — finishes Morpho-backed loan draws that parked
 * 'settling' (USDC borrowed but the USDC→cNGN auction had no solver) and unwinds
 * draws whose loan has since been repaid/liquidated. Protected by CRON_SECRET.
 * No-op unless MORPHO_ENABLED + HYPERFX_ENABLED (reconcileMorphoDraws self-guards).
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }
  try {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )
    const r = await reconcileMorphoDraws(admin)
    return NextResponse.json({ ok: true, ...r })
  } catch (e: unknown) {
    console.error('[morpho-reconcile] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'error' }, { status: 500 })
  }
}
