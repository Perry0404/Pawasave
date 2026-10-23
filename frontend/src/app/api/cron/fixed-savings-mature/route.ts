import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { sendLockMaturedEmail } from '@/lib/notify-tx'

/**
 * GET /api/cron/fixed-savings-mature   (hourly, see ops/cron/crontab)
 *
 * Pays out every Fixed Savings v2 lock that has reached its date (migration 120):
 * principal + the interest quoted at signup lands in the saver's spendable balance, and
 * the saver gets an email. The saver never has to do anything.
 *
 * mature_fixed_locks is idempotent (row lock + paid_out_at + unique ledger reference), so a
 * retry or an overlapping run never pays twice. The backing asset is sold down by
 * savings-gntb-sync on its next run, once these locks have left its target.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'no service key' }, { status: 503 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const { data, error } = await db.rpc('mature_fixed_locks', { p_limit: 200 })
  if (error) {
    if (/mature_fixed_locks|does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ ok: true, skipped: 'migration 120 not applied' })
    }
    console.error('[fixed-savings-mature]', error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const paid: { lock_id: string; user_id: string; principal_micro: number; payout_micro: number }[] = data?.paid ?? []
  await Promise.all(paid.map((p) =>
    sendLockMaturedEmail(p.user_id, { principalNgn: Number(p.principal_micro) / 1e6, payoutNgn: Number(p.payout_micro) / 1e6 })
      .catch((e) => console.error('[fixed-savings-mature] email', p.lock_id, e)),
  ))

  if (paid.length) console.info('[fixed-savings-mature]', { paid: paid.length, totalMicro: data?.total_micro })
  return NextResponse.json({ ok: true, paid: paid.map((p) => p.lock_id), totalMicro: data?.total_micro ?? 0 })
}
