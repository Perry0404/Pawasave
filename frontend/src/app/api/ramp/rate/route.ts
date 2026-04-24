import { NextResponse } from 'next/server'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''

export async function GET() {
  const rate = await getNgnUsdRateFromFlint(FLINT_API_KEY)
  return NextResponse.json({ rate })
}
