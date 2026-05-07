import { NextRequest, NextResponse } from 'next/server'
import { registerProxyMember } from '@/lib/xend'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }

  const body = await request.json()
  const { password } = body

  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Password required' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const a = encoder.encode(password)
  const b = encoder.encode(ADMIN_PASSWORD)

  if (a.byteLength !== b.byteLength) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  const crypto = await import('crypto')
  const match = crypto.timingSafeEqual(a, b)
  if (!match) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  try {
    const result = await registerProxyMember('pawasave-esusu-pool', {
      firstName: 'Esusu',
      lastName: 'Pool',
      email: 'esusu-pool@pawasave.internal',
    })

    const memberId = result.data.memberId
    return NextResponse.json({
      success: true,
      memberId,
      message: `Set XEND_ESUSU_POOL_MEMBER_ID=${memberId} in your Vercel env vars`,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
