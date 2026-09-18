import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { sendPawaSellerPaidEmail, sendPawaBuyerReceiptEmail } from '@/lib/notify-tx'

/**
 * POST /api/pawa/pay
 *
 * Two shapes, one endpoint (§3.6 Pay with Pawa):
 *   • { reference }                        → pay an EXISTING order opened from a link / QR / checkout
 *   • { to, amountNgn, note?, escrow? }    → a DIRECT pay to a seller by @tag (creates + pays)
 *
 * cNGN moves on the internal ledger only, inside SECURITY DEFINER RPCs under FOR UPDATE (escrow HELD
 * on the order row, or instant-settled to the seller). This route decides the shape, enforces the
 * buyer's identity/velocity policy, and sends receipts. Never trusts a client-supplied amount when
 * paying an existing order — the amount is read from the order the seller created.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MIN_NGN = Number(process.env.PAWA_MIN_NGN || 100)
const AUTO_RELEASE_DAYS = Number(process.env.PAWA_ESCROW_AUTO_RELEASE_DAYS || 3)
const DAY_MS = 86_400_000
const CAP_LITE_NGN = Number(process.env.PAWA_DAILY_CAP_LITE_NGN || 3_000_000)
const CAP_FULL_NGN = Number(process.env.PAWA_DAILY_CAP_FULL_NGN || 10_000_000)
const TAG_RE = /^[a-z0-9_]{3,20}$/

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

export async function POST(request: NextRequest) {
  try {
    const buyer = await sessionUser()
    if (!buyer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const reference = body?.reference ? String(body.reference) : null
    const admin = serviceDb()

    // Buyer identity gate: at least a lite (BVN) account — the pay box is never a KYC bypass.
    const { data: prof } = await admin
      .from('profiles').select('kyc_tier, display_name').eq('id', buyer.id).maybeSingle()
    if (String(prof?.kyc_tier || 'none') === 'none') {
      return NextResponse.json({ error: 'Verify your identity (BVN) before paying', code: 'kyc_required' }, { status: 403 })
    }
    const tier = String(prof?.kyc_tier || 'none')

    // Resolve the order (existing) or build a direct one.
    let sellerId: string
    let amountNgn: number
    let escrow: boolean
    let note: string | null
    let orderRef: string
    let existing = false

    if (reference) {
      const { data: order } = await admin
        .from('pawa_orders')
        .select('reference, seller_id, buyer_id, amount_micro, escrow, status, note')
        .eq('reference', reference)
        .maybeSingle()
      if (!order) return NextResponse.json({ error: 'Payment link not found' }, { status: 404 })
      if (order.status !== 'pending') return NextResponse.json({ error: 'This payment link is no longer open' }, { status: 409 })
      sellerId = String(order.seller_id)
      amountNgn = Number(order.amount_micro) / 1_000_000
      escrow = Boolean(order.escrow)
      note = order.note || null
      orderRef = String(order.reference)
      existing = true
    } else {
      const tag = String(body?.to ?? '').replace(/^@+/, '').toLowerCase()
      amountNgn = Number(body?.amountNgn)
      escrow = body?.escrow === undefined ? true : Boolean(body.escrow)
      note = body?.note ? String(body.note).slice(0, 200) : null
      if (!TAG_RE.test(tag)) return NextResponse.json({ error: 'Enter a valid seller @tag' }, { status: 400 })
      if (!(amountNgn >= MIN_NGN)) return NextResponse.json({ error: `Minimum is ₦${MIN_NGN.toLocaleString('en-NG')}` }, { status: 400 })
      const { data: seller } = await admin
        .from('profiles').select('id, merchant_enabled').eq('tag', tag).maybeSingle()
      if (!seller) return NextResponse.json({ error: `No PawaSave seller @${tag}` }, { status: 404 })
      sellerId = String(seller.id)
      orderRef = `pawa:${randomUUID()}`
    }

    if (sellerId === buyer.id) return NextResponse.json({ error: "You can't pay yourself" }, { status: 400 })

    const amountMicro = Math.round(amountNgn * 1_000_000)

    // Daily spend velocity guard (AML), by tier — sums pawa_pay + transfer_out in the last 24h.
    const since = new Date(Date.now() - DAY_MS).toISOString()
    const { data: recent } = await admin
      .from('transactions')
      .select('amount_usdc_micro')
      .eq('user_id', buyer.id)
      .in('type', ['pawa_pay', 'transfer_out'])
      .eq('status', 'completed')
      .gte('created_at', since)
    const spentMicro = (recent || []).reduce((s: number, r: any) => s + Number(r.amount_usdc_micro || 0), 0)
    const capNgn = tier === 'full' ? CAP_FULL_NGN : CAP_LITE_NGN
    if (spentMicro + amountMicro > capNgn * 1_000_000) {
      return NextResponse.json({
        error: `Daily spend limit is ₦${capNgn.toLocaleString('en-NG')}${tier !== 'full' ? ' — complete full verification to raise it' : ''}`,
        code: 'daily_cap',
      }, { status: 403 })
    }

    // Execute the money move.
    if (existing) {
      const { data: ok, error } = await admin.rpc('pawa_pay_ref', {
        p_reference: orderRef, p_buyer: buyer.id, p_auto_release_days: AUTO_RELEASE_DAYS,
      })
      if (error || ok === false) {
        const msg = /insufficient/i.test(error?.message || '') ? 'Not enough balance' : 'Could not complete payment'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    } else {
      const { error } = await admin.rpc('pawa_pay_direct', {
        p_buyer: buyer.id, p_seller: sellerId, p_amount_micro: amountMicro,
        p_reference: orderRef, p_note: note, p_surface: 'checkout',
        p_escrow: escrow, p_auto_release_days: AUTO_RELEASE_DAYS,
      })
      if (error) {
        const msg = /insufficient/i.test(error.message) ? 'Not enough balance' : 'Could not complete payment'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }

    // Receipts (fire-and-forget). Resolve names for nicer copy.
    const buyerName = String(prof?.display_name || '').split(' ')[0] || 'A PawaSave buyer'
    const { data: sellerProf } = await admin
      .from('profiles').select('merchant_name, display_name, tag').eq('id', sellerId).maybeSingle()
    const sellerLabel = sellerProf?.merchant_name || sellerProf?.display_name || (sellerProf?.tag ? `@${sellerProf.tag}` : 'a seller')
    sendPawaSellerPaidEmail(sellerId, { amountNgn, counterparty: buyerName, escrow, note, reference: orderRef }).catch(() => {})
    sendPawaBuyerReceiptEmail(buyer.id, { amountNgn, counterparty: sellerLabel, escrow, note, reference: orderRef }).catch(() => {})

    return NextResponse.json({ ok: true, reference: orderRef, escrow, amountNgn, status: escrow ? 'paid' : 'released' })
  } catch (e: unknown) {
    console.error('[pawa/pay] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
