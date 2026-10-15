import { NextRequest, NextResponse } from 'next/server'
import { demoEnabled } from '@/lib/pss-demo'
import { consoleStatus, simulateCredit, confirmCredit, rejectCredit, postStatement, declareDividend, approveDividend } from '@/lib/pss-console'

/**
 * /api/pss/console — custodian & trustee console for the PSS-1 testnet demo (see lib/pss-console.ts).
 *   GET                                    pool position, settlement queue, pending dividend
 *   POST { action: 'credit', kind }        CSCS credits the pool (trade | transfer_in)
 *   POST { action: 'confirm', id }         custodian confirms and signs; tokens are minted
 *   POST { action: 'reject', id, reason }
 *   POST { action: 'statement', shares }   daily CSCS pool statement
 *   POST { action: 'declare' }             registrar's payment received; issuer declares a dividend
 *   POST { action: 'approve' }             trustee approves; holders are paid
 * Testnet only. Rate-limited per IP.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const hits = new Map<string, { n: number; at: number }>()
function limited(ip: string): boolean {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.at > 3_600_000) { hits.set(ip, { n: 1, at: now }); return false }
  h.n++
  return h.n > 40
}

export async function GET() {
  if (!demoEnabled()) return NextResponse.json({ error: 'The live demo is not configured' }, { status: 503 })
  try {
    return NextResponse.json(await consoleStatus())
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 160) : 'error' }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  if (!demoEnabled()) return NextResponse.json({ error: 'The live demo is not configured' }, { status: 503 })
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (limited(ip)) return NextResponse.json({ error: 'Demo limit reached, please try again later' }, { status: 429 })

  const body = await request.json().catch(() => ({}))
  try {
    switch (body?.action) {
      case 'credit':
        return NextResponse.json(simulateCredit(body.kind === 'transfer_in' ? 'transfer_in' : 'trade'))
      case 'confirm':
        return NextResponse.json(await confirmCredit(String(body.id)))
      case 'reject':
        return NextResponse.json(rejectCredit(String(body.id), String(body.reason || '')))
      case 'statement': {
        const shares = Math.floor(Number(body.shares))
        if (!(shares >= 0 && shares < 1e9)) return NextResponse.json({ error: 'Invalid share count' }, { status: 400 })
        return NextResponse.json(await postStatement(shares))
      }
      case 'declare':
        return NextResponse.json(await declareDividend())
      case 'approve':
        return NextResponse.json(await approveDividend())
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e)
    console.error('[pss-console]', m)
    return NextResponse.json({ error: m.slice(0, 160) }, { status: 400 })
  }
}
