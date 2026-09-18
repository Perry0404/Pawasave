import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/pawa/order/<reference>
 *
 * Resolve a payment order for the pay screen. A pending order (buyer_id still null) is surfaced by
 * its unguessable reference so a buyer opening the link can see what they're paying for; a settled
 * order's full details are only returned to the two parties. Requires a session (the app is
 * auth-gated) but a pending order is visible to any signed-in user who holds the link.
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

export async function GET(_request: NextRequest, { params }: { params: { reference: string } }) {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const reference = decodeURIComponent(params.reference || '')
  if (!reference) return NextResponse.json({ error: 'Missing reference' }, { status: 400 })

  const admin = serviceDb()
  const { data: order } = await admin
    .from('pawa_orders')
    .select('reference, seller_id, buyer_id, amount_micro, escrow, status, note, surface, auto_release_at, created_at')
    .eq('reference', reference)
    .maybeSingle()
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  const isParty = user.id === order.seller_id || user.id === order.buyer_id
  // A settled order is private to its parties; a still-open (pending) order is link-shareable.
  if (order.status !== 'pending' && !isParty) {
    return NextResponse.json({ error: 'This order is not available' }, { status: 403 })
  }

  const { data: seller } = await admin
    .from('profiles').select('tag, merchant_name, display_name').eq('id', order.seller_id).maybeSingle()

  return NextResponse.json({
    reference: order.reference,
    amountNgn: Number(order.amount_micro) / 1_000_000,
    escrow: Boolean(order.escrow),
    status: order.status,
    note: order.note || null,
    surface: order.surface,
    autoReleaseAt: order.auto_release_at || null,
    seller: {
      tag: seller?.tag || null,
      name: seller?.merchant_name || seller?.display_name || (seller?.tag ? `@${seller.tag}` : 'a seller'),
    },
    isSeller: user.id === order.seller_id,
    isBuyer: user.id === order.buyer_id,
  })
}
