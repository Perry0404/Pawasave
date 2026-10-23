import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { verifyPin } from '@/lib/pin-hash'
import { pinLockGuard, recordPinResult } from '@/lib/pin-lockout'
import { complianceBlock } from '@/lib/compliance'

/**
 * /api/savings/fixed — Fixed Savings v2 (migration 120).
 *
 *   GET                                           what is on offer: terms, saver rate, backing asset
 *   POST { amountMicro, durationDays, consent, pin }   open a lock
 *
 * A v2 lock cannot be withdrawn early and pays itself out at maturity
 * (/api/cron/fixed-savings-mature). The rate, terms and the rule that the rate never exceeds
 * what the backing asset earns all live in lock_savings_v2; this route is the authenticated,
 * PIN-checked front door to it.
 */
export const dynamic = 'force-dynamic'

const KEYS = [
  'fixed_v2_enabled', 'fixed_v2_user_apy_percent', 'fixed_v2_terms_days', 'fixed_v2_min_amount_micro',
  'fixed_v2_backing_name', 'fixed_v2_backing_apy_percent', 'fixed_v2_min_spread_percent',
]

function serviceDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function sessionUser() {
  const store = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

async function offer() {
  const { data } = await serviceDb().from('platform_settings').select('key, value').in('key', KEYS)
  const s = Object.fromEntries((data || []).map((r: any) => [r.key, r.value as string]))
  const rate = parseFloat(s.fixed_v2_user_apy_percent || '0') || 0
  const backing = parseFloat(s.fixed_v2_backing_apy_percent || '0') || 0
  const spread = parseFloat(s.fixed_v2_min_spread_percent || '1.5') || 0
  const terms = String(s.fixed_v2_terms_days || '').split(',').map((t) => parseInt(t.trim(), 10)).filter((t) => t > 0)
  return {
    // Open only when switched on AND the backing asset currently earns enough to pay the rate.
    open: s.fixed_v2_enabled === 'true' && rate > 0 && rate <= backing - spread,
    enabled: s.fixed_v2_enabled === 'true',
    ratePercent: rate,
    terms: terms.map((days) => ({ days, payoutDate: new Date(Date.now() + days * 86_400_000).toISOString() })),
    minAmountMicro: Number(s.fixed_v2_min_amount_micro || 1_000_000_000),
    backingName: s.fixed_v2_backing_name || 'GetEquity',
  }
}

export async function GET() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  return NextResponse.json(await offer())
}

export async function POST(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const held = await complianceBlock(user.id, 'invest')
  if (held) return held

  const body = await request.json().catch(() => ({}))
  const amountMicro = Math.floor(Number(body?.amountMicro))
  const durationDays = Math.floor(Number(body?.durationDays))
  if (!(amountMicro > 0) || !(durationDays > 0)) return NextResponse.json({ error: 'Enter an amount and a term' }, { status: 400 })
  if (body?.consent !== true) {
    return NextResponse.json({ error: 'Please confirm you understand this savings cannot be withdrawn before it matures' }, { status: 400 })
  }

  const admin = serviceDb()
  const pin = String(body?.pin ?? '')
  if (!/^\d{4}$/.test(pin)) return NextResponse.json({ error: 'Enter your 4-digit transaction PIN' }, { status: 400 })
  const { data: profile } = await admin.from('profiles').select('transaction_pin_hash').eq('id', user.id).maybeSingle()
  if (!profile?.transaction_pin_hash) return NextResponse.json({ error: 'Set your transaction PIN in Settings first' }, { status: 400 })
  const lock = await pinLockGuard(user.id)
  if (lock.locked) return NextResponse.json({ error: lock.message }, { status: 429 })
  const { ok } = verifyPin(pin, profile.transaction_pin_hash)
  const attempt = await recordPinResult(user.id, ok)
  if (!ok) return NextResponse.json({ error: attempt.message || 'Incorrect transaction PIN' }, { status: attempt.justLocked ? 429 : 401 })

  const { data: lockId, error } = await admin.rpc('lock_savings_v2', {
    p_user_id: user.id, p_amount_micro: amountMicro, p_duration_days: durationDays, p_consent: true,
  })
  if (error) {
    const msg = error.message.replace(/^lock_savings_v2:\s*/, '')
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const { data: row } = await admin.from('savings_locks')
    .select('id, amount_usdc_micro, projected_interest_micro, apy_percent, unlocks_at').eq('id', lockId).maybeSingle()
  return NextResponse.json({ ok: true, lock: row })
}
