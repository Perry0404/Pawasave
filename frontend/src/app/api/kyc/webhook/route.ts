import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifySenseWebhook, mapSenseDecision } from '@/lib/kyc-sense'

/**
 * POST /api/kyc/webhook
 * Sense's authoritative verdict delivery. HMAC-SHA256 signed (x-usesense-signature)
 * over the raw body. This is the ONLY place a user is moved to verified/rejected.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text()
  const signature = request.headers.get('x-usesense-signature')
  const timestamp = request.headers.get('x-usesense-timestamp')

  if (!verifySenseWebhook(raw, signature)) {
    console.error('[kyc-webhook] signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Reject stale webhooks (replay protection) when a timestamp is provided.
  if (timestamp) {
    const t = new Date(timestamp).getTime()
    if (Number.isFinite(t) && Math.abs(Date.now() - t) > 300_000) {
      return NextResponse.json({ error: 'Stale timestamp' }, { status: 401 })
    }
  }

  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const event = body?.event
  const payload = body?.payload || {}
  console.info('[kyc-webhook] event:', event, 'session:', payload?.session_id)

  // Only the completed verdict changes KYC state; ack everything else.
  if (event !== 'verification.completed') {
    return NextResponse.json({ ok: true, ignored: event || 'unknown' })
  }

  const externalUserId: string | undefined = payload.external_user_id
  const decision: string | undefined = payload.decision
  if (!externalUserId) {
    return NextResponse.json({ error: 'Missing external_user_id' }, { status: 400 })
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Webhook service key not configured' }, { status: 503 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const status = mapSenseDecision(decision)
  const reason = Array.isArray(payload.reasons) ? payload.reasons.join('; ').slice(0, 500) : null

  const { error } = await admin.rpc('finalize_kyc', {
    p_user_id: externalUserId,
    p_status: status,
    p_provider: 'sense',
    p_session_id: payload.session_id || null,
    p_identity_id: payload.identity_id || null,
    p_decision: decision || null,
    p_reason: reason,
  })

  if (error) {
    console.error('[kyc-webhook] finalize_kyc failed:', error.message)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, status })
}