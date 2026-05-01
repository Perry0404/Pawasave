import { NextResponse } from 'next/server'

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'

/** Try Flint's banks endpoint first; fall back to Paystack's public list */
export async function GET() {
  // 1. Try Flint
  if (FLINT_API_KEY) {
    try {
      const res = await fetch(`${FLINT_BASE}/ramp/banks`, {
        headers: { 'x-api-key': FLINT_API_KEY },
        next: { revalidate: 3600 }, // cache 1 hour
      })
      if (res.ok) {
        const data = await res.json()
        const raw: any[] = data.data || data.banks || data.result || []
        if (raw.length > 0) {
          const banks = raw
            .filter((b: any) => (b.name || b.bankName) && (b.code || b.bankCode))
            .map((b: any) => ({
              name: b.name || b.bankName,
              code: b.code || b.bankCode,
            }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name))
          if (banks.length > 0) return NextResponse.json({ banks, source: 'flint' })
        }
      }
    } catch {
      // fall through to Paystack
    }
  }

  // 2. Paystack public banks API (no auth required)
  try {
    const res = await fetch(
      'https://api.paystack.co/bank?country=nigeria&perPage=200&use_cursor=false',
      { next: { revalidate: 3600 } },
    )
    if (res.ok) {
      const data = await res.json()
      const raw: any[] = data.data || []
      const banks = raw
        .filter((b: any) => b.name && b.code)
        .map((b: any) => ({ name: b.name, code: b.code }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
      if (banks.length > 0) return NextResponse.json({ banks, source: 'paystack' })
    }
  } catch {
    // fall through to hardcoded
  }

  // 3. Hardcoded major Nigerian banks as last resort
  return NextResponse.json({
    source: 'fallback',
    banks: [
      { name: 'Access Bank', code: '044' },
      { name: 'Citibank Nigeria', code: '023' },
      { name: 'Ecobank Nigeria', code: '050' },
      { name: 'Fidelity Bank', code: '070' },
      { name: 'First Bank of Nigeria', code: '011' },
      { name: 'First City Monument Bank (FCMB)', code: '214' },
      { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
      { name: 'Heritage Bank', code: '030' },
      { name: 'Keystone Bank', code: '082' },
      { name: 'Kuda Bank', code: '090267' },
      { name: 'Moniepoint MFB', code: '50515' },
      { name: 'OPay', code: '100004' },
      { name: 'Palmpay', code: '999991' },
      { name: 'Polaris Bank', code: '076' },
      { name: 'Providus Bank', code: '101' },
      { name: 'Stanbic IBTC Bank', code: '221' },
      { name: 'Standard Chartered Bank', code: '068' },
      { name: 'Sterling Bank', code: '232' },
      { name: 'Titan Trust Bank', code: '102' },
      { name: 'Union Bank of Nigeria', code: '032' },
      { name: 'United Bank for Africa (UBA)', code: '033' },
      { name: 'Unity Bank', code: '215' },
      { name: 'VFD Microfinance Bank', code: '566' },
      { name: 'Wema Bank', code: '035' },
      { name: 'Zenith Bank', code: '057' },
    ].sort((a, b) => a.name.localeCompare(b.name)),
  })
}

