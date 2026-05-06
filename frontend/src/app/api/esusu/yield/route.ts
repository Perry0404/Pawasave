import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { depositToXendMoneyMarket, withdrawFromXendMoneyMarket } from '@/lib/xend'

/**
 * POST /api/esusu/yield
 *
 * Manages the XEND Money Market (33% APY) position for an Esusu group pot.
 *
 * action = 'deposit'  — called after each successful contribution.
 *   Converts the contribution amount to USDC and deposits it into the
 *   Esusu pool XEND proxy member wallet so the pot earns 33% APY.
 *
 * action = 'payout'   — called after process_esusu_payout credits the base pot.
 *   Claims the accumulated USDC + estimated yield from XEND MM, then
 *   credits the yield bonus (in NGN) to the recipient's wallet.
 *
 * Requires env var: XEND_ESUSU_POOL_MEMBER_ID
 * Optional env var: USDC_TO_NAIRA_RATE (default 1600)
 */

const POOL_MEMBER_ID = process.env.XEND_ESUSU_POOL_MEMBER_ID || ''
const USDC_NGN_RATE  = parseInt(process.env.USDC_TO_NAIRA_RATE || '1600', 10)

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

  // If the Esusu pool proxy member is not configured, silently skip.
  // This allows the contribution/payout to succeed without yield until
  // the operator sets XEND_ESUSU_POOL_MEMBER_ID in their env.
  if (!POOL_MEMBER_ID) {
    return NextResponse.json({ ok: false, reason: 'pool_member_not_configured' })
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
  // DEPOSIT: called after each contribution
  // ──────────────────────────────────────────────────────────
  if (action === 'deposit') {
    if (!contribution_kobo || contribution_kobo <= 0) {
      return NextResponse.json({ error: 'contribution_kobo required' }, { status: 400 })
    }

    const usdcMicro = koboToUsdcMicro(contribution_kobo)
    if (usdcMicro <= 0) {
      return NextResponse.json({ ok: false, reason: 'amount_too_small' })
    }

    const usdcDecimal = usdcMicro / 1_000_000

    try {
      await depositToXendMoneyMarket({
        proxyMemberId: POOL_MEMBER_ID,
        amount: usdcDecimal,
        description: `Ajo pot deposit – ${group_id}`,
      })
    } catch (err) {
      console.error('[esusu/yield] XEND MM deposit failed:', err)
      // Non-fatal — pot is already credited; yield just won't accrue for this contribution
      return NextResponse.json({ ok: false, reason: 'xend_deposit_failed' })
    }

    // Atomically record the MM position in the DB
    await supabase.rpc('esusu_record_mm_deposit', {
      p_group_id:   group_id,
      p_usdc_micro: usdcMicro,
    })

    return NextResponse.json({ ok: true, deposited_usdc_micro: usdcMicro })
  }

  // ──────────────────────────────────────────────────────────
  // PAYOUT: called after process_esusu_payout pays the base pot
  // ──────────────────────────────────────────────────────────
  if (action === 'payout') {
    if (!recipient_user_id || !/^[0-9a-f-]{36}$/i.test(recipient_user_id)) {
      return NextResponse.json({ error: 'recipient_user_id required' }, { status: 400 })
    }

    // 1. Claim the group's MM position (resets counter, returns yield estimate)
    const { data: claim, error: claimErr } = await supabase.rpc('esusu_claim_mm_position', {
      p_group_id: group_id,
    })

    if (claimErr || !claim?.ok) {
      // No MM position (e.g. pool member not set when contributions were made) — skip silently
      return NextResponse.json({ ok: false, reason: claim?.reason ?? claimErr?.message ?? 'no_position' })
    }

    const { deposited_usdc_micro, yield_usdc_micro, total_usdc_micro, days } = claim as {
      deposited_usdc_micro: number
      yield_usdc_micro: number
      total_usdc_micro: number
      days: number
    }

    const totalUsdc = total_usdc_micro / 1_000_000

    // 2. Withdraw deposited + yield from XEND MM back to merchant wallet
    try {
      await withdrawFromXendMoneyMarket({
        proxyMemberId: POOL_MEMBER_ID,
        amount: totalUsdc,
        description: `Ajo payout withdrawal – ${group_id}`,
      })
    } catch (err) {
      console.error('[esusu/yield] XEND MM withdraw failed:', err)
      // Restore the tracking so the position isn't lost
      await supabase.rpc('esusu_record_mm_deposit', {
        p_group_id:   group_id,
        p_usdc_micro: deposited_usdc_micro,
      })
      return NextResponse.json({ ok: false, reason: 'xend_withdraw_failed' })
    }

    // 3. Credit the yield bonus (in NGN) to the recipient — base pot was already paid
    const yieldKobo = usdcMicroToKobo(yield_usdc_micro)

    if (yieldKobo > 0) {
      await supabase.rpc('credit_wallet', {
        p_user_id:    recipient_user_id,
        p_naira_kobo: yieldKobo,
        p_usdc_micro: 0,
      })

      await supabase.from('transactions').insert({
        user_id:       recipient_user_id,
        type:          'esusu_payout',
        direction:     'credit',
        amount_kobo:   yieldKobo,
        description:   `Ajo yield bonus – 33% APY over ${days} days`,
        status:        'completed',
      })
    }

    return NextResponse.json({
      ok:                   true,
      yield_kobo:           yieldKobo,
      deposited_usdc_micro,
      yield_usdc_micro,
      days,
    })
  }

  return NextResponse.json({ error: 'Invalid action. Use deposit or payout.' }, { status: 400 })
}
