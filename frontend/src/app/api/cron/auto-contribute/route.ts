import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { supplyToLend } from '@/lib/custody'

/**
 * GET /api/cron/auto-contribute
 *
 * Called once per day by Vercel Cron (see vercel.json).
 * Processes all active savings goals due for their next scheduled contribution,
 * then drains the PawasaveLend supply retry queue (V2-MED-06).
 *
 * Goals are processed in order of frequency:
 *   daily   → due every ~24h
 *   weekly  → due every ~7 days
 *   monthly → due every ~30 days
 *
 * Goals with insufficient wallet balance are skipped silently.
 * Protected by CRON_SECRET env var.
 */

interface PendingSupply { id: number; user_id: string; cngn_micro: number; attempts: number }

/**
 * V2-MED-06: retry cNGN supplies that failed to reach PawasaveLend after a
 * deposit was credited. Each row is attempted once per run; success marks it
 * done + records the flexible-pool position, failure bumps the attempt counter.
 */
async function drainLendSupplyQueue(supabase: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('get_pending_lend_supplies', { p_limit: 20 })
  if (error) {
    console.error('get_pending_lend_supplies error:', error.message)
    return { error: error.message }
  }
  const rows = (data ?? []) as PendingSupply[]
  let supplied = 0
  let failed = 0

  for (const row of rows) {
    try {
      const { txHash, shares } = await supplyToLend(BigInt(row.cngn_micro))
      await supabase.rpc('mark_lend_supply_done', { p_id: row.id, p_tx: txHash })
      await supabase.from('flexible_pool_positions').upsert({
        user_id: row.user_id,
        cngn_deposited_micro: row.cngn_micro,
        last_supply_tx: txHash,
      }, { onConflict: 'user_id', ignoreDuplicates: false })
      supplied++
      console.info(`[auto-contribute] retried lend supply #${row.id} — tx: ${txHash}, shares: ${shares}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabase.rpc('mark_lend_supply_failed', { p_id: row.id, p_error: msg.slice(0, 500) })
      failed++
      console.warn(`[auto-contribute] lend supply retry #${row.id} failed:`, msg)
    }
  }

  return { scanned: rows.length, supplied, failed }
}

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

  const { data, error } = await supabase.rpc('auto_contribute_goals')

  if (error) {
    console.error('auto_contribute_goals error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort: a failure here must not fail the contribution cron.
  let lendSupplies: Record<string, unknown> = {}
  try {
    lendSupplies = await drainLendSupplyQueue(supabase)
  } catch (e: unknown) {
    lendSupplies = { error: e instanceof Error ? e.message : String(e) }
  }

  console.log('Auto-contribute result:', data, 'lend supplies:', lendSupplies)
  return NextResponse.json({ ok: true, result: data, lendSupplies })
}
