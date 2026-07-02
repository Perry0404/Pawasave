import { NextRequest, NextResponse } from 'next/server'
import { isAuthorisedAdmin } from '@/lib/admin-session'
import { custodyAddress, custodyCngnBalance, supplyToLend } from '@/lib/custody'

/**
 * POST /api/admin/supply-idle
 * Admin-only. Supplies idle cNGN sitting in the custody wallet into PawasaveLend.
 * Used to recover deposits whose auto-supply didn't run (e.g. a webhook killed
 * mid-flow). Runs from the server, which holds the custody key — so it works
 * without exposing CUSTODY_PRIVATE_KEY locally.
 *
 * Body: { password?, amountCngn? }  — amountCngn omitted ⇒ supply ALL idle cNGN.
 */
export const maxDuration = 60

export async function POST(request: NextRequest) {
  let body: { password?: string; amountCngn?: number } = {}
  try { body = await request.json() } catch { /* no body */ }

  if (!process.env.ADMIN_PASSWORD || !isAuthorisedAdmin(request, body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const addr = await custodyAddress().catch(() => '(unknown)')
  const free = await custodyCngnBalance().catch(() => 0n) // micro
  const freeCngn = Number(free) / 1e6

  const requested = body.amountCngn && body.amountCngn > 0
    ? BigInt(Math.floor(body.amountCngn * 1e6))
    : free
  const toSupply = requested > free ? free : requested

  if (toSupply <= 0n) {
    return NextResponse.json({
      custodyAddress: addr, freeCngn, supplied: 0,
      note: 'No idle cNGN in the custody wallet to supply.',
    })
  }

  try {
    const { txHash, shares } = await supplyToLend(toSupply)
    return NextResponse.json({
      custodyAddress: addr,
      freeCngnBefore: freeCngn,
      suppliedCngn: Number(toSupply) / 1e6,
      txHash,
      shares: shares.toString(),
    })
  } catch (e: any) {
    // If this fails with "insufficient", the idle cNGN is at a different address
    // than the custody signer — i.e. FLIPEET_CUSTODY_ADDRESS ≠ the signer wallet.
    return NextResponse.json(
      { error: e?.message || 'supply failed', custodyAddress: addr, freeCngn },
      { status: 500 },
    )
  }
}