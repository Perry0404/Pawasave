import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * POST /api/esusu/yield
 *
 * Manages the 33% APY yield position for an Esusu group pot.
 * Contributions are held in the PawaSave merchant wallet.
 * Yield is calculated by the DB (esusu_claim_mm_position) and credited
 * from platform reserves on payout — no external XEND MM call needed.
 *
 * action = 'deposit'  — records the contribution amount for yield tracking.
 * action = 'payout'   — claims accumulated yield and credits recipient.
 *
 * Optional env var: USDC_TO_NAIRA_RATE (default 1600)
 */

const USDC_NGN_RATE = parseInt(process.env.USDC_TO_NAIRA_RATE || '1600', 10)

/** Naira kobo → USDC micro-units  (1 USDC = RATE NGN = RATE×100 kobo) */
function koboToUsdcMicro(kobo: number): number {
  return Math.floor((kobo * 1_000_000) / (USDC_NGN_RATE * 100))
}

/** USDC micro-units → Naira kobo */
function usdcMicroToKobo(micro: number): number {
  return Math.floor((micro * USDC_NGN_RATE * 100) / 1_000_000)
}

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

  // ──────────────────────────────────────────────────────────
  // DEPOSIT: record contribution for yield tracking
  // ──────────────────────────────────────────────────────────
  if (action === 'deposit') {
    if (!contribution_kobo || contribution_kobo <= 0) {
      return NextResponse.json({ error: 'contribution_kobo required' }, { status: 400 })
    }

    const usdcMicro = koboToUsdcMicro(contribution_kobo)
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
    const yieldKobo = usdcMicroToKobo(yield_usdc_micro)

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
        description: `Ajo yield bonus – 33% APY over ${days} days`,
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
