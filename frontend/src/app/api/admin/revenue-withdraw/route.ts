import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'
import { initializeFlipeetOffRamp, FlipeetApiError } from '@/lib/flipeet'
import { sendCngn, custodyCngnBalance } from '@/lib/custody'

/** Flipeet rejects names with non-alphanumerics — strip accents/punctuation. */
function sanitizeBeneficiaryName(name: string): string {
  return (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const FLIPEET_CONFIGURED = Boolean(
  process.env.FLIPEET_API_KEY && (process.env.FLIPEET_CUSTODY_ADDRESS || process.env.RAMP_CUSTODY_ADDRESS),
)

/**
 * Withdraw retained platform revenue (real cNGN sitting in custody from ramp fees) to
 * a bank account via Flipeet — the SAME working off-ramp rail users use. The old flow
 * used Flint, which is disabled, so revenue was effectively un-withdrawable. Revenue is
 * genuinely backed now that the ramp gross-up retains the fee cNGN in custody.
 */
export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 503 })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })
  }
  if (!FLIPEET_CONFIGURED) {
    return NextResponse.json({ error: 'Flipeet off-ramp not configured' }, { status: 503 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { password, amountNaira, bankCode, accountNumber, holderName } = body

  if (!isAuthorisedAdmin(request, password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!amountNaira || typeof amountNaira !== 'number' || amountNaira < 1000) {
    return NextResponse.json({ error: 'Minimum withdrawal is ₦1,000' }, { status: 400 })
  }
  if (!bankCode || !accountNumber) {
    return NextResponse.json({ error: 'bankCode and accountNumber are required' }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  // Check the withdrawable revenue counter.
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'platform_revenue_kobo')
    .single()

  const revenueKobo = Number(setting?.value || 0)
  const requestedKobo = Math.round(amountNaira * 100)

  if (requestedKobo > revenueKobo) {
    return NextResponse.json({
      error: `Insufficient revenue balance. Available: ₦${(revenueKobo / 100).toLocaleString()}`,
    }, { status: 400 })
  }

  const reference = 'admin_rev_' + crypto.randomBytes(12).toString('hex')
  const origin = request.nextUrl.origin || 'https://pawasave.xyz'
  const cngnMicro = BigInt(Math.floor(amountNaira * 1_000_000)) // 1 NGN = 1 cNGN

  // Confirm custody actually holds the cNGN before initiating anything.
  const available = await custodyCngnBalance()
  if (available < cngnMicro) {
    return NextResponse.json({
      error: `Revenue not fully settled in custody yet (have ₦${(Number(available) / 1e6).toLocaleString()}). Try a smaller amount.`,
    }, { status: 400 })
  }

  // Initialise the Flipeet off-ramp to get a deposit address.
  let result
  try {
    result = await initializeFlipeetOffRamp({
      amount: Math.round(amountNaira),
      reference,
      callbackUrl: `${origin}/api/flipeet-webhook${process.env.FLIPEET_WEBHOOK_TOKEN ? `?token=${encodeURIComponent(process.env.FLIPEET_WEBHOOK_TOKEN)}` : ''}`,
      bankCode,
      accountNumber,
      holderName: sanitizeBeneficiaryName(holderName || 'PawaSave Treasury') || 'PawaSave Treasury',
    })
  } catch (e) {
    const msg = e instanceof FlipeetApiError ? e.message : 'Off-ramp init failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const depositAddress = result.deposit?.address
  if (!depositAddress) {
    return NextResponse.json({ error: 'Off-ramp failed — no settlement address returned.' }, { status: 502 })
  }

  // Send cNGN from custody to Flipeet's address. Only AFTER a successful broadcast do we
  // decrement the revenue counter — so a failed send never loses the revenue record.
  let txHash: string
  try {
    txHash = await sendCngn(depositAddress, cngnMicro)
  } catch (e) {
    console.error('[revenue-withdraw] custody send failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'On-chain settlement failed — no revenue was withdrawn.' }, { status: 502 })
  }

  await supabase
    .from('platform_settings')
    .update({ value: (revenueKobo - requestedKobo).toString() })
    .eq('key', 'platform_revenue_kobo')

  await supabase.from('platform_fees').insert({
    user_id: '00000000-0000-0000-0000-000000000000', // sentinel for admin withdrawals
    transaction_ref: reference,
    fee_type: 'admin_revenue_withdrawal',
    gross_amount_kobo: requestedKobo,
    fee_amount_kobo: -requestedKobo, // negative = outgoing revenue
    fee_percent: 0,
  }).maybeSingle() // tolerate if fee_type check constraint is strict

  return NextResponse.json({ ok: true, reference, amountNaira, txHash })
}
