import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { sendP2pRevertedEmail } from '@/lib/notify-tx'

/**
 * GET /api/cron/revert-p2p-claims
 *
 * Returns unclaimed peer-to-peer transfers to their senders once past expires_at. The refund
 * happens inside p2p_revert (guarded, idempotent), so a claim landing at the same moment as the
 * cron can only settle one way. Protected by CRON_SECRET; run a few times a day is plenty.
 */
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 60

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }
  try {
    const admin = serviceDb()
    const nowIso = new Date().toISOString()

    const { data: expired } = await admin
      .from('p2p_transfers')
      .select('id, sender_id, recipient_email, amount_micro, reference')
      .eq('status', 'pending')
      .lt('expires_at', nowIso)
      .limit(500)

    let reverted = 0
    for (const t of expired || []) {
      const { data: ok, error } = await admin.rpc('p2p_revert', { p_transfer_id: t.id, p_reason: 'expired' })
      if (error) { console.error('[revert-p2p-claims] rpc error', t.id, error.message); continue }
      if (ok === true) {
        reverted++
        sendP2pRevertedEmail(t.sender_id, {
          amountNgn: Number(t.amount_micro || 0) / 1_000_000,
          toLabel: t.recipient_email || 'recipient',
          reason: 'expired',
          reference: t.reference,
        }).catch(() => {})
      }
    }

    return NextResponse.json({ ok: true, reverted, scanned: (expired || []).length })
  } catch (e: unknown) {
    console.error('[revert-p2p-claims] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'error' }, { status: 500 })
  }
}
