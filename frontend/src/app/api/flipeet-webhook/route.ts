import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'
import { depositToXendMoneyMarket } from '@/lib/xend'

function readString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function readNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function isCompletedStatus(status: string) {
  return /completed|success|successful|settled|confirmed|paid/i.test(status)
}

function isFailedStatus(status: string) {
  return /failed|cancelled|canceled|expired|rejected/i.test(status)
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Webhook service key not configured' }, { status: 503 })
  }

  const data = (body as any).data?.data || (body as any).data || body
  const reference = readString(
    data?.reference,
    (body as any).reference,
    (body as any).referenceId,
    data?.meta?.reference,
  )
  const status = readString(
    data?.status,
    (body as any).status,
    (body as any).event,
    (body as any).type,
  )
  const transactionId = readString(
    data?.id,
    data?.transactionId,
    (body as any).transactionId,
    reference,
  )

  if (!reference) {
    return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const { data: tx, error: txErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('reference', reference)
    .eq('status', 'pending')
    .single()

  if (txErr || !tx) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (isCompletedStatus(status)) {
    await supabase
      .from('transactions')
      .update({ status: 'completed', paychant_tx_id: transactionId || tx.paychant_tx_id })
      .eq('id', tx.id)

    if (tx.type === 'deposit') {
      const amountNaira = readNumber(
        data?.source?.amount,
        data?.amount,
        (body as any).amount,
        tx.amount_kobo / 100,
      )
      const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
      const grossUsdcMicro = Math.floor((amountNaira / rate) * 1_000_000)
      const feeKobo = Number(tx.platform_fee_kobo || 0)
      const feeUsdcMicro = feeKobo > 0 ? Math.floor((feeKobo / 100 / rate) * 1_000_000) : 0
      const userUsdcMicro = Math.max(0, grossUsdcMicro - feeUsdcMicro)

      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: userUsdcMicro,
      })

      await supabase
        .from('transactions')
        .update({ amount_usdc_micro: userUsdcMicro })
        .eq('id', tx.id)

      await supabase.rpc('allocate_cngn_pool', {
        p_user_id: tx.user_id,
        p_usdc_micro: userUsdcMicro,
      })

      // Deploy 90% pool portion to Xend money market (best-effort)
      const poolUsdc = Math.floor(userUsdcMicro * 0.9) / 1_000_000
      if (poolUsdc >= 0.01) {
        depositToXendMoneyMarket({
          amount: poolUsdc,
          narration: `PawaSave deposit pool – tx ${tx.id}`,
        }).catch((err: unknown) => {
          console.warn('Xend money market deposit skipped:', err)
        })
      }
    }
  } else if (isFailedStatus(status)) {
    await supabase
      .from('transactions')
      .update({ status: 'failed', paychant_tx_id: transactionId || tx.paychant_tx_id })
      .eq('id', tx.id)

    if (tx.type === 'withdrawal') {
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