import { NextRequest, NextResponse } from 'next/server'
import { xendRequest } from '@/lib/xend'
import type { ProxyMemberResult } from '@/lib/xend'

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

  // Check XEND credentials are configured
  const xendConfigured = !!(process.env.XEND_MERCHANT_ID && process.env.XEND_API_KEY && process.env.XEND_PRIVATE_KEY)
  if (!xendConfigured) {
    return NextResponse.json({ error: 'XEND credentials not configured in Vercel env vars (XEND_MERCHANT_ID, XEND_API_KEY, XEND_PRIVATE_KEY)' }, { status: 503 })
  }

  try {
    // XEND requires externalProxyMemberUniqueId to be a valid UUID
    const result = await xendRequest<ProxyMemberResult>(
      'POST',
      '/api/Merchant/proxymember/add',
      {
        externalProxyMemberUniqueId: '00000000-0000-0000-0000-esusupool0001',
        firstName: 'Esusu',
        lastName: 'Pool',
        requestTime: Date.now(),
      },
    )

    const memberId = result.data.memberId
    return NextResponse.json({
      success: true,
      memberId,
      raw: result,
      message: `Set XEND_ESUSU_POOL_MEMBER_ID=${memberId} in your Vercel env vars`,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    // Return the full error message from XEND to help diagnose
    return NextResponse.json({ error: message, hint: 'Check Vercel function logs for full XEND response. Ensure XEND_MERCHANT_ID, XEND_API_KEY, XEND_PRIVATE_KEY are set in Vercel.' }, { status: 500 })
  }
}
