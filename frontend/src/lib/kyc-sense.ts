/**
 * kyc-sense.ts — server-only seam for Sense (usesense.ai) identity verification.
 *
 * Sense is a "Human Presence Verification" platform: biometric liveness
 * (LiveSense), device/channel trust (DeepSense) and 1:N face uniqueness /
 * anti-dup (MatchSense). It does NOT query the Nigerian BVN/NIN government
 * database — we collect + store the BVN/NIN separately, Sense proves a real,
 * unique, live human is behind the account.
 *
 * Flow (docs: https://api.usesense.ai):
 *   1. server  POST /v1/sessions            (x-api-key)          → session creds
 *   2. client  @usesense/web-sdk captures the biometrics
 *   3. server  verification.completed webhook (HMAC-SHA256)      → the verdict
 *
 * The webhook is the ONLY source of truth for access control — never the SDK's
 * client-side result. Nothing here fakes a pass: if Sense isn't configured the
 * caller returns 503 and the user stays unverified.
 */
import crypto from 'crypto'

const SENSE_BASE = (process.env.USESENSE_BASE_URL || 'https://api.usesense.ai').replace(/\/$/, '')
const API_KEY = process.env.USESENSE_API_KEY || ''
const WEBHOOK_SECRET = process.env.USESENSE_WEBHOOK_SECRET || ''

/** Sense is live only when a server API key is configured. */
export function isSenseConfigured(): boolean {
  return Boolean(API_KEY)
}

/** Environment is derived from the key prefix: pk_ = production, else sandbox. */
export function senseEnvironment(): 'sandbox' | 'production' {
  return API_KEY.startsWith('pk_') ? 'production' : 'sandbox'
}

export interface SenseSession {
  session_id: string
  session_token: string
  nonce: string
  expires_at?: string
  policy?: unknown
  upload?: unknown
  geometric_coherence?: unknown
}

/**
 * Create a verification session server-side. `externalUserId` is echoed back on
 * the webhook so we can map the verdict to the right user. Use 'enrollment' for
 * first-time KYC (also runs the 1:N dedupe so one person can't open many accounts).
 */
export async function createSenseSession(opts: {
  externalUserId: string
  sessionType?: 'enrollment' | 'authentication'
  identityId?: string
  metadata?: Record<string, unknown>
}): Promise<SenseSession> {
  if (!API_KEY) throw new Error('Sense not configured')

  const res = await fetch(`${SENSE_BASE}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      session_type: opts.sessionType || 'enrollment',
      platform: 'web',
      external_user_id: opts.externalUserId,
      ...(opts.identityId ? { identity_id: opts.identityId } : {}),
      metadata: { source: 'pawasave_kyc', ...(opts.metadata || {}) },
    }),
  })

  const data = await res.json().catch(() => ({} as any))
  if (!res.ok || !data?.session_id) {
    const raw = data?.error ?? data?.message ?? `Sense session failed (${res.status})`
    const msg = typeof raw === 'string' ? raw : JSON.stringify(raw)
    throw new Error(msg)
  }
  return data as SenseSession
}

/** APPROVE → verified · REJECT → rejected · MANUAL_REVIEW/anything → submitted (pending review). */
export function mapSenseDecision(decision?: string): 'verified' | 'rejected' | 'submitted' {
  if (decision === 'APPROVE') return 'verified'
  if (decision === 'REJECT') return 'rejected'
  return 'submitted'
}

/** Verify the HMAC-SHA256 webhook signature over the raw body (header may be `sha256=…`). */
export function verifySenseWebhook(rawBody: string, signatureHeader: string | null): boolean {
  if (!WEBHOOK_SECRET || !signatureHeader) return false
  const provided = signatureHeader.replace(/^sha256=/i, '').trim()
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
  try {
    const a = Buffer.from(provided, 'hex')
    const b = Buffer.from(expected, 'hex')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}