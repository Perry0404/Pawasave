import { NextRequest, NextResponse } from 'next/server'
import { STRAILS_ENABLED, previewOnrampFeeNgn } from '@/lib/strails'
import { estimateStrailsOnrampFeeNgn, STRAILS_ONRAMP_ESTIMATE_PERCENT } from '@/lib/strails-fees'

/**
 * GET /api/strails/fee-preview?amount=10000 — the bank partner's fee on a naira deposit, for the
 * "you'll receive" line on the deposit screen. Asks Strails for the exact tiered fee; falls back
 * to an estimate (flagged `estimate: true`) if Strails is off or unreachable. Cached briefly.
 */
export const dynamic = 'force-dynamic'

const cache = new Map<number, { at: number; body: object }>()

export async function GET(request: NextRequest) {
  const amount = Math.floor(Number(request.nextUrl.searchParams.get('amount')))
  if (!(amount > 0 && amount <= 100_000_000)) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  const hit = cache.get(amount)
  if (hit && Date.now() - hit.at < 10 * 60_000) return NextResponse.json(hit.body)

  let body: object = { amount, feeNgn: estimateStrailsOnrampFeeNgn(amount), percent: STRAILS_ONRAMP_ESTIMATE_PERCENT, estimate: true }
  if (STRAILS_ENABLED) {
    try {
      const p = await previewOnrampFeeNgn(amount)
      if (p) body = { amount, feeNgn: p.feeNgn, percent: p.percent, estimate: false }
    } catch { /* keep the estimate */ }
  }
  cache.set(amount, { at: Date.now(), body })
  if (cache.size > 500) cache.clear()
  return NextResponse.json(body)
}
