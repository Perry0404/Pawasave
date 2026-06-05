import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getNgnUsdRateFromFlipeet, ngnToCngnMicro } from '@/lib/ramp-rate'
import { supplyToLend } from '@/lib/custody'

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

  // Look up by PawaSave's reference first, then fall back to Flipeet's reference
  // (stored in paychant_tx_id). Flipeet webhooks often send their own reference,
  // not the one we passed — this fallback is the core fix for missed credits.
  let { data: tx, error: txErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('reference', reference)
    .eq('status', 'pending')
    .single()

  if (txErr || !tx) {
    // Try Flipeet's own reference stored in paychant_tx_id
    const { data: txByPaychant } = await supabase
      .from('transactions')
      .select('*')
      .eq('paychant_tx_id', reference)
      .eq('status', 'pending')
      .single()
    if (txByPaychant) {
      tx = txByPaychant
      txErr = null
    }
  }

  if (txErr || !tx) {
    // Return 200 if already processed so Flipeet stops retrying
    const { data: existingTx } = await supabase
      .from('transactions')
      .select('status')
      .or(`reference.eq.${reference},paychant_tx_id.eq.${reference}`)
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
            const rate = await getNgnUsdRateFromFlipeet()
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
      // Route to cNGN: user deposits NGN → credited as cNGN (1 NGN = 1 cNGN).
      // Source amount in NGN maps directly to cNGN micro (6 decimals).
      // Fallback: if cNGN amount not available, use destination USDC * NGN rate.
      const amountNaira = readNumber(
        data?.source?.amount,
        data?.amount,
        (body as any).amount,
        tx.amount_kobo / 100,
      )
      const feeKobo = Number(tx.platform_fee_kobo || 0)
      const feeNaira = feeKobo / 100
      const userNaira = Math.max(0, amountNaira - feeNaira)

      // Use Flipeet's live NGN/USD rate for USDC accounting + cNGN official rate for cNGN amount
      const flipeetRate = await getNgnUsdRateFromFlipeet()
      const cngnMicroBig = await ngnToCngnMicro(userNaira) // official cNGN rate (≈1:1 NGN)
      const cngnMicro = Number(cngnMicroBig)
      const userUsdcMicro = Math.floor((userNaira / flipeetRate) * 1_000_000)

      // Credit user's Supabase balance
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

      // Supply cNGN to PawasaveLend for yield (flexible savings)
      // Done async so webhook returns fast — failure logged but does not block credit
      if (cngnMicro > 0) {
        Promise.resolve(supplyToLend(BigInt(cngnMicro)))
          .then(({ txHash, shares }) => {
            console.info(`Supplied ${cngnMicro} cNGN to PawasaveLend — tx: ${txHash}, shares: ${shares}`)
            // Record shares in Supabase for proportional yield tracking
            return supabase.from('flexible_pool_positions').upsert({
              user_id: tx.user_id,
              cngn_deposited_micro: cngnMicro,
              last_supply_tx: txHash,
            }, { onConflict: 'user_id', ignoreDuplicates: false })
          })
          .catch((err: unknown) => {
            console.warn('PawasaveLend supply skipped (funds still credited):', err)
          })
      }
    }
  } else if (isFailedStatus(status)) {
    await supabase
      .from('transactions')
      .update({ status: 'failed', paychant_tx_id: transactionId || tx.paychant_tx_id })
      .eq('id', tx.id)

    if (tx.type === 'withdrawal') {
      const flipeetRate = await getNgnUsdRateFromFlipeet()
      const usdcMicro = Math.floor((tx.amount_kobo / 100 / flipeetRate) * 1_000_000)
      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: usdcMicro,
      })
    }
  }

  return NextResponse.json({ ok: true })
}