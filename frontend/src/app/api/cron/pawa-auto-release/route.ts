import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { sendPawaReleasedEmail } from '@/lib/notify-tx'

/**
 * GET /api/cron/pawa-auto-release
 *
 * Releases escrowed Pay with Pawa orders to the seller once past auto_release_at, IF the buyer
 * neither confirmed nor disputed (status is still 'paid'). A dispute flips status to 'disputed',
 * which this query excludes, so a disputed order never auto-releases. The credit happens inside
 * pawa_release (guarded, idempotent), so a buyer confirming at the same moment can't double-pay.
 * Protected by CRON_SECRET.
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

    const { data: due } = await admin
      .from('pawa_orders')
      .select('id, reference, seller_id, buyer_id, amount_micro')
      .eq('status', 'paid')
      .lt('auto_release_at', nowIso)
      .limit(500)

    let released = 0
    for (const o of due || []) {
      const { data: ok, error } = await admin.rpc('pawa_release', { p_order_id: o.id, p_actor: null })
      if (error) { console.error('[pawa-auto-release] rpc error', o.id, error.message); continue }
      if (ok === true) {
        released++
        const { data: buyer } = await admin.from('profiles').select('display_name, tag').eq('id', o.buyer_id!).maybeSingle()
        sendPawaReleasedEmail(o.seller_id, {
          amountNgn: Number(o.amount_micro || 0) / 1_000_000,
          counterparty: buyer?.display_name || (buyer?.tag ? `@${buyer.tag}` : 'the buyer'),
          escrow: true, reference: o.reference, auto: true,
        }).catch(() => {})
      }
    }

    return NextResponse.json({ ok: true, released, scanned: (due || []).length })
  } catch (e: unknown) {
    console.error('[pawa-auto-release] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'error' }, { status: 500 })
  }
}
