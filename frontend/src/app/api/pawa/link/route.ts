import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

/**
 * POST /api/pawa/link  { amountNgn, note?, surface?: 'link'|'qr', escrow? }
 *
 * A seller creates a payment request — the link they drop into a WhatsApp/Instagram DM (§3.6's
 * highest-differentiation surface) or render as a QR. No money moves; it creates a PENDING order.
 * The buyer opens /pay/<reference> and pays it via /api/pawa/pay. Returns the reference + share URL.
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

const MIN_NGN = Number(process.env.PAWA_MIN_NGN || 100)

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const amountNgn = Number(body?.amountNgn)
    const note = body?.note ? String(body.note).slice(0, 200) : null
    const surface = body?.surface === 'qr' ? 'qr' : 'link'
    const escrow = body?.escrow === undefined ? true : Boolean(body.escrow)
    if (!(amountNgn >= MIN_NGN)) return NextResponse.json({ error: `Minimum is ₦${MIN_NGN.toLocaleString('en-NG')}` }, { status: 400 })

    const admin = serviceDb()
    // A seller must have a @tag (their Pawa Tag).
    const { data: prof } = await admin.from('profiles').select('tag').eq('id', user.id).maybeSingle()
    if (!prof?.tag) return NextResponse.json({ error: 'Set your @tag first — it becomes your Pawa Tag', code: 'tag_required' }, { status: 400 })

    const reference = `pawa:${randomUUID()}`
    const { error } = await admin.rpc('pawa_create_order', {
      p_seller: user.id,
      p_amount_micro: Math.round(amountNgn * 1_000_000),
      p_reference: reference,
      p_note: note,
      p_surface: surface,
      p_escrow: escrow,
    })
    if (error) return NextResponse.json({ error: 'Could not create payment link' }, { status: 400 })

    const origin = request.nextUrl.origin || 'https://pawasave.xyz'
    return NextResponse.json({
      ok: true,
      reference,
      url: `${origin}/pay/${encodeURIComponent(reference)}`,
      amountNgn,
      escrow,
      surface,
    })
  } catch (e: unknown) {
    console.error('[pawa/link] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
