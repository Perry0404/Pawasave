import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/circles/create  (§3.3 Circles templates)
 *   { name, circleType, contributionAmountNgn?, cyclePeriod?, maxMembers?,
 *     goalNgn?, deadline?, beneficiaryTag?, purpose? }
 *
 * Creates a circle from a template. Rotating ajo keeps the classic behaviour; the other templates
 * are COLLECTION circles (one beneficiary receives the pot once) or the INVESTMENT (chama) variant.
 * The owner is added as the first member. Rotating ajo can still be created via the existing groups
 * flow; this route is what the templated "New circle" picker calls.
 */
export const dynamic = 'force-dynamic'

const TEMPLATES: Record<string, 'rotating' | 'collection' | 'investment'> = {
  rotating_ajo: 'rotating',
  aso_ebi: 'collection',
  event_dues: 'collection',
  harambee: 'collection',
  group_buy: 'collection',
  chama: 'investment',
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
    const name = String(body?.name || '').trim().slice(0, 80)
    const circleType = String(body?.circleType || 'rotating_ajo')
    const payoutMode = TEMPLATES[circleType]
    if (!name) return NextResponse.json({ error: 'Give your circle a name' }, { status: 400 })
    if (!payoutMode) return NextResponse.json({ error: 'Unknown circle type' }, { status: 400 })

    const contributionKobo = Math.round(Number(body?.contributionAmountNgn || 0) * 100)
    const cyclePeriod = ['daily', 'weekly', 'biweekly', 'monthly'].includes(body?.cyclePeriod) ? body.cyclePeriod : 'monthly'
    const maxMembers = Math.min(50, Math.max(2, Number(body?.maxMembers) || 10))
    const goalKobo = body?.goalNgn ? Math.round(Number(body.goalNgn) * 100) : null
    const deadline = body?.deadline ? new Date(body.deadline).toISOString() : null
    const purpose = body?.purpose ? String(body.purpose).slice(0, 300) : null

    if (payoutMode === 'rotating' && contributionKobo <= 0) {
      return NextResponse.json({ error: 'Set the contribution amount' }, { status: 400 })
    }

    const admin = serviceDb()

    // Beneficiary: for collection/investment circles, who receives the pot. A @tag, else the owner.
    let beneficiaryId: string = user.id
    if (payoutMode !== 'rotating' && body?.beneficiaryTag) {
      const tag = String(body.beneficiaryTag).replace(/^@+/, '').toLowerCase()
      const { data: b } = await admin.from('profiles').select('id').eq('tag', tag).maybeSingle()
      if (!b) return NextResponse.json({ error: `No PawaSave user @${tag}` }, { status: 404 })
      beneficiaryId = String(b.id)
    }

    const { data: group, error } = await admin
      .from('esusu_groups')
      .insert({
        name,
        owner_id: user.id,
        contribution_amount_kobo: contributionKobo,
        cycle_period: cyclePeriod,
        max_members: maxMembers,
        status: 'forming',
        circle_type: circleType,
        payout_mode: payoutMode,
        goal_kobo: goalKobo,
        deadline,
        beneficiary_id: payoutMode === 'rotating' ? null : beneficiaryId,
        purpose,
      })
      .select('id')
      .single()
    if (error || !group) {
      console.error('[circles/create] insert error:', error?.message)
      return NextResponse.json({ error: 'Could not create circle' }, { status: 400 })
    }

    await admin.from('esusu_members').insert({ group_id: group.id, user_id: user.id, payout_position: 1 })

    return NextResponse.json({ ok: true, id: group.id, circleType, payoutMode })
  } catch (e: unknown) {
    console.error('[circles/create] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
