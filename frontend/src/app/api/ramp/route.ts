import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { validatePosInvoice, processPosInvoice, registerProxyMember } from '@/lib/xend'
import {
  FlipeetApiError,
  getFlipeetRate,
  initializeFlipeetOffRamp,
  initializeFlipeetOnRamp,
} from '@/lib/flipeet'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'
// Custody address where on-ramped USDC is received. Shared across providers.
const CUSTODY_ADDRESS =
  process.env.FLINT_CUSTODY_ADDRESS
  || process.env.XEND_CUSTODY_ADDRESS
  || process.env.RAMP_CUSTODY_ADDRESS
  || ''
const FLIPEET_CUSTODY_ADDRESS =
  process.env.FLIPEET_CUSTODY_ADDRESS
  || CUSTODY_ADDRESS
const DEFAULT_FEE_PERCENT = 1.5
const DEFAULT_XEND_ESTIMATED_FEE = 120
const DEFAULT_FLIPEET_ESTIMATED_FEE = 100
// Providers auto-enable when credentials are present — no manual flag needed
const FLINT_CONFIGURED = Boolean(FLINT_API_KEY)
const XEND_CONFIGURED = Boolean(
  process.env.XEND_MERCHANT_ID && process.env.XEND_API_KEY && process.env.XEND_PRIVATE_KEY,
)
const FLIPEET_CONFIGURED = Boolean(
  process.env.FLIPEET_API_KEY && FLIPEET_CUSTODY_ADDRESS,
)

type RampType = 'on' | 'off'
type Provider = 'flint' | 'xend' | 'flipeet'

type ProviderResult = {
  provider: Provider
  transactionId?: string
  reference: string
  amount?: number
  bankName?: string
  bankCode?: string
  accountNumber?: string
  accountName?: string
  depositAddress?: string
  walletAddress?: string
  currency?: string
  network?: string
  pawaFee: number
  providerFee: number
  totalFee: number
  feePercent: number
}

function generateRef() {
  return 'pawa_' + crypto.randomBytes(16).toString('hex')
}

function sha256Hex(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function calcFlintFees(amountNaira: number, type: RampType) {
  const platformFee = Math.min(amountNaira * 0.001, 200)
  const baseFee = amountNaira < 50000 ? 55 : 0
  const stampDuty = type === 'off' && amountNaira > 10000 ? 50 : 0
  const subtotal = platformFee + baseFee + stampDuty
  const vat = type === 'off' ? subtotal * 0.075 : 0
  const gasFee = type === 'on' ? 150 : 0
  return Math.ceil(subtotal + vat + gasFee)
}

function isAuthError(message: string) {
  return /invalid key|invalid api key|unauthorized|forbidden|401|403/i.test(message)
}

function formatProviderError(provider: Provider, error: unknown) {
  const message = error instanceof Error ? error.message : 'Service temporarily unavailable'

  if (provider === 'flint' && isAuthError(message)) {
    return 'Flint authentication failed. Confirm FLINT_API_KEY is the live API key on the active deployment, then redeploy.'
  }

  if (provider === 'xend' && /credentials not configured|private key/i.test(message)) {
    return 'Xend is not fully configured. Merchant API calls require XEND_PRIVATE_KEY as the merchant private PEM, not the public key uploaded to Xend.'
  }

  if (provider === 'flipeet' && (error instanceof FlipeetApiError || isAuthError(message))) {
    return 'Flipeet authentication failed. Confirm FLIPEET_API_KEY is set on the active deployment, then redeploy.'
  }

  return message
}

async function getNumberSetting(supabase: any, key: string, fallback: number): Promise<number> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', key)
    .single()

  if (!data?.value) return fallback
  const value = Number(data.value)
  return Number.isFinite(value) ? value : fallback
}

async function getSupabaseUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { user, supabase }
}

async function ensureWithdrawalPin(
  supabase: any,
  userId: string,
  transactionPin: string,
): Promise<NextResponse | null> {
  if (!/^\d{4}$/.test(transactionPin)) {
    return NextResponse.json({ error: 'Valid 4-digit transaction PIN is required' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('transaction_pin_hash')
    .eq('id', userId)
    .single()

  if (!profile?.transaction_pin_hash) {
    return NextResponse.json({ error: 'Set your transaction PIN in Settings first' }, { status: 400 })
  }

  if (sha256Hex(transactionPin) !== profile.transaction_pin_hash) {
    return NextResponse.json({ error: 'Incorrect transaction PIN' }, { status: 401 })
  }

  return null
}

async function maybeDebitForWithdrawal(
  supabase: any,
  userId: string,
  amountNaira: number,
  reference: string,
): Promise<NextResponse | null> {
  const rate = await getNgnUsdRateFromFlint(FLINT_API_KEY)
  const usdcMicro = Math.floor((amountNaira / rate) * 1_000_000)
  const { data: ok } = await supabase.rpc('debit_wallet', {
    p_user_id: userId,
    p_naira_kobo: 0,
    p_usdc_micro: usdcMicro,
  })

  if (!ok) {
    await supabase.from('transactions').update({ status: 'failed' }).eq('reference', reference)
    return NextResponse.json({ error: 'Insufficient USDC balance' }, { status: 400 })
  }

  return null
}

async function recordPlatformFee(
  supabase: any,
  userId: string,
  reference: string,
  feeType: 'ramp_onramp' | 'ramp_offramp',
  grossAmountKobo: number,
  feeKobo: number,
  feePercent: number,
) {
  if (feeKobo <= 0) return
  await supabase.rpc('record_platform_fee', {
    p_user_id: userId,
    p_reference: reference,
    p_fee_type: feeType,
    p_gross_kobo: grossAmountKobo,
    p_fee_kobo: feeKobo,
    p_fee_percent: feePercent,
  })
}

async function runFlint(
  request: NextRequest,
  supabase: any,
  userId: string,
  type: RampType,
  amount: number,
  bankCode?: string,
  accountNumber?: string,
): Promise<ProviderResult> {
  if (!FLINT_CONFIGURED) throw new Error('Flint provider unavailable')

  const reference = generateRef()
  const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
  const pawaFeeNaira = Math.round((amount * feePercent) / 100)
  const providerFeeNaira = calcFlintFees(amount, type)

  const origin = request.nextUrl.origin || 'https://pawasave.xyz'
  const flintBody: any = {
    type,
    reference,
    network: 'base',
    amount: Math.round(amount),
    notifyUrl: `${origin}/api/webhook`,
  }

  if (type === 'on') {
    if (CUSTODY_ADDRESS) flintBody.destination = { address: CUSTODY_ADDRESS }
  } else {
    flintBody.destination = { bankCode, accountNumber }
  }

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
    throw new Error(msg)
  }

  const pawaFeeKobo = Math.round(pawaFeeNaira * 100)
  await supabase.from('transactions').insert({
    user_id: userId,
    type: type === 'on' ? 'deposit' : 'withdrawal',
    direction: type === 'on' ? 'credit' : 'debit',
    amount_kobo: Math.round(amount * 100),
    platform_fee_kobo: pawaFeeKobo,
    description: type === 'on' ? 'Received via FlintAPI' : 'Sent via FlintAPI',
    reference,
    paychant_tx_id: flintData.data?.transactionId || null,
    status: 'pending',
  })

  await recordPlatformFee(
    supabase,
    userId,
    reference,
    type === 'on' ? 'ramp_onramp' : 'ramp_offramp',
    Math.round(amount * 100),
    pawaFeeKobo,
    feePercent,
  )

  if (type === 'off') {
    const debitError = await maybeDebitForWithdrawal(supabase, userId, amount, reference)
    if (debitError) throw new Error('Insufficient USDC balance')
  }

  return {
    provider: 'flint',
    transactionId: flintData.data?.transactionId,
    reference,
    bankName: flintData.data?.bankName,
    bankCode: flintData.data?.bankCode,
    accountNumber: flintData.data?.accountNumber,
    accountName: flintData.data?.accountName,
    depositAddress: flintData.data?.depositAddress,
    pawaFee: pawaFeeNaira,
    providerFee: providerFeeNaira,
    totalFee: pawaFeeNaira + providerFeeNaira,
    feePercent,
  }
}

async function ensureXendMemberId(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('xend_member_id')
    .eq('id', userId)
    .single()

  if (profile?.xend_member_id) return profile.xend_member_id

  // Auto-register this user as an Xend proxy member on first use
  const result = await registerProxyMember(userId)
  const memberId = result.data.memberId

  await supabase
    .from('profiles')
    .update({ xend_member_id: memberId })
    .eq('id', userId)

  return memberId
}

async function runXend(
  supabase: any,
  userId: string,
  type: RampType,
  amount: number,
): Promise<ProviderResult> {
  if (!XEND_CONFIGURED) throw new Error('Xend provider unavailable')

  const xendMemberId = await ensureXendMemberId(supabase, userId)

  const currency = 'USDC'
  await validatePosInvoice(xendMemberId, {
    amount: 0,
    currency,
    fiatAmount: amount,
    fiatCurrency: 'NGN',
  })

  const invoice = await processPosInvoice(xendMemberId, {
    amount: 0,
    currency,
    fiatAmount: amount,
    fiatCurrency: 'NGN',
  })

  const reference = generateRef()
  const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
  const pawaFeeNaira = Math.round((amount * feePercent) / 100)
  const providerFeeNaira = await getNumberSetting(supabase, 'xend_estimated_fee_naira', DEFAULT_XEND_ESTIMATED_FEE)

  const pawaFeeKoboXend = Math.round(pawaFeeNaira * 100)
  await supabase.from('transactions').insert({
    user_id: userId,
    type: type === 'on' ? 'deposit' : 'withdrawal',
    direction: type === 'on' ? 'credit' : 'debit',
    amount_kobo: Math.round(amount * 100),
    platform_fee_kobo: pawaFeeKoboXend,
    description: type === 'on' ? 'Received via Xend Finance' : 'Sent via Xend Finance',
    reference,
    paychant_tx_id: invoice.data.invoiceId,
    status: 'pending',
  })

  await recordPlatformFee(
    supabase,
    userId,
    reference,
    type === 'on' ? 'ramp_onramp' : 'ramp_offramp',
    Math.round(amount * 100),
    pawaFeeKoboXend,
    feePercent,
  )

  if (type === 'off') {
    const debitError = await maybeDebitForWithdrawal(supabase, userId, amount, reference)
    if (debitError) throw new Error('Insufficient USDC balance')
  }

  return {
    provider: 'xend',
    transactionId: invoice.data.invoiceId,
    reference,
    walletAddress: invoice.data.walletAddress,
    depositAddress: invoice.data.walletAddress,
    amount: Math.round(amount),
    currency: invoice.data.currency,
    network: invoice.data.network,
    pawaFee: pawaFeeNaira,
    providerFee: providerFeeNaira,
    totalFee: pawaFeeNaira + providerFeeNaira,
    feePercent,
  }
}

async function runFlipeet(
  request: NextRequest,
  supabase: any,
  userId: string,
  type: RampType,
  amount: number,
  bankCode?: string,
  accountNumber?: string,
): Promise<ProviderResult> {
  if (!FLIPEET_CONFIGURED) throw new Error('Flipeet provider unavailable')

  const reference = generateRef()
  const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
  const pawaFeeNaira = Math.round((amount * feePercent) / 100)
  const providerFeeNaira = await getNumberSetting(
    supabase,
    'flipeet_estimated_fee_naira',
    DEFAULT_FLIPEET_ESTIMATED_FEE,
  )
  const origin = request.nextUrl.origin || 'https://pawasave.xyz'

  const result = type === 'on'
    ? await initializeFlipeetOnRamp({
      amount,
      reference,
      callbackUrl: `${origin}/api/flipeet-webhook`,
      walletAddress: FLIPEET_CUSTODY_ADDRESS,
      holderName: process.env.RAMP_BENEFICIARY_NAME || 'PawaSave Treasury',
    })
    : await initializeFlipeetOffRamp({
      amount,
      reference,
      callbackUrl: `${origin}/api/flipeet-webhook`,
      bankCode: bankCode || '',
      accountNumber: accountNumber || '',
      holderName: process.env.RAMP_BENEFICIARY_NAME || 'PawaSave User',
    })

  const pawaFeeKobo = Math.round(pawaFeeNaira * 100)
  await supabase.from('transactions').insert({
    user_id: userId,
    type: type === 'on' ? 'deposit' : 'withdrawal',
    direction: type === 'on' ? 'credit' : 'debit',
    amount_kobo: Math.round(amount * 100),
    platform_fee_kobo: pawaFeeKobo,
    description: type === 'on' ? 'Received via Flipeet' : 'Sent via Flipeet',
    reference,
    paychant_tx_id: result.reference || null,
    status: 'pending',
  })

  await recordPlatformFee(
    supabase,
    userId,
    reference,
    type === 'on' ? 'ramp_onramp' : 'ramp_offramp',
    Math.round(amount * 100),
    pawaFeeKobo,
    feePercent,
  )

  if (type === 'off') {
    const debitError = await maybeDebitForWithdrawal(supabase, userId, amount, reference)
    if (debitError) throw new Error('Insufficient USDC balance')
  }

  return {
    provider: 'flipeet',
    transactionId: result.reference,
    reference,
    bankName: result.deposit?.bank_name,
    bankCode: result.deposit?.bank_code,
    accountNumber: result.deposit?.account_number,
    accountName: result.deposit?.account_name,
    depositAddress: result.deposit?.address,
    amount: Math.round(amount),
    currency: result.destination?.currency || result.deposit?.asset,
    network: result.destination?.network || process.env.FLIPEET_NETWORK || 'base',
    pawaFee: pawaFeeNaira,
    providerFee: providerFeeNaira,
    totalFee: pawaFeeNaira + providerFeeNaira,
    feePercent,
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getSupabaseUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json()
    const type = body.type as RampType
    const amount = Number(body.amount)
    const bankCode = body.bankCode as string | undefined
    const accountNumber = body.accountNumber as string | undefined
    const transactionPin = body.transactionPin as string | undefined

    if ((type !== 'on' && type !== 'off') || !Number.isFinite(amount) || amount < 100) {
      return NextResponse.json({ error: 'Amount must be at least ₦100' }, { status: 400 })
    }

    if (type === 'off' && (!bankCode || !accountNumber)) {
      return NextResponse.json({ error: 'Bank details required for withdrawal' }, { status: 400 })
    }

    if (type === 'off') {
      const pinError = await ensureWithdrawalPin(supabase, user.id, transactionPin || '')
      if (pinError) return pinError
    }

    const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
    const pawaFee = Math.round((amount * feePercent) / 100)
    const availableProviders: Provider[] = []

    if (FLINT_CONFIGURED) availableProviders.push('flint')
    if (XEND_CONFIGURED) availableProviders.push('xend')
    if (FLIPEET_CONFIGURED) availableProviders.push('flipeet')

    if (availableProviders.length === 0) {
      return NextResponse.json(
        {
          error:
            'No ramp provider is currently configured. Set FLINT_API_KEY in environment variables, or set FLIPEET_API_KEY and FLIPEET_CUSTODY_ADDRESS for Flipeet.',
        },
        { status: 503 },
      )
    }

    const estimatedFlint = pawaFee + calcFlintFees(amount, type)
    const estimatedXend = pawaFee + await getNumberSetting(supabase, 'xend_estimated_fee_naira', DEFAULT_XEND_ESTIMATED_FEE)
    const flipeetRate = FLIPEET_CONFIGURED ? await getFlipeetRate(type).catch(() => null) : null
    const estimatedFlipeet = pawaFee + await getNumberSetting(
      supabase,
      'flipeet_estimated_fee_naira',
      Number(flipeetRate?.rate) > 0 ? 0 : DEFAULT_FLIPEET_ESTIMATED_FEE,
    )

    const orderedProviders = [...availableProviders].sort((a, b) => {
      const feeA = a === 'flint'
        ? estimatedFlint
        : a === 'xend'
          ? estimatedXend
          : estimatedFlipeet
      const feeB = b === 'flint'
        ? estimatedFlint
        : b === 'xend'
          ? estimatedXend
          : estimatedFlipeet
      return feeA - feeB
    })

    const run = async (provider: Provider) => {
      if (provider === 'flint') return runFlint(request, supabase, user.id, type, amount, bankCode, accountNumber)
      if (provider === 'flipeet') return runFlipeet(request, supabase, user.id, type, amount, bankCode, accountNumber)
      return runXend(supabase, user.id, type, amount)
    }

    try {
      const result = await run(orderedProviders[0])
      return NextResponse.json({ ...result, selectedBy: 'best_rate' })
    } catch (primaryErr: any) {
      const fallbackProvider = orderedProviders[1]
      if (!fallbackProvider) {
        const errMsg = formatProviderError(orderedProviders[0], primaryErr)
        console.error('Ramp provider failure', { provider: orderedProviders[0], primaryErr })
        return NextResponse.json({ error: errMsg }, { status: 422 })
      }

      try {
        const result = await run(fallbackProvider)
        return NextResponse.json({ ...result, selectedBy: 'fallback' })
      } catch (fallbackErr: any) {
        const errMsg = formatProviderError(orderedProviders[0], primaryErr)
        console.error('Ramp provider failure', { providers: orderedProviders, primaryErr, fallbackErr })
        return NextResponse.json({ error: errMsg }, { status: 422 })
      }
    }
  } catch (err: any) {
    console.error('Ramp API error:', err)
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
