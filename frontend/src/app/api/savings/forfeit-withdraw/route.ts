import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/savings/forfeit-withdraw
 *   { kind: 'lock',  lockId, early }   break or mature a fixed savings lock
 *   { kind: 'goal',  goalId }          break a savings goal early
 *
 * Early exit forfeits accrued interest. This used to run in the browser: the client read the
 * lock, worked out the forfeiture itself, called record_lock_forfeiture with whatever number
 * it liked, then called withdraw_lock. Two problems with that. The amount was the client's to
 * choose, and the withdrawal was a separate call, so skipping the forfeiture entirely meant
 * simply not making the first one.
 *
 * Both legs now happen here, in order, with the forfeiture derived from the stored row. The
 * matching grants are revoked so the browser cannot reach either function directly.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const EARLY_EXIT_PENALTY_PERCENT = 50 // share of accrued interest given up on an early exit
const DAY_MS = 86_400_000

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
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

/** Interest given up by exiting now, from the row's own figures. */
function forfeitedMicro(principalMicro: number, ratePercent: number, startedAt: string): number {
  const daysHeld = Math.floor((Date.now() - new Date(startedAt).getTime()) / DAY_MS)
  if (!(daysHeld > 0) || !(principalMicro > 0) || !(ratePercent > 0)) return 0
  return Math.floor((principalMicro * ratePercent * daysHeld) / (100 * 365))
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const kind = body?.kind

    const admin = serviceDb()

    if (kind === 'lock') {
      const lockId = String(body?.lockId ?? '')
      const early = body?.early === true
      if (!lockId) return NextResponse.json({ error: 'lockId required' }, { status: 400 })

      // Scoped to this user, so one customer cannot act on another's lock even though the
      // service role bypasses RLS.
      const { data: lock } = await admin
        .from('savings_locks')
        .select('id, user_id, amount_usdc_micro, effective_rate_at_creation, created_at, status')
        .eq('id', lockId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (!lock) return NextResponse.json({ error: 'Lock not found' }, { status: 404 })
      if (lock.status !== 'active') {
        return NextResponse.json({ error: 'Lock is not active' }, { status: 409 })
      }

      let forfeited = 0
      if (early) {
        forfeited = forfeitedMicro(
          Number(lock.amount_usdc_micro || 0),
          Number(lock.effective_rate_at_creation || EARLY_EXIT_PENALTY_PERCENT),
          lock.created_at,
        )
        if (forfeited > 0) {
          const { error: fErr } = await admin.rpc('record_lock_forfeiture', {
            p_lock_id: lockId,
            p_user_id: user.id,
            p_forfeited_interest_usdc_micro: forfeited,
          })
          // Record before withdrawing. If the forfeiture cannot be written, do not withdraw,
          // otherwise the customer exits early and keeps interest they owed back.
          if (fErr) {
            console.error('[forfeit-withdraw] lock forfeiture failed, not withdrawing:', fErr.message)
            return NextResponse.json({ error: 'Could not record forfeiture' }, { status: 500 })
          }
        }
      }

      const { data: ok, error } = await admin.rpc('withdraw_lock', {
        p_user_id: user.id, p_lock_id: lockId, p_early: early,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      if (!ok) return NextResponse.json({ error: 'Lock not found or already withdrawn' }, { status: 409 })

      return NextResponse.json({ ok: true, forfeitedMicro: forfeited })
    }

    if (kind === 'goal') {
      const goalId = String(body?.goalId ?? '')
      if (!goalId) return NextResponse.json({ error: 'goalId required' }, { status: 400 })

      const { data: goal } = await admin
        .from('savings_goals')
        .select('id, user_id, saved_usdc_micro, started_at')
        .eq('id', goalId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (!goal) return NextResponse.json({ error: 'Goal not found' }, { status: 404 })

      const forfeited = forfeitedMicro(
        Number(goal.saved_usdc_micro || 0),
        EARLY_EXIT_PENALTY_PERCENT,
        goal.started_at,
      )
      if (forfeited > 0) {
        const { error: fErr } = await admin.rpc('record_goal_forfeiture', {
          p_goal_id: goalId,
          p_user_id: user.id,
          p_forfeited_interest_usdc_micro: forfeited,
        })
        if (fErr) {
          console.error('[forfeit-withdraw] goal forfeiture failed, not breaking:', fErr.message)
          return NextResponse.json({ error: 'Could not record forfeiture' }, { status: 500 })
        }
      }

      const { error } = await admin.rpc('break_savings_goal', { p_goal_id: goalId, p_user_id: user.id })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })

      return NextResponse.json({ ok: true, forfeitedMicro: forfeited })
    }

    return NextResponse.json({ error: "kind must be 'lock' or 'goal'" }, { status: 400 })
  } catch (e: unknown) {
    console.error('[forfeit-withdraw] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
