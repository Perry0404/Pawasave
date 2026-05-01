import { NextRequest, NextResponse } from 'next/server'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

// Temporary debug endpoint — remove after confirming env var is set
export async function GET() {
  return NextResponse.json({
    configured: !!ADMIN_PASSWORD,
    length: ADMIN_PASSWORD.length,
    firstChar: ADMIN_PASSWORD[0] ?? null,
    lastChar: ADMIN_PASSWORD[ADMIN_PASSWORD.length - 1] ?? null,
  })
}

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }

  const body = await request.json()
  const { password } = body

  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Password required' }, { status: 400 })
  }

  // Constant-time comparison to prevent timing attacks
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

  return NextResponse.json({ ok: true })
}
