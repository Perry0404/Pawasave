import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyXendWebhook } from '@/lib/xend'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'

/**
 * POST /api/xend-webhook
 *
 * Receives webhook events from Xend Finance.
 * Verifies RSA signature, then processes the event.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Verify Xend RSA webhook signature
  const xendPublicKey = process.env.XEND_PUBLIC_KEY
  if (xendPublicKey) {
    const valid = verifyXendWebhook(body)
    if (!valid) {
      console.error('Xend webhook signature verification failed')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Webhook service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  // Xend webhook payloads vary by event type.
  // Common fields: event/type, transactionId, status, amount, memberId, etc.
  const event = (body.event || body.type || '') as string
  const status = (body.status || '') as string
  const transactionId = (body.transactionId || body.reference || '') as string
  const memberId = (body.memberId || '') as string
  const amount = Number(body.amount) || 0

  // Log the webhook for debugging
  console.log('Xend webhook received:', { event, status, transactionId, memberId, amount })

  // Process based on event type
  if (status === 'completed' || event.includes('completed')) {
    // If this is a ramp completion, credit the user's vault
    if (memberId && amount > 0) {
      // Look up user by xend_member_id
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('xend_member_id', memberId)
        .single()

      if (profile) {
        const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
        const usdcMicro = Math.floor((amount / rate) * 1_000_000)

        // Credit the user's USDC vault
        await supabase.rpc('credit_wallet', {
          p_user_id: profile.id,
          p_naira_kobo: 0,
          p_usdc_micro: usdcMicro,
        })

        // Record the transaction
        await supabase.from('transactions').insert({
          user_id: profile.id,
          type: 'deposit',
          direction: 'credit',
          amount_kobo: Math.round(amount * 100),
          amount_usdc_micro: usdcMicro,
          description: 'Received via Xend Finance',
          reference: transactionId,
          status: 'completed',
        })

        // Auto-allocate 90% to cNGN yield pool
        await supabase.rpc('allocate_cngn_pool', {
          p_user_id: profile.id,
          p_usdc_micro: usdcMicro,
        })
      }
    }
  } else if (status === 'failed' || event.includes('failed')) {
    // Handle failure — refund if we debited earlier
    if (memberId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('xend_member_id', memberId)
        .single()

      if (profile && amount > 0) {
        const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
        const usdcMicro = Math.floor((amount / rate) * 1_000_000)

        await supabase.rpc('credit_wallet', {
          p_user_id: profile.id,
          p_naira_kobo: 0,
          p_usdc_micro: usdcMicro,
        })

        await supabase.from('transactions').insert({
          user_id: profile.id,
          type: 'deposit',
          direction: 'credit',
          amount_kobo: Math.round(amount * 100),
          amount_usdc_micro: usdcMicro,
          description: 'Xend refund — transaction failed',
          reference: transactionId,
          status: 'completed',
        })
      }
    }
  }

  return NextResponse.json({ ok: true })
}
