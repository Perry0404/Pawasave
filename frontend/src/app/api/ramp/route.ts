import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { validatePosInvoice, processPosInvoice } from '@/lib/xend'

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'
const CUSTODY_ADDRESS = process.env.FLINT_CUSTODY_ADDRESS || ''
const DEFAULT_FEE_PERCENT = 1.5 // PawaSave service fee %
const XEND_CONFIGURED = !!(process.env.XEND_MERCHANT_ID && process.env.XEND_API_KEY && process.env.XEND_PRIVATE_KEY)

function generateRef() {
  return 'pawa_' + crypto.randomBytes(16).toString('hex')
}

/**
 * Calculate FlintAPI's own fees so user sees the full cost breakdown.
 * Off-ramp: 0.1% (cap ₦200) + ₦55 base + stamp duty ₦50 (>₦10k) + 7.5% VAT on fees
 * On-ramp:  0.1% (cap ₦200) + ₦55 base + gas (~₦150)
 */
function calcFlintFees(amountNaira: number, type: 'on' | 'off') {
  const platformFee = Math.min(amountNaira * 0.001, 200)
  const baseFee = amountNaira < 50000 ? 55 : 0
  const stampDuty = (type === 'off' && amountNaira > 10000) ? 50 : 0
  const subtotal = platformFee + baseFee + stampDuty
  const vat = type === 'off' ? subtotal * 0.075 : 0
  const gasFee = type === 'on' ? 150 : 0 // ~$0.1 at ₦1550/USD
  return Math.ceil(subtotal + vat + gasFee)
}

async function getFeePercent(supabase: any): Promise<number> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'ramp_fee_percent')
    .single()
  return data ? parseFloat(data.value) : DEFAULT_FEE_PERCENT
}

async function getSupabaseUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  return { user, supabase }
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getSupabaseUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { type, amount, bankCode, accountNumber, provider = 'flint' } = body

    if (!type || !amount || amount < 100) {
      return NextResponse.json({ error: 'Amount must be at least ₦100' }, { status: 400 })
    }

    if (type === 'off' && (!bankCode || !accountNumber) && provider === 'flint') {
      return NextResponse.json({ error: 'Bank details required for withdrawal' }, { status: 400 })
    }

    // ---- Xend provider path ----
    if (provider === 'xend') {
      if (!XEND_CONFIGURED) {
        return NextResponse.json({ error: 'Xend Finance not configured' }, { status: 503 })
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('xend_member_id')
        .eq('id', user.id)
        .single()

      if (!profile?.xend_member_id) {
        return NextResponse.json({ error: 'Register with Xend first (go to Settings)' }, { status: 400 })
      }

      const currency = 'USDC'
      await validatePosInvoice(profile.xend_member_id, {
        amount: 0,
        currency,
        fiatAmount: amount,
        fiatCurrency: 'NGN',
      })

      const invoice = await processPosInvoice(profile.xend_member_id, {
        amount: 0,
        currency,
        fiatAmount: amount,
        fiatCurrency: 'NGN',
      })

      const reference = generateRef()
      const feePercent = await getFeePercent(supabase)
      const pawaFeeNaira = Math.round(amount * feePercent / 100)

      await supabase.from('transactions').insert({
        user_id: user.id,
        type: type === 'on' ? 'deposit' : 'withdrawal',
        direction: type === 'on' ? 'credit' : 'debit',
        amount_kobo: Math.round(amount * 100),
        description: type === 'on' ? 'Received via Xend Finance' : 'Sent via Xend Finance',
        reference,
        paychant_tx_id: invoice.data.invoiceId,
        status: 'pending',
      })

      if (pawaFeeNaira > 0) {
        await supabase.rpc('record_platform_fee', {
          p_user_id: user.id,
          p_reference: reference,
          p_fee_type: type === 'on' ? 'ramp_onramp' : 'ramp_offramp',
          p_gross_kobo: Math.round(amount * 100),
          p_fee_kobo: Math.round(pawaFeeNaira * 100),
          p_fee_percent: feePercent,
        })
      }

      return NextResponse.json({
        provider: 'xend',
        transactionId: invoice.data.invoiceId,
        reference,
        walletAddress: invoice.data.walletAddress,
        depositAddress: invoice.data.walletAddress,
        amount: Math.round(amount),
        currency: invoice.data.currency,
        network: invoice.data.network,
        pawaFee: pawaFeeNaira,
        totalFee: pawaFeeNaira,
        feePercent,
      })
    }

    // ---- FlintAPI provider path (default) ----

    const reference = generateRef()
    const feePercent = await getFeePercent(supabase)
    const pawaFeeNaira = Math.round(amount * feePercent / 100)
    const flintFeeNaira = calcFlintFees(amount, type === 'on' ? 'on' : 'off')
    const totalFeeNaira = pawaFeeNaira + flintFeeNaira
    const netAmount = amount // Send full amount to FlintAPI (they deduct their fees internally)

    // Build the notify URL from the request origin
    const origin = request.nextUrl.origin || 'https://pawasave.xyz'

    // Build FlintAPI request (FlintAPI deducts their own fees internally)
    const flintBody: any = {
      type: type === 'on' ? 'on' : 'off',
      reference,
      network: 'base',
      amount: Math.round(amount),
      notifyUrl: `${origin}/api/webhook`,
    }

    if (type === 'on') {
      // On-ramp: destination is our custody wallet on Base
      if (CUSTODY_ADDRESS) {
        flintBody.destination = { address: CUSTODY_ADDRESS }
      }
    } else {
      // Off-ramp: destination is user's bank account
      flintBody.destination = { bankCode, accountNumber }
    }

    // Call FlintAPI
    const flintRes = await fetch(`${FLINT_BASE}/ramp/initialise`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': FLINT_API_KEY,
      },
      body: JSON.stringify(flintBody),
    })

    const flintData = await flintRes.json()

    if (!flintRes.ok || flintData.status === 'error') {
      const msg = flintData.message || flintData.error || 'Service temporarily unavailable'
      console.error('FlintAPI error:', flintRes.status, JSON.stringify(flintData))
      return NextResponse.json({ error: msg }, { status: 422 })
    }

    // Create pending transaction in Supabase
    const txData: any = {
      user_id: user.id,
      type: type === 'on' ? 'deposit' : 'withdrawal',
      direction: type === 'on' ? 'credit' : 'debit',
      amount_kobo: Math.round(amount * 100),
      description: type === 'on' ? 'Received via FlintAPI' : 'Sent via FlintAPI',
      reference,
      paychant_tx_id: flintData.data?.transactionId || null,
      status: 'pending',
    }

    await supabase.from('transactions').insert(txData)

    // Record PawaSave platform fee (our revenue, separate from FlintAPI fees)
    if (pawaFeeNaira > 0) {
      await supabase.rpc('record_platform_fee', {
        p_user_id: user.id,
        p_reference: reference,
        p_fee_type: type === 'on' ? 'ramp_onramp' : 'ramp_offramp',
        p_gross_kobo: Math.round(amount * 100),
        p_fee_kobo: Math.round(pawaFeeNaira * 100),
        p_fee_percent: feePercent,
      })
    }

    // For off-ramp, debit user's balance upfront (refund on failure via webhook)
    if (type === 'off') {
      const rate = 1550
      const usdcMicro = Math.floor((amount / rate) * 1_000_000)
      const { data: ok } = await supabase.rpc('debit_wallet', {
        p_user_id: user.id,
        p_naira_kobo: 0,
        p_usdc_micro: usdcMicro,
      })
      if (!ok) {
        // Insufficient balance — mark tx as failed
        await supabase.from('transactions').update({ status: 'failed' }).eq('reference', reference)
        return NextResponse.json({ error: 'Insufficient USDC balance' }, { status: 400 })
      }
    }

    // Return FlintAPI response data + our reference + fee breakdown
    return NextResponse.json({
      provider: 'flint',
      transactionId: flintData.data?.transactionId,
      reference,
      bankName: flintData.data?.bankName,
      bankCode: flintData.data?.bankCode,
      accountNumber: flintData.data?.accountNumber,
      accountName: flintData.data?.accountName,
      depositAddress: flintData.data?.depositAddress,
      amount: Math.round(amount),
      pawaFee: pawaFeeNaira,
      flintFee: flintFeeNaira,
      totalFee: totalFeeNaira,
      feePercent: feePercent,
    })
  } catch (err: any) {
    console.error('Ramp API error:', err)
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
