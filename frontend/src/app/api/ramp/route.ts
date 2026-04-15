import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'

function generateRef() {
  return 'pawa_' + crypto.randomBytes(16).toString('hex')
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
    const { type, amount, bankCode, accountNumber } = body

    if (!type || !amount || amount < 100) {
      return NextResponse.json({ error: 'Amount must be at least ₦100' }, { status: 400 })
    }

    if (type === 'off' && (!bankCode || !accountNumber)) {
      return NextResponse.json({ error: 'Bank details required for withdrawal' }, { status: 400 })
    }

    const reference = generateRef()

    // Build FlintAPI request
    const flintBody: any = {
      type: type === 'on' ? 'on' : 'off',
      reference,
      network: 'base',
      amount: Math.round(amount),
      notifyUrl: `${process.env.NEXT_PUBLIC_SUPABASE_URL ? request.nextUrl.origin : 'https://frontend-one-psi-50.vercel.app'}/api/webhook`,
    }

    if (type === 'on') {
      // On-ramp: destination is our custody wallet (or omit if FlintAPI handles it)
      // For now, just include the user context - FlintAPI will provide bank details
      flintBody.destination = { address: '0x0000000000000000000000000000000000000000' }
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
      return NextResponse.json(
        { error: flintData.message || 'FlintAPI error' },
        { status: flintRes.status || 500 }
      )
    }

    // Create pending transaction in Supabase
    const txData: any = {
      user_id: user.id,
      type: type === 'on' ? 'deposit' : 'withdrawal',
      direction: type === 'on' ? 'credit' : 'debit',
      amount_kobo: Math.round(amount * 100),
      description: type === 'on' ? 'Deposit via FlintAPI' : 'Withdrawal via FlintAPI',
      reference,
      paychant_tx_id: flintData.data?.transactionId || null,
      status: 'pending',
    }

    await supabase.from('transactions').insert(txData)

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

    // Return FlintAPI response data + our reference
    return NextResponse.json({
      transactionId: flintData.data?.transactionId,
      reference,
      bankName: flintData.data?.bankName,
      bankCode: flintData.data?.bankCode,
      accountNumber: flintData.data?.accountNumber,
      accountName: flintData.data?.accountName,
      depositAddress: flintData.data?.depositAddress,
      amount: Math.round(amount),
    })
  } catch (err: any) {
    console.error('Ramp API error:', err)
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
