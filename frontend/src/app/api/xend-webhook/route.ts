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
    // Look up the pending PawaSave transaction by Xend invoiceId (stored as paychant_tx_id)
    // This prevents double-crediting if the webhook fires multiple times.
    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('paychant_tx_id', transactionId)
      .eq('status', 'pending')
      .single()

    if (tx) {
      // Mark the existing transaction as completed
      await supabase
        .from('transactions')
        .update({ status: 'completed' })
        .eq('id', tx.id)

      const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
      const usdcMicro = Math.floor((amount > 0 ? amount : tx.amount_kobo / 100) / rate * 1_000_000)

      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: usdcMicro,
      })

      await supabase.rpc('allocate_cngn_pool', {
        p_user_id: tx.user_id,
        p_usdc_micro: usdcMicro,
      })
    } else if (memberId) {
      // No matching transaction found — check if this is a proxy member deposit
      // Auto-route to the user mapped to this proxy member ID
      const { data: userId } = await supabase.rpc('get_user_for_proxy_member', {
        p_proxy_member_id: memberId,
      })

      if (userId) {
        // Auto-process proxy deposit
        const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
        const usdcMicro = Math.floor((amount || 0) / rate * 1_000_000)

        if (usdcMicro > 0) {
          await supabase.rpc('process_proxy_deposit', {
            p_user_id: userId,
            p_proxy_member_id: memberId,
            p_amount_usdc_micro: usdcMicro,
            p_reference: transactionId,
          })
        }
      }
    }
    // If no pending tx and no proxy member mapping, ignore (idempotent)
  } else if (status === 'failed' || event.includes('failed')) {
    // Find the pending transaction to refund
    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('paychant_tx_id', transactionId)
      .eq('status', 'pending')
      .single()

    if (tx) {
      await supabase
        .from('transactions')
        .update({ status: 'failed' })
        .eq('id', tx.id)

      // Refund only if this was a debit-first withdrawal (type === 'withdrawal')
      if (tx.type === 'withdrawal') {
        const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
        const usdcMicro = Math.floor((tx.amount_kobo / 100) / rate * 1_000_000)
        await supabase.rpc('credit_wallet', {
          p_user_id: tx.user_id,
          p_naira_kobo: 0,
          p_usdc_micro: usdcMicro,
        })
      }
    }
  }

  return NextResponse.json({ ok: true })
}
