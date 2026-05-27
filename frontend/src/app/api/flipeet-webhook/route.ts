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
    // Return 200 if already processed so Flipeet stops retrying
    const { data: existingTx } = await supabase
      .from('transactions')
      .select('status')
      .eq('reference', reference)
      .single()
    if (existingTx) return NextResponse.json({ ok: true, already_processed: true })

    // No matching transaction found — check if this is a proxy member deposit
    // Auto-route to the user mapped to this Flipeet reference or proxy member ID
    // Flipeet may send beneficiary.wallet_address or similar identifier
    const beneficiaryId = readString(
      data?.beneficiary?.wallet_address,
      data?.beneficiary?.id,
      (body as any).beneficiary?.wallet_address,
      data?.memberId,
    )

    if (beneficiaryId && isCompletedStatus(status)) {
      const { data: userId } = await supabase.rpc('get_user_for_proxy_member', {
        p_proxy_member_id: beneficiaryId,
      })

      if (userId) {
        // Auto-process proxy deposit
        const destinationUsdcDirect = readNumber(
          data?.destination?.amount,
          data?.destination?.amount_usd,
        )
        let usdcMicro: number
        if (destinationUsdcDirect > 0) {
          usdcMicro = Math.floor(destinationUsdcDirect * 1_000_000)
        } else {
          const amountNaira = readNumber(data?.source?.amount, data?.amount, (body as any).amount)
          if (amountNaira > 0) {
            const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
            usdcMicro = Math.floor((amountNaira / rate) * 1_000_000)
          } else {
            usdcMicro = 0
          }
        }

        if (usdcMicro > 0) {
          await supabase.rpc('process_proxy_deposit', {
            p_user_id: userId,
            p_proxy_member_id: beneficiaryId,
            p_amount_usdc_micro: usdcMicro,
            p_reference: reference,
          })
        }
        return NextResponse.json({ ok: true, auto_routed: true })
      }
    }

    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  if (isCompletedStatus(status)) {
    await supabase
      .from('transactions')
      .update({ status: 'completed', paychant_tx_id: transactionId || tx.paychant_tx_id })
      .eq('id', tx.id)

    if (tx.type === 'deposit') {
      // Prefer destination USDC amount (handles both NGN and USD on-ramps correctly).
      // destination.amount is the USDC the user actually receives — no rate conversion needed.
      // Fallback: convert source NGN amount using live rate (for providers that don't send destination).
      const destinationUsdcDirect = readNumber(
        data?.destination?.amount,
        data?.destination?.amount_usd,
      )
      let grossUsdcMicro: number
      if (destinationUsdcDirect > 0) {
        grossUsdcMicro = Math.floor(destinationUsdcDirect * 1_000_000)
      } else {
        const amountNaira = readNumber(
          data?.source?.amount,
          data?.amount,
          (body as any).amount,
          tx.amount_kobo / 100,
        )
        const rate = await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY)
        grossUsdcMicro = Math.floor((amountNaira / rate) * 1_000_000)
      }
      const feeKobo = Number(tx.platform_fee_kobo || 0)
      // Fee is already baked into destination amount when using direct USDC; only deduct for NGN fallback
      const feeUsdcMicro = (destinationUsdcDirect <= 0 && feeKobo > 0)
        ? Math.floor((feeKobo / 100 / (await getNgnUsdRateFromFlint(process.env.FLINT_API_KEY))) * 1_000_000)
        : 0
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
        Promise.resolve(
          supabase
            .from('profiles')
            .select('xend_member_id')
            .eq('id', tx.user_id)
            .single()
        ).then(({ data: prof }) => {
          if (prof?.xend_member_id) {
            return depositToXendMoneyMarket({
              proxyMemberId: prof.xend_member_id,
              amount: poolUsdc,
              description: `PawaSave deposit pool – tx ${tx.id}`,
            })
          }
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