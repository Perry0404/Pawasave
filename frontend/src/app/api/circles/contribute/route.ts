import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

/**
 * POST /api/circles/contribute  { groupId, amountNgn, note? }
 *
 * Pay into a COLLECTION / INVESTMENT circle (aso ebi, dues, harambee, group buy, chama). Rotating
 * ajo uses the existing esusu contribute flow — circle_contribute rejects rotating circles. The
 * debit + pot credit happen inside circle_contribute (SECURITY DEFINER, FOR UPDATE, idempotent on
 * the reference).
 */
export const dynamic = 'force-dynamic'

const MIN_NGN = Number(process.env.CIRCLE_MIN_CONTRIB_NGN || 100)

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
    const groupId = String(body?.groupId || '')
    const amountNgn = Number(body?.amountNgn)
    const note = body?.note ? String(body.note).slice(0, 140) : null
    if (!/^[0-9a-f-]{36}$/.test(groupId)) return NextResponse.json({ error: 'Invalid circle' }, { status: 400 })
    if (!(amountNgn >= MIN_NGN)) return NextResponse.json({ error: `Minimum is ₦${MIN_NGN.toLocaleString('en-NG')}` }, { status: 400 })

    const admin = serviceDb()
    const reference = `circle_c_${groupId}_${user.id}_${randomUUID().slice(0, 8)}`
    const { data: ok, error } = await admin.rpc('circle_contribute', {
      p_user_id: user.id,
      p_group_id: groupId,
      p_amount_kobo: Math.round(amountNgn * 100),
      p_reference: reference,
      p_note: note,
    })
    if (error || ok === false) {
      const m = error?.message || ''
      const msg = /insufficient/i.test(m) ? 'Not enough balance'
        : /not a member/i.test(m) ? 'You are not a member of this circle'
        : /rotating/i.test(m) ? 'Use the ajo contribute flow for this circle'
        : /not accepting/i.test(m) ? 'This circle is not accepting contributions'
        : 'Could not contribute'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ ok: true, reference })
  } catch (e: unknown) {
    console.error('[circles/contribute] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
