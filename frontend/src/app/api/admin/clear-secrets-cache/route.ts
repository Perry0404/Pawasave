import { NextRequest, NextResponse } from 'next/server'
import { clearSecretsCache } from '@/lib/secrets'
import { isAuthorisedAdmin } from '@/lib/admin-session'

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

export async function POST(request: NextRequest) {
  if (!ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Admin password not configured' }, { status: 503 })
  }
  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  if (!isAuthorisedAdmin(request, body.password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  clearSecretsCache()
  return NextResponse.json({ ok: true, cleared: true })
}