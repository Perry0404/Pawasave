import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sendPawaReleasedEmail } from '@/lib/notify-tx'

/**
 * POST /api/pawa/release-by-ref  { reference, action: 'release'|'dispute' }
 *
 * The buyer-facing /pay/<reference> page only holds the order's reference (never its numeric id), so
 * this resolves the order by reference and runs the buyer's escrow action. Buyer-only; the money
 * move + guard live in the RPC. Seller-side actions (refund/cancel) go through /api/pawa/action.
 */
export const dynamic = 'force-dynamic'

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

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const reference = String(body?.reference || '')
    const action = String(body?.action || '')
    if (!reference) return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
    if (!['release', 'dispute'].includes(action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })

    const admin = serviceDb()
    const { data: order } = await admin
      .from('pawa_orders')
      .select('id, reference, seller_id, buyer_id, amount_micro')
      .eq('reference', reference).maybeSingle()
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    if (user.id !== order.buyer_id) return NextResponse.json({ error: 'Only the buyer can do that' }, { status: 403 })

    if (action === 'release') {
      const { data: ok, error } = await admin.rpc('pawa_release', { p_order_id: order.id, p_actor: user.id })
      if (error || ok === false) return NextResponse.json({ error: 'Could not release — order may already be settled' }, { status: 409 })
      const { data: buyer } = await admin.from('profiles').select('display_name, tag').eq('id', order.buyer_id!).maybeSingle()
      sendPawaReleasedEmail(order.seller_id, {
        amountNgn: Number(order.amount_micro) / 1_000_000,
        counterparty: buyer?.display_name || (buyer?.tag ? `@${buyer.tag}` : 'the buyer'),
        escrow: true, reference: order.reference, auto: false,
      }).catch(() => {})
      return NextResponse.json({ ok: true, status: 'released' })
    }

    const { data: ok, error } = await admin.rpc('pawa_dispute', { p_order_id: order.id, p_buyer: user.id })
    if (error || ok === false) return NextResponse.json({ error: 'Could not dispute — order may already be settled' }, { status: 409 })
    return NextResponse.json({ ok: true, status: 'disputed' })
  } catch (e: unknown) {
    console.error('[pawa/release-by-ref] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
