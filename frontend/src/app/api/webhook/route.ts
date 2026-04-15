import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const WEBHOOK_SECRET = process.env.FLINT_WEBHOOK_SECRET || ''

function verifySignature(body: string, signature: string): boolean {
  if (!WEBHOOK_SECRET || !signature) return false
  const hash = crypto
    .createHmac('sha512', WEBHOOK_SECRET)
    .update(body)
    .digest('hex')
  return signature === hash
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-flint-signature') || ''

  // Verify webhook signature
  if (WEBHOOK_SECRET && !verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const body = JSON.parse(rawBody)
  const { event, data } = body

  if (!data?.reference) {
    return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
  }

  // Use service role to bypass RLS
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  )

  // Find the pending transaction
  const { data: tx, error: txErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('reference', data.reference)
    .eq('status', 'pending')
    .single()

  if (txErr || !tx) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const isCompleted = data.status === 'completed' || event?.includes('completed')
  const isFailed = data.status === 'failed' || event?.includes('failed')

  if (isCompleted) {
    // Mark transaction completed
    await supabase
      .from('transactions')
      .update({ status: 'completed', paychant_tx_id: data.transactionId || tx.paychant_tx_id })
      .eq('id', tx.id)

    if (tx.type === 'deposit') {
      // On-ramp completed: credit user's USDC vault
      const amountNaira = data.processedAmount || data.amount || tx.amount_kobo / 100
      const rate = 1550
      const usdcMicro = Math.floor((amountNaira / rate) * 1_000_000)

      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: usdcMicro,
      })

      // Update the transaction with USDC amount
      await supabase
        .from('transactions')
        .update({ amount_usdc_micro: usdcMicro })
        .eq('id', tx.id)
    }
    // For withdrawal: balance was already debited upfront, nothing more needed
  } else if (isFailed) {
    await supabase
      .from('transactions')
      .update({ status: 'failed' })
      .eq('id', tx.id)

    if (tx.type === 'withdrawal') {
      // Refund the debited USDC
      const rate = 1550
      const usdcMicro = Math.floor((tx.amount_kobo / 100 / rate) * 1_000_000)
      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: usdcMicro,
      })
    }
  }

  return NextResponse.json({ ok: true })
}
