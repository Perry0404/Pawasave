import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const body = await req.json()
    const { event, data } = body

    // Verify webhook signature if Paychant provides one
    // const signature = req.headers.get('x-paychant-signature')

    if (!data?.reference || !data?.status) {
      return new Response('Invalid payload', { status: 400 })
    }

    // Find the pending transaction by reference
    const { data: tx, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('reference', data.reference)
      .eq('status', 'pending')
      .single()

    if (txError || !tx) {
      return new Response('Transaction not found', { status: 404 })
    }

    if (data.status === 'completed' || data.status === 'success') {
      // Update transaction status
      await supabase
        .from('transactions')
        .update({ status: 'completed', paychant_tx_id: data.transactionId || null })
        .eq('id', tx.id)

      // Update wallet balance
      if (tx.type === 'deposit') {
        // On-ramp: user deposited NGN, received USDC
        await supabase.rpc('credit_wallet', {
          p_user_id: tx.user_id,
          p_naira_kobo: tx.amount_kobo,
          p_usdc_micro: tx.amount_usdc_micro || 0,
        })
      } else if (tx.type === 'withdrawal') {
        // Off-ramp: user sold USDC, received NGN
        // Balance already debited when withdrawal was initiated
      }
    } else if (data.status === 'failed' || data.status === 'expired') {
      await supabase
        .from('transactions')
        .update({ status: 'failed' })
        .eq('id', tx.id)

      // Refund if it was a withdrawal that was debited upfront
      if (tx.type === 'withdrawal') {
        await supabase.rpc('credit_wallet', {
          p_user_id: tx.user_id,
          p_naira_kobo: tx.amount_kobo,
          p_usdc_micro: 0,
        })
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
