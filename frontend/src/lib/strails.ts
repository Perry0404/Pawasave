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

/**
 * Strails allowlists a single caller IP, but Vercel egresses from a rotating pool
 * (proven: a registered IP still got IP_NOT_ALLOWED on the next call). So in
 * production we route through strails-relay, a fixed-IP hop that holds the API key.
 * When STRAILS_RELAY_SECRET is set, STRAILS_BASE_URL points at the relay and we
 * authenticate to it instead of sending the Strails key from here.
 */
const RELAY_SECRET = process.env.STRAILS_RELAY_SECRET || ''

async function call<T = any>(path: string, body?: unknown, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  if (!KEY && !RELAY_SECRET) throw new StrailsError('STRAILS_API_KEY not configured', 0)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (RELAY_SECRET) headers['x-relay-secret'] = RELAY_SECRET
  else headers['x-api-key'] = KEY
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
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

export type OnboardResult = { requestId?: string; userHash?: string; status?: string }

/**
 * Start BVN onboarding. Strails verifies the BVN against the national database and
 * asynchronously issues the permanent NUBAN (~2 min).
 *
 * IMPORTANT (confirmed live): Strails does NOT adopt the `userId` we pass — it mints
 * its own identity, returned as `userHash`, and every later call (`getuserdetails`)
 * and webhook keys off THAT. Store it as profiles.strails_user_id. Passing our own id
 * and expecting it back is the bug this comment exists to prevent.
 */
export async function onboardUser(input: {
  bvn: string
  userId: string
  email?: string
  phoneNumber?: string
  firstName?: string
  lastName?: string
}): Promise<OnboardResult> {
  const d = await call('/onboarduser', input)
  return {
    requestId: pick(d, 'requestId', 'request_id'),
    userHash: pick(d, 'userHash', 'user_hash'),
    status: pick(d, 'status'), // "processing"
  }
}

/**
 * Poll onboarding. Returns `verified` and, once complete, `strailsUserId` — which is
 * the same value as `userHash` above. (Webhook `user.onboarded` is the primary signal;
 * this is the fallback / reconciliation path.)
 */
export async function onboardStatus(requestId: string): Promise<{
  status?: string
  verified: boolean
  strailsUserId?: string
  raw: any
}> {
  const d = await call('/onboardstatus', { requestId })
  return {
    status: pick(d, 'status'), // requested | completed
    verified: (d as any)?.verified === true,
    strailsUserId: pick(d, 'userId', 'user_id'),
    raw: d,
  }
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

/**
 * Fetch a user's details + permanent virtual account.
 * `userId` here is Strails' own id (the `userHash`) — NOT our Supabase uuid, which
 * returns "Invalid user credentials for fintech". A `bvn` is also accepted.
 * Confirmed shape: data.virtualAccounts[0], data.walletDetails.evmWallet.
 */
export async function getUserDetails(strailsUserId: string): Promise<{
  strailsUserId?: string
  account: VirtualAccount
  evmWallet?: string
  fullName?: string
  raw: any
}> {
  const d = await call('/getuserdetails', { userId: strailsUserId })
  const p = (d as any)?.personalDetails ?? {}
  const name = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ') || undefined
  return {
    strailsUserId: pick(d, 'userId', 'user_id'),
    account: parseVirtualAccount(d),
    // The Base wallet the minted cNGN lands in — needed for any future sweep.
    evmWallet: pick((d as any)?.walletDetails ?? {}, 'evmWallet', 'evm_wallet'),
    fullName: name,
    raw: d,
  }
}

/** The fintech's own permanent funding account (read-only sanity check). */
export async function getFintechVirtualAccount(): Promise<VirtualAccount> {
  return parseVirtualAccount(await call('/getfintechvirtualaccount', undefined, 'GET'))
}

// ── Sweep: move a user's minted cNGN into PawaSave custody ─────────────────────
// Confirmed working live (tx 0xf171c7ed…, 0xd9648e46…): Strails charges NO fee for
// this; you pay only Base gas. Their response warns "High gas fees relative to
// withdrawal amount", so sweep on a THRESHOLD, never per-deposit.

/** Whitelist a destination address. Required before withdrawAsset will send to it. */
export async function addExternalWallet(input: {
  address: string
  label: string
  blockchain?: string
  type?: 'hot' | 'cold' | 'custodial' | 'other'
}): Promise<any> {
  return call('/addexternalwallet', {
    blockchain: 'Base', type: 'custodial', ...input,
  })
}

/**
 * Move cNGN from a user's Strails wallet to an external (whitelisted) address.
 * `internalWallet` is the SOURCE — the user's own EVM wallet from getUserDetails.
 */
export async function withdrawAsset(input: {
  internalWallet: string
  userId: string
  destinationWallet: string
  amount: number
  ticker?: string
  network?: string
}): Promise<{ txHash?: string; amount?: string; raw: any }> {
  const d = await call('/withdrawasset', { ticker: 'CNGN', network: 'Base', ...input })
  return { txHash: pick(d, 'transactionHash', 'txHash'), amount: pick(d, 'amount'), raw: d }
}

/** Recent Strails activity — the reconciliation source when a webhook is missed. */
export async function listTransactions(): Promise<any[]> {
  const d = await call('/transactions', undefined, 'GET')
  const list = (d as any)?.transactions ?? d
  return Array.isArray(list) ? list : []
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
export function verifyStrailsWebhook(
  rawBody: string,
  signature: string | null,
  timestamp?: string | null,
): { ok: boolean; matched?: string } {
  if (!signature) return { ok: false }
  const sig = signature.trim().replace(/^sha256=/i, '')

  // Strails documents "hex-hmac" in X-Strails-Signature but never says which secret
  // signs it or what is signed. Rather than guess one combination, try the realistic
  // matrix once and report which matched, so it can be pinned afterwards.
  const keys: Array<[string, Buffer]> = []
  const add = (label: string, raw?: string) => {
    if (!raw) return
    keys.push([`${label}:utf8`, Buffer.from(raw, 'utf8')])
    if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
      keys.push([`${label}:hexbytes`, Buffer.from(raw, 'hex')]) // 64-char hex is 32 raw bytes
    }
  }
  add('webhookSecret', process.env.STRAILS_WEBHOOK_SECRET)
  add('aesKey', process.env.STRAILS_AES_KEY)
  add('apiKey', process.env.STRAILS_API_KEY)

  const payloads: Array<[string, string]> = [['body', rawBody]]
  if (timestamp) {
    payloads.push(['ts.body', `${timestamp}.${rawBody}`], ['ts+body', `${timestamp}${rawBody}`])
  }

  for (const [kLabel, key] of keys) {
    for (const [pLabel, payload] of payloads) {
      for (const enc of ['hex', 'base64'] as const) {
        const expected = crypto.createHmac('sha256', key).update(payload, 'utf8').digest(enc)
        if (expected.length === sig.length &&
            crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
          return { ok: true, matched: `${kLabel} | ${pLabel} | ${enc}` }
        }
      }
    }
  }
  return { ok: false }
}