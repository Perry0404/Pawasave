/**
 * Xend Finance Merchant API client (server-side only)
 *
 * Authentication: RSA-SHA256 signatures
 * Base URLs:
 *   Staging  — https://api-solid-staging.xend.africa
 *   Live     — https://api-solid.xend.africa  (assumed from staging pattern)
 *
 * Required env vars:
 *   XEND_MERCHANT_ID   — UUID of merchant company
 *   XEND_API_KEY       — x-api-key header value
 *   XEND_PRIVATE_KEY   — PEM-encoded RSA private key (newlines as \n)
 *   XEND_PUBLIC_KEY    — Xend Finance's public key for webhook verification
 *   XEND_BASE_URL      — base URL (defaults to staging)
 */

import crypto from 'crypto'

const BASE_URL =
  process.env.XEND_BASE_URL || 'https://api-solid.xend.africa'
const MERCHANT_ID = process.env.XEND_MERCHANT_ID || ''
const API_KEY = process.env.XEND_API_KEY || ''
const PRIVATE_KEY_PEM = (process.env.XEND_PRIVATE_KEY || '').replace(
  /\\n/g,
  '\n',
)
const XEND_PUBLIC_KEY_PEM = (
  process.env.XEND_PUBLIC_KEY || ''
).replace(/\\n/g, '\n')

/* ------------------------------------------------------------------ */
/*  RSA signature helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Build the canonical string-to-sign from a payload object.
 * Keys are sorted alphabetically; null/empty values are omitted.
 * Nested objects are JSON-stringified.
 */
function buildCanonicalString(payload: Record<string, unknown>): string {
  return Object.keys(payload)
    .filter((k) => payload[k] != null && payload[k] !== '')
    .sort()
    .map((k) => {
      const v = payload[k]
      if (typeof v === 'object' && v !== null) {
        return `${k}=${JSON.stringify(v)}`
      }
      return `${k}=${v}`
    })
    .join('&')
}

/** Sign the canonical string with the merchant's RSA private key. */
function signPayload(payload: Record<string, unknown>): string {
  const canonical = buildCanonicalString(payload)
  return crypto
    .createSign('RSA-SHA256')
    .update(canonical)
    .sign(PRIVATE_KEY_PEM, 'base64')
}

/* ------------------------------------------------------------------ */
/*  Generic request helper                                             */
/* ------------------------------------------------------------------ */

export interface XendResponse<T = unknown> {
  data: T
  status: 'success' | 'failed'
  statusCode: number
  message: string
  action: string | null
  messageLanguageCode: string
  details: string | null
  cacheTTL: number
}

export async function xendRequest<T = unknown>(
  method: string,
  path: string,
  payload: Record<string, unknown> = {},
  countryCode = 'NG',
): Promise<XendResponse<T>> {
  if (!MERCHANT_ID || !API_KEY || !PRIVATE_KEY_PEM) {
    throw new Error('Xend Finance credentials not configured')
  }

  const rsaSignature = signPayload(payload)
  const nonce = crypto.randomBytes(16).toString('hex')
  const timestamp = Date.now().toString()

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    Authorization: `Bearer ${MERCHANT_ID}`,
    'x-rsa-signature': rsaSignature,
    'x-request-timestamp': timestamp,
    'x-nonce-string': nonce,
    'x-country-code': countryCode,
  }

  const url = `${BASE_URL}${path}`
  const init: RequestInit = {
    method: method.toUpperCase(),
    headers,
  }

  if (method.toUpperCase() !== 'GET') {
    init.body = JSON.stringify(payload)
  }

  const res = await fetch(url, init)
  const json: XendResponse<T> = await res.json()

  if (!res.ok || json.status === 'failed') {
    const msg = json.message || json.details || `Xend API error ${res.status}`
    console.error('Xend API error:', res.status, JSON.stringify(json))
    throw new Error(msg)
  }

  return json
}

/* ------------------------------------------------------------------ */
/*  Proxy Members                                                      */
/* ------------------------------------------------------------------ */

export interface ProxyMemberResult {
  accessToken: string
  accessSecret: string
  sessionExpiryTime: string
  memberId: string
  mid: number
  email: string
  profile: Record<string, unknown>
}

/**
 * Register an end-user as a proxy member on Xend Finance.
 * @param externalId – Unique ID in PawaSave (e.g. Supabase user UUID)
 */
export async function registerProxyMember(
  externalId: string,
  opts?: {
    firstName?: string
    lastName?: string
    email?: string
    phoneNumber?: string
    countryCode?: string
  },
) {
  const payload: Record<string, unknown> = {
    externalProxyMemberUniqueId: externalId,
    requestTime: Date.now(),
    ...opts,
  }
  return xendRequest<ProxyMemberResult>(
    'POST',
    '/api/Merchant/proxymember/add',
    payload,
  )
}

/** Refresh a proxy member's token by their memberId. */
export async function refreshProxyMemberToken(memberId: string) {
  return xendRequest<ProxyMemberResult>(
    'POST',
    '/api/Merchant/proxymember/auth',
    { memberId, requestTime: Date.now() },
  )
}

/* ------------------------------------------------------------------ */
/*  Fund Transfers (Merchant ↔ Proxy Member)                          */
/* ------------------------------------------------------------------ */

export interface TransferResult {
  transactionId: string
  status: string
  amount: number
}

/**
 * Transfer funds between merchant custodial wallet and a proxy member wallet.
 */
export async function proxyFundsTransfer(params: {
  destinationAccount: string // proxy member wallet address or ID
  amount: number
  currency?: string
  narration?: string
}) {
  return xendRequest<TransferResult>(
    'POST',
    '/api/Merchant/proxyfunds/transfer',
    { ...params, requestTime: Date.now() },
  )
}

/* ------------------------------------------------------------------ */
/*  POS Agent — On-Ramp / Off-Ramp                                    */
/* ------------------------------------------------------------------ */

export interface InvoiceValidation {
  isValid: boolean
  amount: number
  currency: string
  network: string
}

export interface InvoiceResult {
  invoiceId: string
  walletAddress: string
  amount: number
  currency: string
  network: string
  status: string
}

/** Validate a crypto payment invoice for a POS agent proxy member */
export async function validatePosInvoice(
  proxyMemberId: string,
  params: {
    amount: number
    currency: string // e.g. 'USDT', 'cNGN'
    fiatAmount?: number
    fiatCurrency?: string // e.g. 'NGN'
  },
) {
  return xendRequest<InvoiceValidation>(
    'POST',
    `/api/Merchant/pos/invoice/crypto/${proxyMemberId}/validate`,
    { ...params, requestTime: Date.now() },
  )
}

/** Process (create) a crypto payment invoice and get wallet address / payment details */
export async function processPosInvoice(
  proxyMemberId: string,
  params: {
    amount: number
    currency: string
    fiatAmount?: number
    fiatCurrency?: string
  },
) {
  return xendRequest<InvoiceResult>(
    'POST',
    `/api/Merchant/pos/invoice/crypto/${proxyMemberId}/process`,
    { ...params, requestTime: Date.now() },
  )
}

/** Submit a transaction hash to confirm a POS invoice payment */
export async function submitInvoiceTxHash(
  proxyMemberId: string,
  invoiceId: string,
  transactionHash: string,
) {
  return xendRequest(
    'POST',
    `/api/Merchant/pos/invoice/${proxyMemberId}/${invoiceId}/transaction-hash`,
    { transactionHash, requestTime: Date.now() },
  )
}

/* ------------------------------------------------------------------ */
/*  Webhook Signature Verification                                     */
/* ------------------------------------------------------------------ */

/**
 * Verify an incoming Xend Finance webhook payload.
 * Extracts the `signature` field from the payload, constructs the canonical
 * string from the remaining fields, and verifies with Xend's public key.
 */
export function verifyXendWebhook(
  payload: Record<string, unknown>,
): boolean {
  if (!XEND_PUBLIC_KEY_PEM) return false

  const { signature, ...dataToVerify } = payload
  if (!signature || typeof signature !== 'string') return false

  const canonical = buildCanonicalString(dataToVerify)

  return crypto
    .createVerify('RSA-SHA256')
    .update(canonical)
    .verify(XEND_PUBLIC_KEY_PEM, signature as string, 'base64')
}

/* ------------------------------------------------------------------ */
/*  Public Key Verification (one-time setup check)                     */
/* ------------------------------------------------------------------ */

/** Verify that the uploaded public key matches our private key. */
export async function verifyPublicKey(metadata: {
  companyName: string
  contactEmail: string
  submittedBy: string
}) {
  const full = {
    ...metadata,
    timestamp: new Date().toISOString(),
    nonce: `verify-${Date.now()}`,
  }

  const canonical = buildCanonicalString(full)
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(canonical)
    .sign(PRIVATE_KEY_PEM, 'base64')

  return xendRequest(
    'POST',
    '/api/Merchant/lobby/company/public-key/verify',
    { metadata: full, signature: sig },
  )
}
