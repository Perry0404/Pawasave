import { NextRequest, NextResponse } from 'next/server'
import { isAuthorisedAdmin } from '@/lib/admin-session'
import { custodyAddress, custodyCngnBalance, supplyToLend } from '@/lib/custody'
import { withLease, LeaseUnavailableError } from '@/lib/custody-lease'

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

  try {
    // Read the balance inside the lease. Reading first and supplying after leaves room
    // for a cron to move the balance in between.
    const result = await withLease('custody:signer', async () => {
      const free = await custodyCngnBalance().catch(() => 0n) // micro
      const requested = body.amountCngn && body.amountCngn > 0
        ? BigInt(Math.floor(body.amountCngn * 1e6))
        : free
      const toSupply = requested > free ? free : requested

      if (toSupply <= 0n) {
        return {
          custodyAddress: addr, freeCngn: Number(free) / 1e6, supplied: 0,
          note: 'No idle cNGN in the custody wallet to supply.',
        }
      }

      const { txHash, shares } = await supplyToLend(toSupply)
      return {
        custodyAddress: addr,
        freeCngnBefore: Number(free) / 1e6,
        suppliedCngn: Number(toSupply) / 1e6,
        txHash,
        shares: shares.toString(),
      }
    }, { holder: 'admin/supply-idle', waitMs: 5000 })

    return NextResponse.json(result)
  } catch (e: any) {
    if (e instanceof LeaseUnavailableError) {
      // 'held' is worth retrying, 'unavailable' means the lease itself is broken.
      const status = e.reason === 'held' ? 409 : 503
      return NextResponse.json({ error: e.message, custodyAddress: addr }, { status })
    }
    // "insufficient" here means the idle cNGN sits at a different address than the
    // signer, so FLIPEET_CUSTODY_ADDRESS is not the signer wallet.
    return NextResponse.json(
      { error: e?.message || 'supply failed', custodyAddress: addr },
      { status: 500 },
    )
  }
}