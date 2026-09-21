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
 *    so this runs from the VPS's fixed egress IP (49.12.35.192), registered there.
 *  - Failures come back HTTP 4xx with `{ status: "Failed", response_code, message }`.
 *
 * Response FIELD NAMES below are read defensively (multiple candidates) because the
 * docs don't pin them down — validate against sandbox once egress is allowlisted.
 * Gated by STRAILS_ENABLED so nothing activates until tested.
 */
import crypto from 'crypto'

const RAW_BASE = (process.env.STRAILS_BASE_URL || '').replace(/\/$/, '')
// Strails API base. We call Strails DIRECTLY from the VPS's fixed, allowlisted egress IP — the
// old Render relay is retired. If STRAILS_BASE_URL still points at that relay host
// (…onrender.com), ignore it and go direct: otherwise we'd send our x-api-key to the relay
// (which speaks x-relay-secret) and 401 every call. Set it to the prod base (api.strails.io/v1)
// when prod keys are issued — any non-relay URL is honoured as-is.
const BASE = (!RAW_BASE || /onrender\.com/i.test(RAW_BASE)) ? 'https://beta.stablesrail.io/v1' : RAW_BASE
const KEY = process.env.STRAILS_API_KEY || ''

/** Master switch — the whole integration stays dark until this is 'true'. */
export const STRAILS_ENABLED = process.env.STRAILS_ENABLED === 'true' && Boolean(KEY)

export class StrailsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    /** `data.details.error.code`, e.g. BVN_VALIDATION_FAILED. Absent on non-onboarding calls. */
    readonly code?: string,
    /** `data.details.error.step`, e.g. bvn_validation. */
    readonly step?: string,
  ) {
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
 * We call Strails DIRECTLY from the VPS's fixed egress IP, registered in Strails' IP allowlist
 * (POST /manageipallowlist — itself allowlist-exempt). This retires the old Render "strails-relay"
 * hop: that only existed because Vercel egressed from a rotating IP pool, and Render's own egress
 * turned out to rotate too (it caused the 2026-09-17 IP_NOT_ALLOWED outage). A dedicated VPS IP
 * never rotates, so direct is the durable path.
 */
async function call<T = any>(path: string, body?: unknown, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  if (!KEY) throw new StrailsError('STRAILS_API_KEY not configured', 0)
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-api-key': KEY }
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      // Next.js caches fetch GETs by default in the App Router. That silently served
      // a stale /transactions snapshot to the reconciler: a ₦5,000 deposit was
      // invisible for its whole cache lifetime, so it swept the cNGN but never
      // credited it. Financial reads must never be cached.
      cache: 'no-store',
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
    // The useful part is nested at data.details.error. The top-level message is just
    // "User registration failed", which told ops nothing during the 2026-09-18 outage.
    const detail = json?.data?.details?.error
    throw new StrailsError(
      pick(detail, 'message') || pick(json, 'message', 'error') || `HTTP ${res.status}`,
      res.status,
      json,
      pick(detail, 'code'),
      pick(detail, 'step'),
    )
  }
  // Successful bodies are wrapped as { ..., data: {...} } in the docs' examples.
  return (json?.data ?? json) as T
}

// ── Onboarding (BVN → permanent virtual account) ───────────────────────────────

/**
 * Infra-side refusals, where nothing about the user's BVN is wrong so retrying cannot help.
 * Two shapes seen live: our egress IP rejected by the identity subsystem, and the provider
 * blocking the account for too many failed validations.
 */
export function isStrailsInfraFailure(e: unknown): boolean {
  if (!(e instanceof StrailsError)) return false
  const s = `${e.code ?? ''} ${e.message}`.toLowerCase()
  // onboarding_paused must be in here: it is the breaker's own error, and if it were treated as a
  // real BVN failure the caller would mark the user failed and email them, which is the exact
  // mislabelling the breaker exists to stop.
  return /allowlist|not in the application|ip not allowed|too many failed|failure rate|onboarding_paused/.test(s)
}

/**
 * Breaker for BVN onboarding.
 *
 * On 2026-09-18 the server moved to a new IP that Strails' gateway accepted but its BVN
 * subsystem did not. Every signup then failed, and each attempt still counted toward the
 * provider's failure-rate limit, which blocked the account outright. Without this, clearing
 * the block just starts the same spiral again.
 *
 * Per-process and intentionally simple. With several replicas each holds its own breaker,
 * which still cuts the attempt rate sharply and needs no schema.
 */
const BREAKER_MS = 15 * 60_000
let breakerUntil = 0
let breakerReason = ''

export function onboardingBreaker(): { open: boolean; reason: string; retryAfterSec: number } {
  const left = breakerUntil - Date.now()
  return { open: left > 0, reason: breakerReason, retryAfterSec: Math.max(0, Math.ceil(left / 1000)) }
}

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
  const open = onboardingBreaker()
  if (open.open) {
    throw new StrailsError(
      `Onboarding paused: ${open.reason}`,
      503,
      undefined,
      'ONBOARDING_PAUSED',
      'breaker',
    )
  }
  try {
    const d = await call('/onboarduser', input)
    breakerUntil = 0
    breakerReason = ''
    return {
      requestId: pick(d, 'requestId', 'request_id'),
      userHash: pick(d, 'userHash', 'user_hash'),
      status: pick(d, 'status'), // "processing"
    }
  } catch (e) {
    if (isStrailsInfraFailure(e)) {
      breakerUntil = Date.now() + BREAKER_MS
      breakerReason = e instanceof StrailsError ? e.code || e.message : 'infrastructure failure'
      console.error(
        `[strails] onboarding breaker OPEN ${BREAKER_MS / 60_000}m, not the user's BVN:`,
        breakerReason,
      )
    }
    throw e
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

/** Strails' own bank list — 6-digit NIBSS institution codes (e.g. OPAY=100004, GTBank=000013),
 * which differ from the 3-digit Paystack/CBN codes the app's bank picker uses. Cached. */
let _strailsBanks: { at: number; list: { name: string; code: string }[] } | null = null
async function getStrailsBanks(): Promise<{ name: string; code: string }[]> {
  if (_strailsBanks && Date.now() - _strailsBanks.at < 24 * 3600_000) return _strailsBanks.list
  const d = await call('/getbankscode', {})
  const raw = (d as any)?.banks ?? (Array.isArray(d) ? d : [])
  const list = (raw as any[])
    .map((b) => ({ name: String(b?.bank_name || b?.name || ''), code: String(b?.bank_code || b?.code || '') }))
    .filter((b) => b.name && b.code)
  if (list.length) _strailsBanks = { at: Date.now(), list }
  return list
}

const normBank = (s: string) =>
  String(s || '').toUpperCase().replace(/\b(PLC|LIMITED|LTD|BANK|DIGITAL SERVICES|MICROFINANCE|MFB|NIGERIA)\b/g, '').replace(/[^A-Z0-9]/g, '')

/**
 * Translate the app's bank code/name to the 6-digit NIBSS code Strails expects.
 * If `code` is already a 6-digit NIBSS code, it's used as-is; otherwise we match by bank name
 * against Strails' /getbankscode list. Returns null when no confident match (caller should fail
 * cleanly BEFORE debiting, so it can fall back / show an error).
 */
export async function resolveStrailsBankCode(bankName: string, code?: string): Promise<string | null> {
  if (code && /^\d{6}$/.test(code)) return code
  const target = normBank(bankName)
  if (!target) return null
  const banks = await getStrailsBanks().catch(() => [])
  // Exact normalized match first, then a contains-match either direction.
  const exact = banks.find((b) => normBank(b.name) === target)
  if (exact) return exact.code
  const partial = banks.find((b) => { const n = normBank(b.name); return n && (n.includes(target) || target.includes(n)) })
  return partial?.code ?? null
}

/**
 * Resolve an account holder name via Strails (name-enquiry fallback for the withdraw screen when
 * Flipeet's lookup is down). Strails has no read-only enquiry, so this uses /addbankaccount, which
 * verifies the account and returns verifiedAccountName. `code` may be the app's 3-digit code or a
 * bank name — it's translated to the NIBSS code first. Returns null if it can't resolve.
 */
export async function resolveStrailsAccountName(accountNumber: string, bankName: string, code?: string): Promise<string | null> {
  const nibss = await resolveStrailsBankCode(bankName, code).catch(() => null)
  if (!nibss) return null
  try {
    const d = await call('/addbankaccount', { accountNumber, bankCode: nibss })
    return pick(d, 'verifiedAccountName', 'accountName', 'account_name') ?? null
  } catch {
    return null
  }
}

export async function cngnOfframp(input: {
  userId: string
  amount: number          // NGN
  accountNumber: string
  bankCode: string        // must be the 6-digit NIBSS code (see resolveStrailsBankCode)
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