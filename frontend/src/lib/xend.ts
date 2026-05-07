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
  process.env.XEND_BASE_URL || 'https://api-solid-staging.xend.africa'
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
/*  Currency IDs (staging; override via env for production)            */
/* ------------------------------------------------------------------ */

// Fetch from /api/Public/currencies if these differ in production
const CURRENCY_ID_USDC =
  process.env.XEND_CURRENCY_ID_USDC || '87dda6c1-c4b8-4c1d-a108-3adda3be006d'
const CURRENCY_ID_CNGN =
  process.env.XEND_CURRENCY_ID_CNGN || '307f21f3-b0e1-4b2d-bfd9-f178af7289e9'

export { CURRENCY_ID_USDC, CURRENCY_ID_CNGN }

/* ------------------------------------------------------------------ */
/*  Money Market — implemented via Merchant Proxy Fund Transfer        */
/*  POST /api/Merchant/proxy/member/{proxyMemberId}/funds/transfer     */
/*  action CREDIT: merchant custodial → member wallet (deposit)        */
/*  action DEBIT : member wallet → merchant custodial (withdraw)       */
/* ------------------------------------------------------------------ */

export interface FundsTransferResult {
  transitWallet: {
    _id: string
    fundSource: string
    fundDestination: string
    transitWalletState: string
    transitAction: string
    amountToCredit: number
  }
  amount: number
  currencyId: string
  memberId: string
  merchantCompanyId: string
}

/**
 * Credit/debit USDC between the merchant custodial wallet and a proxy
 * member's Xend wallet. This is the correct Merchant API for moving
 * funds — there is no separate savings endpoint in the Merchant API.
 *
 * Endpoint: POST /api/Merchant/proxy/member/{proxyMemberId}/funds/transfer
 */
export async function proxyFundsTransfer(params: {
  proxyMemberId: string   // goes in the URL path
  action: 'CREDIT' | 'DEBIT'
  amount: number          // in token units (not micro)
  currencyId?: string     // defaults to USDC
  description?: string
}): Promise<FundsTransferResult> {
  const payload: Record<string, unknown> = {
    currencyId: params.currencyId ?? CURRENCY_ID_USDC,
    amount: params.amount,
    action: params.action,
    description: params.description ?? 'PawaSave yield pool',
  }
  const res = await xendRequest<FundsTransferResult>(
    'POST',
    `/api/Merchant/proxy/member/${params.proxyMemberId}/funds/transfer`,
    payload,
  )
  return res.data
}

/**
 * Deposit USDC into a proxy member's Xend wallet (yield pool).
 * Shorthand for proxyFundsTransfer with action=CREDIT.
 */
export async function depositToXendMoneyMarket(params: {
  proxyMemberId: string
  amount: number           // USDC amount (not micro-USDC)
  currencyId?: string
  description?: string
}): Promise<FundsTransferResult> {
  return proxyFundsTransfer({
    proxyMemberId: params.proxyMemberId,
    action: 'CREDIT',
    amount: params.amount,
    currencyId: params.currencyId,
    description: params.description ?? 'PawaSave deposit → yield pool',
  })
}

/**
 * Withdraw USDC from a proxy member's Xend wallet back to merchant custodial.
 * Shorthand for proxyFundsTransfer with action=DEBIT.
 */
export async function withdrawFromXendMoneyMarket(params: {
  proxyMemberId: string
  amount: number
  currencyId?: string
  description?: string
}): Promise<FundsTransferResult> {
  return proxyFundsTransfer({
    proxyMemberId: params.proxyMemberId,
    action: 'DEBIT',
    amount: params.amount,
    currencyId: params.currencyId,
    description: params.description ?? 'PawaSave yield pool → withdrawal',
  })
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

/* ------------------------------------------------------------------ */
/*  Merchant On-Chain Withdrawal                                       */
/* ------------------------------------------------------------------ */

// Set XEND_NETWORK_ID_BASE in Vercel env to the Base-network blockchainNetworkId
// from your Xend merchant dashboard (Developer → Networks).
const NETWORK_ID_BASE = process.env.XEND_NETWORK_ID_BASE || ''

export interface WithdrawValidationResult {
  fee: number
  feeInUsd: number
  totalAmount: number
  emailVerificationSent: boolean
  currency: { id: string; name: string; symbol: string }
  blockchainNetwork: { id: string; name: string }
  withdrawalLimits: {
    dailyLimit: number
    dailyUsed: number
    dailyRemaining: number
    monthlyLimit: number
    monthlyUsed: number
    monthlyRemaining: number
  }
  transactionAuthRequirement: {
    requireTwoFa: boolean
    requireEmailCode: boolean
    requireTransactionPin: boolean
    passKeyVerificationOptions: unknown
    addressIsWhitelisted: boolean
  }
}

export interface MerchantWithdrawResult {
  transactionId?: string
  reference?: string
  status?: string
  amount?: number
  destinationAddress?: string
  [key: string]: unknown
}

/**
 * Validate an on-chain withdrawal before processing.
 * Returns fee info, limits, and which auth methods are required.
 * If transactionAuthRequirement.addressIsWhitelisted is true, the process
 * step will not require interactive 2FA/email/passkey — whitelisting the
 * off-ramp provider addresses in the Xend dashboard is required for
 * automated server-side withdrawals.
 *
 * Endpoint: POST /api/Merchant/wallet/withdraw/validate
 * Auth: RSA-SHA256
 */
export async function validateMerchantWalletWithdraw(params: {
  destinationAddress: string
  amount: number
  currencyId?: string
  blockchainNetworkId?: string
}): Promise<WithdrawValidationResult> {
  const payload: Record<string, unknown> = {
    destinationAddress: params.destinationAddress,
    amount: params.amount,
    currencyId: params.currencyId ?? CURRENCY_ID_USDC,
    blockchainNetworkId: params.blockchainNetworkId ?? NETWORK_ID_BASE,
    requestTime: Date.now(),
  }

  const res = await xendRequest<WithdrawValidationResult>(
    'POST',
    '/api/Merchant/wallet/withdraw/validate',
    payload,
  )
  return res.data
}

/**
 * Send USDC on-chain from the merchant custody wallet to an external address.
 * Call validateMerchantWalletWithdraw first; if addressIsWhitelisted is true
 * no interactive auth is needed. Whitelist Flipeet/Flint deposit addresses in
 * the Xend merchant dashboard to enable automated withdrawals.
 *
 * Endpoint: POST /api/Merchant/wallet/withdraw
 * Auth: RSA-SHA256 (merchant-level, same as other Merchant endpoints)
 */
export async function merchantWalletWithdraw(params: {
  destinationAddress: string
  amount: number          // USDC in decimal (e.g. 10.5, not micro-units)
  blockchainNetworkId?: string
  currencyId?: string
  description?: string
  reference?: string
}): Promise<MerchantWithdrawResult> {
  const payload: Record<string, unknown> = {
    destinationAddress: params.destinationAddress,
    amount: params.amount,
    currencyId: params.currencyId ?? CURRENCY_ID_USDC,
    blockchainNetworkId: params.blockchainNetworkId ?? NETWORK_ID_BASE,
    requestTime: Date.now(),
  }
  if (params.description) payload.description = params.description
  if (params.reference) payload.reference = params.reference

  const res = await xendRequest<MerchantWithdrawResult>(
    'POST',
    '/api/Merchant/wallet/withdraw',
    payload,
  )
  return res.data
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

/* ------------------------------------------------------------------ */
/*  Crypto → Fiat Bank Transfer (XEND native off-ramp)                */
/*  Converts USDC in a proxy member's wallet directly to NGN and      */
/*  pays it to a Nigerian bank account — no external provider needed. */
/* ------------------------------------------------------------------ */

export interface CryptoToFiatResult {
  id: string
  withdrawalStatus: string
  memberId: string
  memberBankAccountId?: string
  sourceTransactionAmount: number
  sourceCurrencyId: string
  destinationAmount: number
  destinationAccountNumber: string
  destinationAccountName: string
  destinationCommercialBankId: string
  destinationFiatCurrencySymbol: string
  destinationTransactionRef?: string
  destinationSessionId?: string
  destinationRemark?: string
  sourceToDestinationExchangeRate?: number
  transactionFeeInSourceCurrency?: number
  status: string
  createdAt: string
  updatedAt: string
}

/**
 * Transfer USDC from a proxy member's wallet and pay NGN to a Nigerian bank.
 * This is XEND's native off-ramp — no Flipeet/Flint needed.
 *
 * Endpoint: POST /api/Merchant/proxy/member/{proxyMemberId}/crypto-to-fiat
 * Auth: RSA-SHA256 (merchant-level)
 *
 * @param proxyMemberId  - The Xend proxy member ID of the withdrawing user
 * @param amount         - Amount in USDC (decimal, e.g. 10.5)
 * @param bankCode       - Nigerian bank code (e.g. "058" for GTBank)
 * @param accountNumber  - Destination bank account number
 * @param accountName    - Account holder name
 * @param reference      - Your internal reference
 */
export async function proxyCryptoToFiatTransfer(params: {
  proxyMemberId: string
  amount: number
  currencyId?: string
  bankCode: string
  accountNumber: string
  accountName: string
  reference?: string
  remark?: string
}): Promise<CryptoToFiatResult> {
  const payload: Record<string, unknown> = {
    sourceAmount: params.amount,
    sourceCurrencyId: params.currencyId ?? CURRENCY_ID_USDC,
    destinationCommercialBankCode: params.bankCode,
    destinationAccountNumber: params.accountNumber,
    destinationAccountName: params.accountName,
    destinationFiatCurrencySymbol: 'NGN',
    requestTime: Date.now(),
  }
  if (params.reference) payload.destinationTransactionRef = params.reference
  if (params.remark) payload.destinationRemark = params.remark

  const res = await xendRequest<CryptoToFiatResult>(
    'POST',
    `/api/Merchant/proxy/member/${params.proxyMemberId}/crypto-to-fiat`,
    payload,
  )
  return res.data
}
