import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { clearSecretsCache } from '@/lib/secrets'

/**
 * POST /api/admin/clear-secrets-cache  { password }
 *
 * Drops this serverless instance's secrets cache so the next sensitive op
 * re-fetches from AWS Secrets Manager (V2-HIGH-02). Use right after rotating a
 * key. NOTE: on Vercel each warm instance caches independently — for a guaranteed
 * cluster-wide rotation, also lower SECRETS_TTL_MS during the rotation window.
 */
export const dynamic = 'force-dynamic'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aa = enc.encode(a)
  const bb = enc.encode(b)
  if (aa.byteLength !== bb.byteLength) return false
  return crypto.timingSafeEqual(aa, bb)
}

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }
  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.password || !timingSafeEqual(body.password, ADMIN_PASSWORD)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  clearSecretsCache()
  return NextResponse.json({ ok: true, cleared: true })
}