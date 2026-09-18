import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sendPawaReleasedEmail, sendPawaRefundEmail } from '@/lib/notify-tx'

/**
 * POST /api/pawa/action  { orderId, action, reason? }
 *
 * Escrow lifecycle actions on a Pay with Pawa order:
 *   • release  (buyer)  → confirm delivery, release escrow to the seller
 *   • dispute  (buyer)  → block auto-release pending resolution
 *   • refund   (seller) → return the escrowed funds to the buyer
 *   • cancel   (seller) → cancel an UNPAID payment link
 *
 * The money move + status guard live in the RPC (idempotent under FOR UPDATE); this route enforces
 * WHO may take each action and sends the receipt.
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

const label = (p: any) => p?.merchant_name || p?.display_name || (p?.tag ? `@${p.tag}` : 'the other party')

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const orderId = Number(body?.orderId)
    const action = String(body?.action || '')
    const reason = body?.reason ? String(body.reason).slice(0, 200) : null
    if (!Number.isFinite(orderId)) return NextResponse.json({ error: 'Missing orderId' }, { status: 400 })
    if (!['release', 'dispute', 'refund', 'cancel'].includes(action)) {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    const admin = serviceDb()
    const { data: order } = await admin
      .from('pawa_orders')
      .select('id, reference, seller_id, buyer_id, amount_micro, status, note')
      .eq('id', orderId).maybeSingle()
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

    const isBuyer = user.id === order.buyer_id
    const isSeller = user.id === order.seller_id
    const amountNgn = Number(order.amount_micro) / 1_000_000

    if (action === 'release') {
      if (!isBuyer) return NextResponse.json({ error: 'Only the buyer can release payment' }, { status: 403 })
      const { data: ok, error } = await admin.rpc('pawa_release', { p_order_id: order.id, p_actor: user.id })
      if (error || ok === false) return NextResponse.json({ error: 'Could not release — order may already be settled' }, { status: 409 })
      const { data: seller } = await admin.from('profiles').select('merchant_name, display_name, tag').eq('id', order.seller_id).maybeSingle()
      const { data: buyer } = await admin.from('profiles').select('display_name, tag').eq('id', order.buyer_id!).maybeSingle()
      sendPawaReleasedEmail(order.seller_id, { amountNgn, counterparty: label(buyer), escrow: true, reference: order.reference, auto: false }).catch(() => {})
      void seller
      return NextResponse.json({ ok: true, status: 'released' })
    }

    if (action === 'dispute') {
      if (!isBuyer) return NextResponse.json({ error: 'Only the buyer can dispute' }, { status: 403 })
      const { data: ok, error } = await admin.rpc('pawa_dispute', { p_order_id: order.id, p_buyer: user.id })
      if (error || ok === false) return NextResponse.json({ error: 'Could not dispute — order may already be settled' }, { status: 409 })
      return NextResponse.json({ ok: true, status: 'disputed' })
    }

    if (action === 'refund') {
      if (!isSeller) return NextResponse.json({ error: 'Only the seller can refund' }, { status: 403 })
      const { data: ok, error } = await admin.rpc('pawa_refund', { p_order_id: order.id, p_reason: reason || 'refunded' })
      if (error || ok === false) return NextResponse.json({ error: 'Could not refund — order may already be settled' }, { status: 409 })
      const { data: seller } = await admin.from('profiles').select('merchant_name, display_name, tag').eq('id', order.seller_id).maybeSingle()
      if (order.buyer_id) sendPawaRefundEmail(order.buyer_id, { amountNgn, counterparty: label(seller), escrow: true, note: order.note, reference: order.reference }).catch(() => {})
      return NextResponse.json({ ok: true, status: 'refunded' })
    }

    // cancel (unpaid link)
    if (!isSeller) return NextResponse.json({ error: 'Only the seller can cancel' }, { status: 403 })
    const { data: ok, error } = await admin.rpc('pawa_cancel', { p_order_id: order.id, p_actor: user.id })
    if (error || ok === false) return NextResponse.json({ error: 'Could not cancel — link may already be paid' }, { status: 409 })
    return NextResponse.json({ ok: true, status: 'cancelled' })
  } catch (e: unknown) {
    console.error('[pawa/action] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
