import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'

const WEBHOOK_SECRET = process.env.FLINT_WEBHOOK_SECRET || ''

function verifySignature(bodyObj: any, signature: string): boolean {
  if (!WEBHOOK_SECRET || !signature) return false
  // FlintAPI docs: HMAC SHA512 of JSON.stringify(body)
  const hash = crypto
    .createHmac('sha512', WEBHOOK_SECRET)
    .update(JSON.stringify(bodyObj))
    .digest('hex')
  return signature === hash
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-flint-signature') || ''

  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Verify webhook signature (try both stringify and raw approaches)
  if (WEBHOOK_SECRET) {
    const valid = verifySignature(body, signature) || (() => {
      // Fallback: verify against raw body text in case FlintAPI signs raw bytes
      const hash = crypto.createHmac('sha512', WEBHOOK_SECRET).update(rawBody).digest('hex')
      return hash === signature
    })()
    if (!valid) {
      console.error('Webhook signature mismatch')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  const { event, data } = body

  if (!data?.reference) {
    return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
  }

  // Use service role to bypass RLS
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Webhook service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
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
      // On-ramp completed: credit user USDC minus platform fee
      const amountNaira = Number(data.processedAmount || data.amount || tx.amount_kobo / 100)
      const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
      const grossUsdcMicro = Math.floor((amountNaira / rate) * 1_000_000)

      // Deduct platform fee (stored on transaction as kobo, convert to micro-USDC)
      const feeKobo = Number(tx.platform_fee_kobo || 0)
      const feeUsdcMicro = feeKobo > 0 ? Math.floor((feeKobo / 100 / rate) * 1_000_000) : 0
      const userUsdcMicro = Math.max(0, grossUsdcMicro - feeUsdcMicro)

      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: userUsdcMicro,
      })

      // Update the transaction with net USDC amount
      await supabase
        .from('transactions')
        .update({ amount_usdc_micro: userUsdcMicro })
        .eq('id', tx.id)

      // Auto-allocate to vault (save_to_vault moves USDC into savings, earns 33% APY)
      // Converts USDC to equivalent naira kobo for the vault debit side
      const nairaKoboEquivalent = Math.floor((userUsdcMicro / 1_000_000) * rate * 100)
      await supabase.rpc('save_to_vault', {
        p_user_id:    tx.user_id,
        p_naira_kobo: nairaKoboEquivalent,
        p_usdc_micro: userUsdcMicro,
      })
    }
    // For withdrawal: balance was already debited upfront, nothing more needed
  } else if (isFailed) {
    await supabase
      .from('transactions')
      .update({ status: 'failed' })
      .eq('id', tx.id)

    if (tx.type === 'withdrawal') {
      // Refund the debited USDC
      const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
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
