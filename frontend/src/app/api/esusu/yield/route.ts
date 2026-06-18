import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { koboToCngnMicro, cngnMicroToKobo } from '@/lib/ramp-rate'

/**
 * POST /api/esusu/yield
 *
 * Manages the 27% APY yield position for an Esusu group pot.
 * Contributions are held in the PawaSave merchant wallet.
 * Yield is calculated by the DB (esusu_claim_mm_position) and credited
 * from platform reserves on payout — no external XEND MM call needed.
 *
 * action = 'deposit'  — records the contribution amount for yield tracking.
 * action = 'payout'   — claims accumulated yield and credits recipient.
 *
 * Amounts are tracked in cNGN micro-units at a 1:1 NGN peg (V2-LOW-02) — no
 * USD/NGN rate detour. The DB columns are named *_usdc_micro for legacy reasons
 * but hold cNGN micro-units.
 */

export async function POST(request: NextRequest) {
  let body: { action?: string; group_id?: string; contribution_kobo?: number; recipient_user_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { action, group_id, contribution_kobo, recipient_user_id } = body

  if (!group_id || !/^[0-9a-f-]{36}$/i.test(group_id)) {
    return NextResponse.json({ error: 'Invalid group_id' }, { status: 400 })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  // Authn/authz (FIND-API-07): require a logged-in user who belongs to the group.
  // Previously this endpoint accepted any caller who knew the group/user UUIDs,
  // allowing unauthorized yield credits.
  const cookieStore = await cookies()
  const authClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { data: membership } = await supabase
    .from('esusu_members')
    .select('id')
    .eq('group_id', group_id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this group' }, { status: 403 })
  }

  // ──────────────────────────────────────────────────────────
  // DEPOSIT: record contribution for yield tracking
  // ──────────────────────────────────────────────────────────
  if (action === 'deposit') {
    if (!contribution_kobo || contribution_kobo <= 0) {
      return NextResponse.json({ error: 'contribution_kobo required' }, { status: 400 })
    }

    const usdcMicro = koboToCngnMicro(contribution_kobo)
    if (usdcMicro <= 0) {
      return NextResponse.json({ ok: false, reason: 'amount_too_small' })
    }

    // Record the position in DB so yield accrues from today
    await supabase.rpc('esusu_record_mm_deposit', {
      p_group_id:   group_id,
      p_usdc_micro: usdcMicro,
    })

    return NextResponse.json({ ok: true, tracked_usdc_micro: usdcMicro })
  }

  // ──────────────────────────────────────────────────────────
  // PAYOUT: calculate yield from DB and credit from platform reserves
  // ──────────────────────────────────────────────────────────
  if (action === 'payout') {
    if (!recipient_user_id || !/^[0-9a-f-]{36}$/i.test(recipient_user_id)) {
      return NextResponse.json({ error: 'recipient_user_id required' }, { status: 400 })
    }

    // Claim the group's position — resets counter, returns yield calculation
    const { data: claim, error: claimErr } = await supabase.rpc('esusu_claim_mm_position', {
      p_group_id: group_id,
    })

    if (claimErr || !claim?.ok) {
      return NextResponse.json({ ok: false, reason: claim?.reason ?? claimErr?.message ?? 'no_position' })
    }

    const { yield_usdc_micro, days } = claim as {
      deposited_usdc_micro: number
      yield_usdc_micro: number
      total_usdc_micro: number
      days: number
    }

    // Credit yield bonus in NGN from platform reserves
    const yieldKobo = cngnMicroToKobo(yield_usdc_micro)

    if (yieldKobo > 0) {
      await supabase.rpc('credit_wallet', {
        p_user_id:    recipient_user_id,
        p_naira_kobo: yieldKobo,
        p_usdc_micro: 0,
      })

      await supabase.from('transactions').insert({
        user_id:     recipient_user_id,
        type:        'esusu_payout',
        direction:   'credit',
        amount_kobo: yieldKobo,
        description: `Ajo yield bonus – 27% APY over ${days} days`,
        status:      'completed',
      })
    }

    return NextResponse.json({
      ok:              true,
      yield_kobo:      yieldKobo,
      yield_usdc_micro,
      days,
    })
  }

  return NextResponse.json({ error: 'Invalid action. Use deposit or payout.' }, { status: 400 })
}
