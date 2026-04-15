import { NextResponse } from 'next/server'

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'

export async function GET() {
  try {
    const res = await fetch(`${FLINT_BASE}/ramp/banks`, {
      headers: { 'x-api-key': FLINT_API_KEY },
    })
    const data = await res.json()

    if (!res.ok) {
      return NextResponse.json({ banks: [] }, { status: 200 })
    }

    const banks = (data.data || data.banks || []).map((b: any) => ({
      name: b.name || b.bankName,
      code: b.code || b.bankCode,
    }))

    return NextResponse.json({ banks })
  } catch {
    return NextResponse.json({ banks: [] })
  }
}
