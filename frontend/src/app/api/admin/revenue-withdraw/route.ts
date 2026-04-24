import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  if (ba.byteLength !== bb.byteLength) return false
  return crypto.timingSafeEqual(ba, bb)
}

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 503 })
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })
  }
  if (!FLINT_API_KEY) {
    return NextResponse.json({ error: 'Flint not configured' }, { status: 503 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { password, amountNaira, bankCode, accountNumber } = body

  if (!password || !timingSafeEqual(password, ADMIN_PASSWORD)) {
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

  // Check platform revenue balance
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

  // Initiate Flint off-ramp
  const reference = 'admin_rev_' + crypto.randomBytes(12).toString('hex')
  const origin = request.nextUrl.origin || 'https://pawasave.xyz'

  const flintRes = await fetch(`${FLINT_BASE}/ramp/initialise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': FLINT_API_KEY },
    body: JSON.stringify({
      type: 'off',
      reference,
      network: 'base',
      amount: Math.round(amountNaira),
      notifyUrl: `${origin}/api/webhook`,
      destination: { bankCode, accountNumber },
    }),
  })

  const flintData = await flintRes.json()
  if (!flintRes.ok || flintData.status === 'error') {
    const msg = flintData.message || flintData.error || 'Off-ramp failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  // Deduct from platform revenue balance
  await supabase
    .from('platform_settings')
    .update({ value: (revenueKobo - requestedKobo).toString() })
    .eq('key', 'platform_revenue_kobo')

  // Log the revenue withdrawal
  const rate = await getNgnUsdRateFromFlint(FLINT_API_KEY)
  const usdcMicro = Math.floor((amountNaira / rate) * 1_000_000)
  await supabase.from('platform_fees').insert({
    user_id: '00000000-0000-0000-0000-000000000000', // sentinel for admin withdrawals
    transaction_ref: reference,
    fee_type: 'admin_revenue_withdrawal',
    gross_amount_kobo: requestedKobo,
    fee_amount_kobo: -requestedKobo, // negative = outgoing revenue
    fee_percent: 0,
  }).maybeSingle() // tolerate if fee_type check constraint is strict

  return NextResponse.json({
    ok: true,
    reference,
    amountNaira,
    bankDetails: flintData.data,
  })
}
