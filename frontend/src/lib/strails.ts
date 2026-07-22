/**
 * strails.ts — client for the Strails (Stablesrail) API.
 *
 * Strails issues each verified user a PERMANENT dedicated Naira virtual account
 * (NUBAN); NGN sent to it auto-mints cNGN. We use it as the naira on-ramp +
 * permanent-account layer.
 *
 * Facts established by probing the live sandbox (do not re-derive):
 *  - Auth is a single `x-api-key` header; bodies/responses are PLAIN JSON (the
 *    issued aesKey is NOT used for request/response — reserved, likely webhooks).
 *  - The issued key is a SANDBOX key: valid on beta.stablesrail.io, 401 on prod.
 *  - Every call must come from a PRE-ALLOWLISTED server IP (/manageipallowlist),
 *    so this must run from a fixed-egress path (Vercel dedicated IP).
 *  - Failures come back HTTP 4xx with `{ status: "Failed", response_code, message }`.
 *
 * Response FIELD NAMES below are read defensively (multiple candidates) because the
 * docs don't pin them down — validate against sandbox once egress is allowlisted.
 * Gated by STRAILS_ENABLED so nothing activates until tested.
 */
import crypto from 'crypto'

const BASE = (process.env.STRAILS_BASE_URL || 'https://beta.stablesrail.io/v1').replace(/\/$/, '')
const KEY = process.env.STRAILS_API_KEY || ''

/** Master switch — the whole integration stays dark until this is 'true'. */
export const STRAILS_ENABLED = process.env.STRAILS_ENABLED === 'true' && Boolean(KEY)

export class StrailsError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message)
    this.name = 'StrailsError'
  }
}

/** Read the first present, non-empty field from a list of candidate names. */
function pick(obj: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && String(v).length) return String(v)
  }
  return undefined
}

async function call<T = any>(path: string, body?: unknown, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  if (!KEY) throw new StrailsError('STRAILS_API_KEY not configured', 0)
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(25_000),
    })
  } catch (e) {
    throw new StrailsError(e instanceof Error ? e.message : 'network error', 0)
  }
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  // Strails signals business failures with { status: "Failed" } even on some 200s.
  if (!res.ok || /failed/i.test(String(json?.status ?? ''))) {
    throw new StrailsError(pick(json, 'message', 'error') || `HTTP ${res.status}`, res.status, json)
  }
  // Successful bodies are wrapped as { ..., data: {...} } in the docs' examples.
  return (json?.data ?? json) as T
}

// ── Onboarding (BVN → permanent virtual account) ───────────────────────────────

export type OnboardResult = { requestId?: string; userId?: string; status?: string }

/** Start BVN onboarding. Strails verifies the BVN and (async) issues the NUBAN. */
export async function onboardUser(input: {
  bvn: string
  userId: string          // our Supabase user id — echoed back on webhooks
  email?: string
  phoneNumber?: string
  firstName?: string
  lastName?: string
}): Promise<OnboardResult> {
  const d = await call('/onboarduser', input)
  return { requestId: pick(d, 'requestId', 'request_id', 'id'), userId: pick(d, 'userId', 'user_id'), status: pick(d, 'status') }
}

/** Poll onboarding status (webhook `user.onboarded` is the primary signal). */
export async function onboardStatus(requestId: string): Promise<OnboardResult & { raw: any }> {
  const d = await call('/onboardstatus', { requestId })
  return { requestId, userId: pick(d, 'userId', 'user_id'), status: pick(d, 'status'), raw: d }
}

export type VirtualAccount = { accountNumber?: string; accountName?: string; bankName?: string }

function parseVirtualAccount(d: any): VirtualAccount {
  // The account can arrive flat, nested under virtualAccount(s), or as the 1st of an array.
  const va = d?.virtualAccount ?? (Array.isArray(d?.virtualAccounts) ? d.virtualAccounts[0] : d?.virtualAccounts) ?? d
  return {
    accountNumber: pick(va, 'accountNumber', 'account_number', 'nuban', 'number'),
    accountName: pick(va, 'accountName', 'account_name'),
    bankName: pick(va, 'bankName', 'bank_name', 'bank'),
  }
}

/** Fetch a user's details including their permanent virtual account. */
export async function getUserDetails(userId: string): Promise<{ strailsUserId?: string; account: VirtualAccount; raw: any }> {
  const d = await call('/getuserdetails', { userId })
  return { strailsUserId: pick(d, 'userId', 'user_id', 'id'), account: parseVirtualAccount(d), raw: d }
}

/** The fintech's own permanent funding account (read-only sanity check). */
export async function getFintechVirtualAccount(): Promise<VirtualAccount> {
  return parseVirtualAccount(await call('/getfintechvirtualaccount', undefined, 'GET'))
}

// ── Off-ramp (cNGN → NGN bank payout) ──────────────────────────────────────────

export async function cngnOfframp(input: {
  userId: string
  amount: number          // NGN
  accountNumber: string
  bankCode: string
  ticker?: string         // default CNGN
}): Promise<{ reference?: string; status?: string; raw: any }> {
  const d = await call('/cngnofframp', { ticker: 'CNGN', ...input })
  return { reference: pick(d, 'reference', 'requestId', 'id'), status: pick(d, 'status'), raw: d }
}

// ── Webhook verification ───────────────────────────────────────────────────────

/**
 * Verify a Strails webhook. Signature arrives as a hex HMAC-SHA256 in
 * `X-Strails-Signature` over the RAW request body. The signing secret is not
 * documented; we try the configured webhook secret, then the aesKey, then the
 * apiKey. Compute against the raw body EXACTLY as received (do not re-stringify).
 */
export function verifyStrailsWebhook(rawBody: string, signature: string | null): boolean {
  if (!signature) return false
  const secrets = [
    process.env.STRAILS_WEBHOOK_SECRET,
    process.env.STRAILS_AES_KEY,
    process.env.STRAILS_API_KEY,
  ].filter((s): s is string => Boolean(s))
  const sig = signature.trim().toLowerCase().replace(/^sha256=/, '')
  for (const secret of secrets) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
    if (expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return true
    }
  }
  return false
}