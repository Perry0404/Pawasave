/**
 * pin-lockout.ts — account-level brute-force protection for the transaction PIN.
 *
 * Wraps the SECURITY DEFINER RPCs from migration 049. Both run under the service
 * role (never the client) so a session can't reset its own failed-attempt counter.
 *
 * Usage in a PIN-verifying route:
 *   const lock = await pinLockGuard(userId)
 *   if (lock.locked) return NextResponse.json({ error: lock.message }, { status: 429 })
 *   const { ok } = verifyPin(pin, hash)
 *   const res = await recordPinResult(userId, ok)
 *   if (!ok) return NextResponse.json({ error: res.message }, { status: res.justLocked ? 429 : 401 })
 *
 * Fails OPEN when the service role isn't configured (dev) — lockout is a hardening
 * layer on top of the existing IP rate limit, never the sole gate.
 */
import { createClient } from '@supabase/supabase-js'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

function lockMessage(until?: string): string {
  const mins = until ? Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000)) : 15
  return `Too many incorrect PIN attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`
}

export async function pinLockGuard(userId: string): Promise<{ locked: boolean; message?: string }> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { locked: false }
  try {
    const { data } = await admin().rpc('pin_lock_status', { p_user_id: userId })
    if (data?.locked) return { locked: true, message: lockMessage(data.locked_until) }
  } catch { /* fail open */ }
  return { locked: false }
}

export async function recordPinResult(
  userId: string,
  ok: boolean,
): Promise<{ justLocked: boolean; remaining: number; message?: string }> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { justLocked: false, remaining: 5 }
  try {
    const { data } = await admin().rpc('record_pin_attempt', { p_user_id: userId, p_success: ok })
    if (data?.locked) return { justLocked: true, remaining: 0, message: lockMessage(data.locked_until) }
    const remaining = Number(data?.remaining ?? 0)
    return {
      justLocked: false,
      remaining,
      message: ok ? undefined : remaining > 0 ? `Incorrect PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} left.` : 'Incorrect transaction PIN',
    }
  } catch {
    return { justLocked: false, remaining: 0, message: ok ? undefined : 'Incorrect transaction PIN' }
  }
}