import { NextRequest, NextResponse } from 'next/server'
import { ethers } from 'ethers'
import { demoEnabled, onboard, buy, transferIn, settle } from '@/lib/pss-demo'

/**
 * POST /api/pss/demo   { action: 'onboard' | 'buy' | 'transfer_in' | 'settle', address, quantity?, id? }
 *
 * Testnet-only demo of the PSS-1 NGX token (see lib/pss-demo.ts). Rate-limited per IP so the
 * demo key's test ETH isn't drained.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const hits = new Map<string, { n: number; at: number }>()
function limited(ip: string): boolean {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.at > 3_600_000) { hits.set(ip, { n: 1, at: now }); return false }
  h.n++
  return h.n > 30
}

export async function POST(request: NextRequest) {
  if (!demoEnabled()) return NextResponse.json({ error: 'The live demo is not configured' }, { status: 503 })
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (limited(ip)) return NextResponse.json({ error: 'Demo limit reached, please try again later' }, { status: 429 })

  const body = await request.json().catch(() => ({}))
  const address = String(body?.address || '')
  if (!ethers.isAddress(address)) return NextResponse.json({ error: 'Invalid address' }, { status: 400 })

  try {
    switch (body?.action) {
      case 'onboard':
        return NextResponse.json(await onboard(address))
      case 'buy':
      case 'transfer_in': {
        const q = Math.floor(Number(body.quantity))
        if (!(q >= 1 && q <= 50)) return NextResponse.json({ error: 'Between 1 and 50 shares' }, { status: 400 })
        return NextResponse.json(await (body.action === 'buy' ? buy : transferIn)(address, q))
      }
      case 'settle': {
        const id = Math.floor(Number(body.id))
        if (!(id >= 0)) return NextResponse.json({ error: 'Invalid redemption' }, { status: 400 })
        return NextResponse.json(await settle(id, address))
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    console.error('[pss-demo]', m)
    const reason = m.match(/execution reverted:\s*"?([^"\n(]+)/)?.[1]?.trim()
    return NextResponse.json({ error: reason ? `Contract: ${reason}` : m.slice(0, 160) }, { status: 400 })
  }
}
