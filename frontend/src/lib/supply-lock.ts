/**
 * supply-lock.ts — a cross-process lease lock so only ONE code path supplies
 * custody cNGN into PawasaveLend at a time.
 *
 * Two crons (sweep-deposits, strails-reconcile) each read custody's idle balance
 * and call supply(idle). Run close together, both saw the same 4,915 cNGN and both
 * submitted supply(4,915) — the first mined, the second reverted "transfer amount
 * exceeds balance". Wrapping every custody→pool supply in this lock serialises them.
 *
 * Backed by migration 054 (try_acquire_lock / release_lock + system_locks). Fails
 * OPEN (returns true) when the RPC isn't available yet or errors, so behaviour is
 * unchanged until the migration is applied; fails CLOSED (false) only when another
 * run genuinely holds the lease.
 */
import { createClient } from '@supabase/supabase-js'

const KEY = 'custody_supply'
// Typed `any`: the generated SupabaseClient generics don't include these RPCs, and
// the rest of the codebase uses the service client loosely for the same reason.
let _client: any = null

function db() {
  if (_client) return _client
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  _client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  return _client
}

/** Claim the custody-supply lease. TTL auto-expires so a crashed run can't wedge it. */
export async function acquireSupplyLock(ttlSeconds = 180): Promise<boolean> {
  const c = db()
  if (!c) return true // no service role → behave as before (unguarded)
  const { data, error } = await c.rpc('try_acquire_lock', { p_key: KEY, p_ttl_seconds: ttlSeconds })
  if (error) return true // RPC missing (pre-migration) or transient → fail open
  return data === true
}

export async function releaseSupplyLock(): Promise<void> {
  const c = db()
  if (!c) return
  await c.rpc('release_lock', { p_key: KEY }).then(() => {}, () => {})
}