import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { validatePosInvoice, processPosInvoice, registerProxyMember, proxyCryptoToFiatTransfer, proxyFundsTransfer } from '@/lib/xend'
import {
  FlipeetInitResult,
  getFlipeetRate,
  initializeFlipeetOffRamp,
  initializeFlipeetOnRamp,
} from '@/lib/flipeet'
import { getNgnUsdRateFromFlint } from '@/lib/ramp-rate'
import { sendCngn, cngnToShares, withdrawFromLend, custodyCngnBalance, custodyAddress } from '@/lib/custody'
import { createClient } from '@supabase/supabase-js'
import { verifyPin } from '@/lib/pin-hash'
import { pinLockGuard, recordPinResult } from '@/lib/pin-lockout'
import { sendWithdrawalEmail } from '@/lib/notify-tx'
import { custodyLendShares } from '@/lib/custody'

// Off-ramp does a Flipeet API call + TWO sequential Base txs (redeem from the
// pool, then send cNGN to Flipeet), each awaiting confirmation. That can exceed
// the default serverless timeout and strand funds mid-flow (redeemed to custody
// but never sent to Flipeet). Give the request room to finish both on-chain legs.
export const maxDuration = 60

const FLINT_API_KEY = process.env.FLINT_API_KEY || ''
const FLINT_BASE = 'https://stables.flintapi.io/v1'
// Custody address where on-ramped cNGN is received. Shared across providers.
const CUSTODY_ADDRESS =
  process.env.FLINT_CUSTODY_ADDRESS
  || process.env.XEND_CUSTODY_ADDRESS
  || process.env.RAMP_CUSTODY_ADDRESS
  || ''
const FLIPEET_CUSTODY_ADDRESS =
  process.env.FLIPEET_CUSTODY_ADDRESS
  || CUSTODY_ADDRESS
// Flipeet generates a dynamic deposit address per off-ramp transaction.
// The custody wallet (CUSTODY_PRIVATE_KEY) sends cNGN to that address on-chain.
const DEFAULT_FEE_PERCENT = 1.5
const DEFAULT_XEND_ESTIMATED_FEE = 120
const DEFAULT_FLIPEET_ESTIMATED_FEE = 100
// Flint rejects on-ramp amounts below ₦2,000 (Zod min). Enforce up-front so users
// see a clear minimum instead of an opaque provider validation error. Configurable.
const FLINT_MIN_ONRAMP_NGN = Number(process.env.FLINT_MIN_ONRAMP_NGN) || 2000
// PawaSave uses Strails for fiat on-ramp (per-user NUBAN) and Flipeet for off-ramp
// (cNGN end-to-end). Flint is RETIRED — hard-disabled here so it can never be offered
// as a provider regardless of env (an FLINT_ENABLED left set won't re-enable it). Xend
// stays env-gated. To ever bring Flint back, restore the env check below.
// Retired: force off. (Was: Boolean(FLINT_API_KEY) && process.env.FLINT_ENABLED === 'true')
const FLINT_CONFIGURED: boolean = false
const XEND_CONFIGURED = Boolean(
  process.env.XEND_MERCHANT_ID && process.env.XEND_API_KEY && process.env.XEND_PRIVATE_KEY,
) && process.env.XEND_ENABLED === 'true'
const FLIPEET_CONFIGURED = Boolean(
  process.env.FLIPEET_API_KEY && FLIPEET_CUSTODY_ADDRESS,
)

type RampType = 'on' | 'off'
type Provider = 'flint' | 'xend' | 'flipeet'

type ProviderResult = {
  provider: Provider
  transactionId?: string
  reference: string
  amount?: number
  bankName?: string
  bankCode?: string
  accountNumber?: string
  accountName?: string
  depositAddress?: string
  walletAddress?: string
  currency?: string
  network?: string
  pawaFee: number
  providerFee: number
  totalFee: number
  feePercent: number
}

function generateRef() {
  // Flipeet requires a valid UUID (GUID) format
  const bytes = crypto.randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant bits
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function calcFlintFees(amountNaira: number, type: RampType) {
  const platformFee = Math.min(amountNaira * 0.001, 200)
  const baseFee = amountNaira < 50000 ? 55 : 0
  const stampDuty = type === 'off' && amountNaira > 10000 ? 50 : 0
  const subtotal = platformFee + baseFee + stampDuty
  const vat = type === 'off' ? subtotal * 0.075 : 0
  const gasFee = type === 'on' ? 150 : 0
  return Math.ceil(subtotal + vat + gasFee)
}

function formatProviderError(provider: Provider, error: unknown) {
  // Log the real provider error server-side only. Never leak which providers/keys
  // are configured, or raw third-party messages, to the client (FIND-API-09).
  const message = error instanceof Error ? error.message : 'Service temporarily unavailable'
  console.error(`[ramp] ${provider} error:`, message)

  // The one genuinely useful, non-revealing hint to surface to users.
  if (/insufficient|balance|liquidity/i.test(message)) {
    return 'Withdrawals are temporarily unavailable. Please try again in a few minutes or contact support.'
  }

  // Beneficiary validation from the payout provider — the user CAN fix these, so
  // surface an actionable (still non-revealing) message instead of a generic outage.
  if (/beneficiary|bank account|account number|account name|\bname\b|alphanumeric/i.test(message)) {
    return 'We couldn’t verify those bank details. Check the account number, bank, and account name (letters only — no symbols), then try again.'
  }

  return 'Payment provider is temporarily unavailable. Please try again shortly, or contact support if it persists.'
}

// Flipeet rejects beneficiary names containing non-alphanumeric characters (e.g. the
// hyphen in "pascal-mary chinonso" → 400 "Name can only contain alphanumeric
// characters"). Reduce to letters, digits and single spaces — that satisfies the
// provider's rule without changing who is paid: the bank resolves the real account
// name from the account number during the beneficiary lookup.
function sanitizeBeneficiaryName(name: string): string {
  return (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function getNumberSetting(supabase: any, key: string, fallback: number): Promise<number> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', key)
    .single()

  if (!data?.value) return fallback
  const value = Number(data.value)
  return Number.isFinite(value) ? value : fallback
}

async function getSupabaseUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { user, supabase }
}

async function ensureWithdrawalPin(
  supabase: any,
  userId: string,
  transactionPin: string,
): Promise<NextResponse | null> {
  if (!/^\d{4}$/.test(transactionPin)) {
    return NextResponse.json({ error: 'Valid 4-digit transaction PIN is required' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('transaction_pin_hash')
    .eq('id', userId)
    .single()

  if (!profile?.transaction_pin_hash) {
    return NextResponse.json({ error: 'Set your transaction PIN in Settings first' }, { status: 400 })
  }

  // Account-level brute-force lock (FIND-AUTH-*): refuse before verifying if locked.
  const lock = await pinLockGuard(userId)
  if (lock.locked) return NextResponse.json({ error: lock.message }, { status: 429 })

  const { ok, upgrade } = verifyPin(transactionPin, profile.transaction_pin_hash)
  const attempt = await recordPinResult(userId, ok)
  if (!ok) {
    return NextResponse.json({ error: attempt.message || 'Incorrect transaction PIN' }, { status: attempt.justLocked ? 429 : 401 })
  }

  // Opportunistically migrate a legacy unsalted SHA-256 PIN to salted scrypt
  // (FIND-AUTH-01). Best-effort — verification already succeeded.
  if (upgrade && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } },
      )
      await admin.from('profiles').update({ transaction_pin_hash: upgrade }).eq('id', userId)
    } catch {
      // ignore — migration will retry on the next withdrawal
    }
  }

  return null
}

async function maybeDebitForWithdrawal(
  supabase: any,
  userId: string,
  amountNaira: number,
  reference: string,
): Promise<NextResponse | null> {
  // cNGN balance: 1 NGN = 1 cNGN. Debit the naira value as cNGN micro (no rate).
  const cngnMicro = Math.floor(amountNaira * 1_000_000)

  // Deposits auto-allocate 90% into the savings pool (cngn_pool_micro), leaving
  // only ~10% spendable. A withdrawal must be able to reach the pooled savings, so
  // if the spendable balance is short, redeem the shortfall from the pool first.
  const { data: wallet } = await supabase
    .from('wallets')
    .select('usdc_balance_micro, cngn_pool_micro')
    .eq('user_id', userId)
    .single()

  const spendable = Number(wallet?.usdc_balance_micro || 0)
  if (spendable < cngnMicro) {
    const shortfall = cngnMicro - spendable
    const pool = Number(wallet?.cngn_pool_micro || 0)
    if (pool < shortfall) {
      await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 })
    }
    const { data: moved } = await supabase.rpc('withdraw_cngn_pool', {
      p_user_id: userId,
      p_amount_micro: shortfall,
    })
    if (!moved) {
      await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 })
    }
  }

  const { data: ok } = await supabase.rpc('debit_wallet', {
    p_user_id: userId,
    p_naira_kobo: 0,
    p_usdc_micro: cngnMicro,
  })

  if (!ok) {
    await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 })
  }

  return null
}

async function recordPlatformFee(
  supabase: any,
  userId: string,
  reference: string,
  feeType: 'ramp_onramp' | 'ramp_offramp',
  grossAmountKobo: number,
  feeKobo: number,
  feePercent: number,
) {
  if (feeKobo <= 0) return
  await supabase.rpc('record_platform_fee', {
    p_user_id: userId,
    p_reference: reference,
    p_fee_type: feeType,
    p_gross_kobo: grossAmountKobo,
    p_fee_kobo: feeKobo,
    p_fee_percent: feePercent,
  })
}

/**
 * Durably record WHERE an off-ramp is about to send cNGN, BEFORE sending it, and
 * CONFIRM the write persisted (read-after-write, with retries).
 *
 * The settling marker is the ONLY thing that lets the reconciler later verify a
 * stranded withdrawal on-chain and complete it. A mid-flight Supabase update whose
 * error is ignored can silently no-op — which is exactly how a delivered ₦4,900
 * off-ramp ended up with NO marker at all: the cNGN left custody, the row stayed
 * 'pending', and the reconciler was blind to it. So write, read it back, and only
 * return true once the address is confirmed on the row. If it can't be confirmed the
 * caller MUST NOT send — an unverifiable send is worse than a refunded retry.
 */
// Service-role client for server-authoritative writes that MUST bypass RLS.
// The `transactions` table has only SELECT + INSERT RLS policies (001_initial),
// so the user-scoped client silently no-ops any UPDATE (0 rows, NO error) — which
// is exactly what made off-ramp settlement markers and status updates vanish: the
// marker read-back never matched, so every withdrawal aborted "nothing sent", and
// before the marker guard a sent withdrawal's 'completed' update silently failed
// and stranded the row on 'pending'. These writes are server-authoritative (the
// caller was already authenticated + PIN-verified upstream), so use service role.
let _adminDb: any = null
function adminDb() {
  if (_adminDb) return _adminDb
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  _adminDb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  return _adminDb
}

async function commitSettlementMarker(
  supabase: any,
  reference: string,
  depositAddress: string,
): Promise<boolean> {
  // Bypass RLS — otherwise the UPDATE no-ops and the marker never persists.
  const db = adminDb() ?? supabase
  const marker = `Sent via Flipeet — on-chain: settling → ${depositAddress}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await db
      .from('transactions')
      .update({ description: marker })
      .eq('reference', reference)
    if (!error) {
      const { data } = await db
        .from('transactions')
        .select('description')
        .eq('reference', reference)
        .maybeSingle()
      if (data?.description?.includes(depositAddress)) return true
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  return false
}

async function runFlint(
  request: NextRequest,
  supabase: any,
  userId: string,
  type: RampType,
  amount: number,
): Promise<ProviderResult> {
  if (!FLINT_CONFIGURED) throw new Error('Flint provider unavailable')
  if (type === 'off') throw new Error('Flint provider unavailable for off-ramp')

  const reference = generateRef()
  const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
  const pawaFeeNaira = Math.round((amount * feePercent) / 100)
  const providerFeeNaira = calcFlintFees(amount, type)

  const origin = request.nextUrl.origin || 'https://pawasave.xyz'
  // Deliver on-ramped cNGN to the FLIPEET custody address — that's the wallet the
  // off-ramps draw from, so on-ramped funds land where they can be paid back out.
  // Derive the custody destination from the signer when the env address isn't set
  // (it's Sensitive in prod). Flint REQUIRES destination or it 422s with no account.
  const custodyDest = FLIPEET_CUSTODY_ADDRESS || CUSTODY_ADDRESS || (await custodyAddress())
  if (!custodyDest) throw new Error('On-ramp custody destination not configured')
  const flintBody: any = {
    type,
    reference,
    network: 'base',
    // cNGN end-to-end: Flint delivers cNGN to custody so on-ramped funds can be
    // supplied straight into PawasaveLend as borrower liquidity. Flipeet can't
    // on-ramp cNGN, so Flint is the fiat→cNGN provider.
    asset: process.env.FLINT_ASSET || 'cngn',
    // Fiat currency to COLLECT — without this Flint won't provision the NGN
    // virtual bank account (the missing "account number" on the deposit screen).
    currency: 'NGN',
    fiatCurrency: 'NGN',
    amount: Math.round(amount),
    notifyUrl: `${origin}/api/webhook`,
  }

  flintBody.destination = { address: custodyDest }

  const flintRes = await fetch(`${FLINT_BASE}/ramp/initialise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': FLINT_API_KEY,
    },
    body: JSON.stringify(flintBody),
  })

  const flintData = await flintRes.json()
  if (!flintRes.ok || flintData.status === 'error' || flintData.success === false) {
    // Flint returns Zod validation errors as { error: { issues: [{ message }] } }.
    // Flatten them so the real reason (e.g. "amount must be >= 2000") surfaces.
    let msg = 'Service temporarily unavailable'
    const fe: any = flintData.error
    if (typeof fe === 'string') msg = fe
    else if (Array.isArray(fe?.issues) && fe.issues.length) msg = fe.issues.map((i: any) => i.message).join('; ')
    else if (typeof flintData.message === 'string') msg = flintData.message
    const err: any = new Error(msg)
    err.isValidation = flintRes.status === 422 || /too small|minimum|at least|expected/i.test(msg)
    throw err
  }

  // Flint's exact on-ramp response shape (esp. the NGN virtual account) isn't
  // documented publicly, so: (1) log the raw response so we can confirm the real
  // field names in the Vercel logs, and (2) read the bank account defensively
  // from the shapes providers commonly use (flat / nested under deposit|account|
  // virtualAccount, camelCase or snake_case). This is why the account number was
  // blank: the old code only checked flat camelCase `data.accountNumber`.
  console.info('[ramp] flint on-ramp raw response:', JSON.stringify(flintData))
  const fd = flintData.data ?? flintData
  const acct = fd.depositAccount ?? fd.deposit ?? fd.account ?? fd.virtualAccount ?? fd.bankAccount ?? fd.source ?? fd
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = acct?.[k] ?? fd?.[k]; if (v) return String(v) }
    return undefined
  }
  const flintBankName    = pick('bankName', 'bank_name', 'bank')
  const flintBankCode    = pick('bankCode', 'bank_code')
  const flintAccountNo   = pick('accountNumber', 'account_number', 'accountNo', 'number')
  const flintAccountName = pick('accountName', 'account_name', 'accountHolder', 'holder_name')
  const flintDepositAddr = pick('depositAddress', 'deposit_address', 'address')
  const flintTxId        = pick('transactionId', 'transaction_id', 'id', 'reference')
  const flintAmount      = Number(pick('amountToTransfer', 'amount') ?? amount)

  const pawaFeeKobo = Math.round(pawaFeeNaira * 100)
  await supabase.from('transactions').insert({
    user_id: userId,
    type: 'deposit',
    direction: 'credit',
    amount_kobo: Math.round(amount * 100),
    platform_fee_kobo: pawaFeeKobo,
    description: 'Received via FlintAPI',
    reference,
    paychant_tx_id: flintTxId || null,
    status: 'pending',
  })

  // Platform fee is booked on COMPLETION (in the Flint webhook), not here — a
  // deposit that's only initialised (never paid) must not count as revenue.
  void feePercent

  return {
    provider: 'flint',
    transactionId: flintTxId,
    reference,
    amount: flintAmount,
    bankName: flintBankName,
    bankCode: flintBankCode,
    accountNumber: flintAccountNo,
    accountName: flintAccountName,
    depositAddress: flintDepositAddr,
    pawaFee: pawaFeeNaira,
    providerFee: providerFeeNaira,
    totalFee: pawaFeeNaira + providerFeeNaira,
    feePercent,
  }
}

async function ensureXendMemberId(supabase: any, userId: string): Promise<string> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('xend_member_id')
    .eq('id', userId)
    .single()

  if (profile?.xend_member_id) return profile.xend_member_id

  // Auto-register this user as an Xend proxy member on first use
  const result = await registerProxyMember(userId)
  const memberId = result.data.memberId

  await supabase
    .from('profiles')
    .update({ xend_member_id: memberId })
    .eq('id', userId)

  return memberId
}

async function runXend(
  supabase: any,
  userId: string,
  type: RampType,
  amount: number,
  bankCode?: string,
  accountNumber?: string,
  holderName?: string,
): Promise<ProviderResult> {
  if (!XEND_CONFIGURED) throw new Error('Xend provider unavailable')

  const xendMemberId = await ensureXendMemberId(supabase, userId)

  const reference = generateRef()
  const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
  const pawaFeeNaira = Math.round((amount * feePercent) / 100)
  const providerFeeNaira = await getNumberSetting(supabase, 'xend_estimated_fee_naira', DEFAULT_XEND_ESTIMATED_FEE)

  if (type === 'on') {
    // On-ramp: generate a crypto deposit address via POS invoice
    const currency = 'USDC'
    await validatePosInvoice(xendMemberId, {
      amount: 0,
      currency,
      fiatAmount: amount,
      fiatCurrency: 'NGN',
    })

    const invoice = await processPosInvoice(xendMemberId, {
      amount: 0,
      currency,
      fiatAmount: amount,
      fiatCurrency: 'NGN',
    })

    const pawaFeeKobo = Math.round(pawaFeeNaira * 100)
    await supabase.from('transactions').insert({
      user_id: userId,
      type: 'deposit',
      direction: 'credit',
      amount_kobo: Math.round(amount * 100),
      platform_fee_kobo: pawaFeeKobo,
      description: 'Received via Xend Finance',
      reference,
      paychant_tx_id: invoice.data.invoiceId,
      status: 'pending',
    })

    await recordPlatformFee(supabase, userId, reference, 'ramp_onramp', Math.round(amount * 100), pawaFeeKobo, feePercent)

    return {
      provider: 'xend',
      transactionId: invoice.data.invoiceId,
      reference,
      walletAddress: invoice.data.walletAddress,
      depositAddress: invoice.data.walletAddress,
      amount: Math.round(amount),
      currency: invoice.data.currency,
      network: invoice.data.network,
      pawaFee: pawaFeeNaira,
      providerFee: providerFeeNaira,
      totalFee: pawaFeeNaira + providerFeeNaira,
      feePercent,
    }
  }

  // Off-ramp: XEND native crypto → NGN bank transfer
  // Debit user's PawaSave USDC balance first
  const debitError = await maybeDebitForWithdrawal(supabase, userId, amount, reference)
  if (debitError) throw new Error('Insufficient USDC balance')

  const rate = await getNgnUsdRateFromFlint(FLINT_API_KEY)
  const usdcAmount = amount / rate
  const usdcMicro = Math.floor(usdcAmount * 1_000_000)

  // Record the transaction row before calling XEND (so we have a reference if it fails)
  const pawaFeeKoboOff = Math.round(pawaFeeNaira * 100)
  await supabase.from('transactions').insert({
    user_id: userId,
    type: 'withdrawal',
    direction: 'debit',
    amount_kobo: Math.round(amount * 100),
    platform_fee_kobo: pawaFeeKoboOff,
    description: 'Sent via Xend Finance',
    reference,
    status: 'pending',
  })

  try {
    // 1. Move USDC from merchant custodial → proxy member wallet
    await proxyFundsTransfer({
      proxyMemberId: xendMemberId,
      action: 'CREDIT',
      amount: usdcAmount,
      description: `PawaSave withdrawal fund ${reference}`,
    })

    // 2. XEND converts USDC → NGN and pays to user's bank
    const xendResult = await proxyCryptoToFiatTransfer({
      proxyMemberId: xendMemberId,
      amount: usdcAmount,
      bankCode: bankCode || '',
      accountNumber: accountNumber || '',
      accountName: holderName || '',
      reference,
      remark: `PawaSave withdrawal ${reference}`,
    })

    await recordPlatformFee(supabase, userId, reference, 'ramp_offramp', Math.round(amount * 100), pawaFeeKoboOff, feePercent)

    return {
      provider: 'xend',
      transactionId: xendResult.id,
      reference,
      amount: Math.round(amount),
      pawaFee: pawaFeeNaira,
      providerFee: providerFeeNaira,
      totalFee: pawaFeeNaira + providerFeeNaira,
      feePercent,
    }
  } catch (xendErr: any) {
    // Refund user — debit the proxy member wallet back to merchant and credit PawaSave balance
    try {
      await proxyFundsTransfer({
        proxyMemberId: xendMemberId,
        action: 'DEBIT',
        amount: usdcAmount,
        description: `Refund – failed withdrawal ${reference}`,
      })
    } catch {
      // Best-effort debit back; if this also fails the merchant wallet already has the funds
    }
    await supabase.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: usdcMicro })
    await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
    throw new Error(xendErr.message || 'Xend withdrawal failed. Please try again.')
  }
}

async function runFlipeet(
  request: NextRequest,
  supabase: any,
  userId: string,
  type: RampType,
  amount: number,
  bankCode?: string,
  accountNumber?: string,
  holderName?: string,
  bankName?: string,
  /** 'NGN' (default) or 'USD' — only applies to on-ramp */
  depositCurrency: 'NGN' | 'USD' = 'NGN',
): Promise<ProviderResult> {
  if (!FLIPEET_CONFIGURED) throw new Error('Flipeet provider unavailable')

  const reference = generateRef()
  const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
  const pawaFeeNaira = Math.round((amount * feePercent) / 100)
  const providerFeeNaira = await getNumberSetting(
    supabase,
    'flipeet_estimated_fee_naira',
    DEFAULT_FLIPEET_ESTIMATED_FEE,
  )
  const origin = request.nextUrl.origin || 'https://pawasave.xyz'
  const pawaFeeKobo = Math.round(pawaFeeNaira * 100)

  // GROSS-UP (off-ramp): the user receives exactly `amount`; our 1.5% fee is added ON
  // TOP, not netted out of the payout. So we DEBIT amount+fee but only SEND `amount`
  // to Flipeet — the fee cNGN stays in custody as real, backed revenue (not phantom).
  // amount_kobo on the row = the TOTAL debited, so every refund path (here + the
  // reconcilers, which all refund from amount_kobo) returns the full debit automatically.
  // Off-ramp fee model (verified via live Flipeet quotes): the bank receives
  // source × rate (rate ≈ 0.99 — a ~1% spread incl. Flipeet's developer_fee). So to
  // deliver the FULL `amount` to the recipient we must SEND amount/rate; that uplift
  // is Flipeet's fee, paid by the user ON TOP. Our 1.5% is added on top of that, and
  // only OUR fee is retained in custody.
  let offSendNaira = amount
  let offFlipeetFeeNaira = 0
  if (type === 'off') {
    const rateInfo = await getFlipeetRate('off').catch(() => null)
    const r = Number(rateInfo?.rate)
    const rate = r > 0 && r <= 1 ? r : 1
    offSendNaira = Math.round(amount / rate)
    offFlipeetFeeNaira = Math.max(0, offSendNaira - amount)
  }
  const offrampTotalNaira = offSendNaira + pawaFeeNaira // debited: send (incl. Flipeet fee) + our 1.5%
  const offrampDebitMicro = Math.floor(offrampTotalNaira * 1_000_000)
  // Embed a secret token in the callback URL so the flipeet-webhook handler can
  // reject forged requests (FIND-API-01). Only Flipeet ever receives this URL.
  const webhookToken = process.env.FLIPEET_WEBHOOK_TOKEN
    ? `?token=${encodeURIComponent(process.env.FLIPEET_WEBHOOK_TOKEN)}`
    : ''

  // ── OFF-RAMP: debit user balance BEFORE calling Flipeet ─────────────────────
  // This guarantees we never trigger a payout for a user with insufficient funds.
  if (type === 'off') {
    await supabase.from('transactions').insert({
      user_id: userId,
      type: 'withdrawal',
      direction: 'debit',
      amount_kobo: Math.round(offrampTotalNaira * 100), // TOTAL debited (net + Flipeet fee + our 1.5%)
      platform_fee_kobo: pawaFeeKobo,
      description: `Sent via Flipeet — ₦${amount.toLocaleString()} to bank (₦${pawaFeeNaira.toLocaleString()} fee${offFlipeetFeeNaira ? ` + ₦${offFlipeetFeeNaira.toLocaleString()} network` : ''})`,
      reference,
      status: 'pending',
      // Persist the destination so the app's detail sheet + the email receipt can
      // show where the money went (bank, account name, account no).
      metadata: { bank_name: bankName || null, account_name: holderName || null, account_number: accountNumber || null, net_naira: amount, fee_naira: pawaFeeNaira, flipeet_fee_naira: offFlipeetFeeNaira },
    })
    const debitError = await maybeDebitForWithdrawal(supabase, userId, offrampTotalNaira, reference)
    if (debitError) throw new Error('INSUFFICIENT_BALANCE')
  }

  // ── Call Flipeet API ─────────────────────────────────────────────────────────
  // Wrap in try/catch: if the off-ramp API call fails after the user was debited, we must
  // refund their balance and mark the tx failed before re-throwing. Without this, the caller's
  // fallback logic would attempt a second debit via a different provider (double-debit).
  let result: FlipeetInitResult
  try {
    result = type === 'on'
      ? await initializeFlipeetOnRamp({
        amount,
        reference,
        callbackUrl: `${origin}/api/flipeet-webhook${webhookToken}`,
        walletAddress: FLIPEET_CUSTODY_ADDRESS,
        holderName: process.env.RAMP_BENEFICIARY_NAME || 'PawaSave Treasury',
        currency: depositCurrency,
        country: depositCurrency === 'USD' ? 'US' : (process.env.FLIPEET_COUNTRY_CODE || 'NG'),
      })
      : await initializeFlipeetOffRamp({
        // Send the grossed-up source so the bank receives the FULL `amount` after
        // Flipeet's spread — offSendNaira = amount/rate.
        amount: offSendNaira,
        reference,
        callbackUrl: `${origin}/api/flipeet-webhook${webhookToken}`,
        bankCode: bankCode || '',
        accountNumber: accountNumber || '',
        holderName: sanitizeBeneficiaryName(holderName || process.env.RAMP_BENEFICIARY_NAME || 'PawaSave User') || 'PawaSave User',
      })
  } catch (apiErr: unknown) {
    if (type === 'off') {
      // Refund the FULL debit (net + fee), not just the net — the user was debited
      // amount+fee before this API call.
      await supabase.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: offrampDebitMicro })
      await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
    }
    throw apiErr
  }

  if (type === 'on') {
    // On-ramp: insert pending tx after getting provider details
    await supabase.from('transactions').insert({
      user_id: userId,
      type: 'deposit',
      direction: 'credit',
      amount_kobo: Math.round(amount * 100),
      platform_fee_kobo: pawaFeeKobo,
      description: 'Received via Flipeet',
      reference,
      paychant_tx_id: result.reference || null,
      status: 'pending',
    })
  } else {
    // Off-ramp: Flipeet gives a dynamic deposit address per transaction.
    // We must send cNGN to that address — custody wallet signs the on-chain transfer.
    await (adminDb() ?? supabase)
      .from('transactions')
      .update({ paychant_tx_id: result.reference || null })
      .eq('reference', reference)

    const depositAddress = result.deposit?.address

    if (depositAddress) {
      try {
        // Send the grossed-up source cNGN (so the bank receives the full `amount`).
        // First pull from PawasaveLend if needed, then send to Flipeet.
        const cngnMicro = BigInt(Math.floor(offSendNaira * 1_000_000))

        // Pay from custody's RAW cNGN when it already covers the payout, and only
        // tap PawasaveLend for the shortfall — redeeming at most the psNGN shares
        // custody actually holds. Deposits sit in custody as raw cNGN until they're
        // supplied to the pool, so custody usually holds FEWER shares than the DB
        // pool balance implies; the old code always redeemed shares sized to the
        // FULL payout, so lend.withdraw reverted "Insufficient shares" and aborted a
        // withdrawal the raw balance could have settled. Pool redemption is best-effort.
        let available = await custodyCngnBalance()
        if (available < cngnMicro) {
          const custShares = await custodyLendShares()
          if (custShares > 0n) {
            const wantShares = await cngnToShares(cngnMicro - available)
            const redeem     = wantShares < custShares ? wantShares : custShares
            if (redeem > 0n) {
              try {
                const { cngnMicro: realised } = await withdrawFromLend(redeem)
                console.info('Flipeet off-ramp: redeemed pool shortfall', {
                  reference, redeem: redeem.toString(), realised: realised.toString(),
                })
              } catch (poolErr: unknown) {
                console.warn('Flipeet off-ramp: pool redemption failed, using raw custody cNGN', {
                  reference, err: poolErr instanceof Error ? poolErr.message : String(poolErr),
                })
              }
              available = await custodyCngnBalance()
            }
          }
        }

        // V2-MED-05: never send more cNGN than custody actually holds. If the pool
        // redemption came up short and the custody float can't cover the gap, refund
        // and fail cleanly rather than over-drawing the shared float (or reverting
        // deep inside the ERC-20 transfer and leaking gas).
        if (available < cngnMicro) {
          console.error('Flipeet off-ramp: custody cNGN shortfall', {
            reference, needed: cngnMicro.toString(), available: available.toString(),
          })
          await supabase.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: offrampDebitMicro })
          await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
          const e: any = new Error(`Not enough settled cNGN to cover this withdrawal (have ${(Number(available) / 1e6).toFixed(2)}, need ${(Number(cngnMicro) / 1e6).toFixed(2)}) — your balance was refunded.`)
          e.onChainFail = true
          // This path ALREADY refunded. Without this flag the catch below treats the
          // throw as a failed send and refunds a SECOND time — which silently paid a
          // user +₦1,500 per failed withdrawal (observed live, balance ₦1,500→₦4,500
          // after two attempts). Never refund twice for one debit.
          e.alreadyRefunded = true
          throw e
        }

        // Record the destination BEFORE the irreversible send, and CONFIRM it
        // persisted. This marker is what lets the reconciler verify a stranded
        // withdrawal on-chain and complete it. If it can't be durably written, do
        // NOT send: an un-markered send is exactly what stranded a delivered ₦4,900
        // (cNGN left custody, row stuck 'pending', reconciler blind). Throwing here
        // hits the catch below, which refunds — correct, because nothing was sent.
        const marked = await commitSettlementMarker(supabase, reference, depositAddress)
        if (!marked) {
          throw new Error('could not record settlement marker before send — aborted, nothing sent')
        }

        // Send cNGN from custody to Flipeet's dynamic address
        const onChainTxHash = await sendCngn(depositAddress, cngnMicro)

        // Mark the withdrawal COMPLETED now. Sending cNGN to Flipeet's deposit
        // address is the point of no return — PawaSave's side of the off-ramp is
        // irrevocably done and the user's balance was already debited. Flipeet's
        // callback isn't reliable for off-ramps (it often never fires), which used
        // to leave settled withdrawals stuck 'pending' forever even after the bank
        // was credited. The webhook's 'failed' path still refunds if Flipeet later
        // reports a genuine failure.
        await (adminDb() ?? supabase)
          .from('transactions')
          .update({ status: 'completed', description: `Sent via Flipeet — on-chain: ${onChainTxHash}` })
          .eq('reference', reference)

        console.info('Flipeet off-ramp: sent cNGN on-chain', { reference, depositAddress, onChainTxHash })

        // Email receipt — never let a mail hiccup fail a completed withdrawal.
        sendWithdrawalEmail(userId, {
          amountNgn: amount, bankName, accountName: holderName, accountNumber, reference,
        }).catch(() => {})
      } catch (sendErr: unknown) {
        // If the on-chain send fails, refund user and mark failed — UNLESS the inner
        // guard already refunded (see e.alreadyRefunded above), otherwise one debit
        // gets refunded twice and inflates the balance.
        console.error('Flipeet off-ramp on-chain transfer failed:', sendErr)
        if (!(sendErr as any)?.alreadyRefunded) {
          await supabase.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: offrampDebitMicro })
        }
        await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
        const reason = sendErr instanceof Error ? ((sendErr as any).shortMessage || sendErr.message) : String(sendErr)
        const e: any = new Error(`Withdrawal couldn't be settled on-chain (${reason}). Your balance was refunded.`)
        e.onChainFail = true
        throw e
      }
    } else {
      // V2-MED-03: no deposit address means we can't settle on-chain. The user was
      // already debited before this call — refund, mark failed, and surface an error
      // instead of leaving the transaction pending forever with funds gone.
      console.error('Flipeet off-ramp: no deposit address in response', result)
      await supabase.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: offrampDebitMicro })
      await (adminDb() ?? supabase).from('transactions').update({ status: 'failed' }).eq('reference', reference)
      throw new Error('Off-ramp failed — no settlement address returned. Your balance was refunded.')
    }
  }

  // Only record fee AFTER debit succeeds — prevents phantom revenue from failed txs
  await recordPlatformFee(
    supabase,
    userId,
    reference,
    type === 'on' ? 'ramp_onramp' : 'ramp_offramp',
    type === 'off' ? Math.round(offrampTotalNaira * 100) : Math.round(amount * 100),
    pawaFeeKobo,
    feePercent,
  )

  return {
    provider: 'flipeet',
    transactionId: result.reference,
    reference,
    bankName: result.deposit?.bank_name,
    bankCode: result.deposit?.bank_code,
    accountNumber: result.deposit?.account_number,
    accountName: result.deposit?.account_name,
    depositAddress: result.deposit?.address,
    amount: Math.round(amount), // net the recipient receives
    currency: result.destination?.currency || result.deposit?.asset,
    network: result.destination?.network || process.env.FLIPEET_NETWORK || 'base',
    pawaFee: pawaFeeNaira,
    providerFee: type === 'off' ? offFlipeetFeeNaira : providerFeeNaira,
    totalFee: pawaFeeNaira + (type === 'off' ? offFlipeetFeeNaira : providerFeeNaira),
    feePercent,
  }
}

// Lite-tier (BVN-only, no biometric KYC) WITHDRAWAL cap. Unverified users can deposit
// any amount, but can only off-ramp up to this per withdrawal — bigger cash-out needs
// full (Sense) KYC. "Full" is exactly kyc_status='verified' (see migration 058), so we
// key off kyc_status and never read the new kyc_tier column — safe to deploy in any
// order relative to the migration.
const LITE_KYC_CAP_NGN  = Number(process.env.LITE_KYC_CAP_NGN)  || 20000      // no BVN yet — per withdrawal
const BVN_DAILY_CAP_NGN = Number(process.env.BVN_DAILY_CAP_NGN) || 3_000_000  // BVN-verified (tier 1) — per rolling 24h; above this needs full (Sense) KYC

async function enforceWithdrawalKycCap(
  supabase: any,
  userId: string,
  amountNaira: number,
): Promise<NextResponse | null> {
  const { data: profile } = await supabase
    .from('profiles').select('kyc_status, strails_va_account_number').eq('id', userId).single()
  if (profile?.kyc_status === 'verified') return null // full biometric KYC — no cap

  // No BVN yet → the old low per-withdrawal cap; adding a BVN (Naira account) lifts it.
  if (!profile?.strails_va_account_number) {
    if (amountNaira > LITE_KYC_CAP_NGN) {
      return NextResponse.json(
        {
          error: `Add your BVN to get a Naira account and withdraw more than ₦${LITE_KYC_CAP_NGN.toLocaleString()}.`,
          code: 'KYC_REQUIRED',
          cap: LITE_KYC_CAP_NGN,
        },
        { status: 403 },
      )
    }
    return null
  }

  // BVN-verified (tier 1): up to ₦3,000,000 per rolling 24 hours (above → full Sense KYC,
  // which is uncapped above). Sum this user's own
  // recent withdrawals (completed + still-pending, so parallel requests can't bypass it).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: rows } = await supabase
    .from('transactions')
    .select('amount_kobo')
    .eq('user_id', userId)
    .eq('type', 'withdrawal')
    .in('status', ['completed', 'pending'])
    .gte('created_at', since)
  const usedNaira = (rows || []).reduce((s: number, r: any) => s + (Number(r.amount_kobo) || 0) / 100, 0)

  if (usedNaira + amountNaira > BVN_DAILY_CAP_NGN) {
    const remaining = Math.max(0, Math.floor(BVN_DAILY_CAP_NGN - usedNaira))
    return NextResponse.json(
      {
        error: remaining > 0
          ? `Daily withdrawal limit is ₦${BVN_DAILY_CAP_NGN.toLocaleString()}. You have ₦${remaining.toLocaleString()} left today.`
          : `You've reached your ₦${BVN_DAILY_CAP_NGN.toLocaleString()} daily withdrawal limit. Try again tomorrow.`,
        code: 'DAILY_LIMIT',
        cap: BVN_DAILY_CAP_NGN,
        remaining,
      },
      { status: 403 },
    )
  }
  return null
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase } = await getSupabaseUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json()
    const type = body.type as RampType
    const amount = Number(body.amount)
    const bankCode = body.bankCode as string | undefined
    const bankName = body.bankName as string | undefined
    const accountNumber = body.accountNumber as string | undefined
    const transactionPin = body.transactionPin as string | undefined
    const holderName = body.holderName as string | undefined
    const depositCurrency = (body.currency === 'USD' ? 'USD' : 'NGN') as 'NGN' | 'USD'

    // USD on-ramp: min $1. NGN on-ramp: Flint's ₦2,000 floor. NGN off-ramp: ₦100.
    const minAmount = depositCurrency === 'USD' ? 1 : (type === 'on' ? FLINT_MIN_ONRAMP_NGN : 100)
    if ((type !== 'on' && type !== 'off') || !Number.isFinite(amount) || amount < minAmount) {
      const minMsg = depositCurrency === 'USD'
        ? 'Minimum deposit is $1'
        : `Minimum ${type === 'off' ? 'withdrawal' : 'deposit'} is ₦${minAmount.toLocaleString()}`
      return NextResponse.json({ error: minMsg }, { status: 400 })
    }

    if (type === 'off' && (!bankCode || !accountNumber)) {
      return NextResponse.json({ error: 'Bank details required for withdrawal' }, { status: 400 })
    }

    if (type === 'off') {
      const pinError = await ensureWithdrawalPin(supabase, user.id, transactionPin || '')
      if (pinError) return pinError
      // Tiered KYC: deposits are uncapped; only withdrawals are capped for un-verified
      // (lite/none) users at ₦20k. Full biometric KYC lifts it.
      const capError = await enforceWithdrawalKycCap(supabase, user.id, amount)
      if (capError) return capError
    }

    const feePercent = await getNumberSetting(supabase, 'ramp_fee_percent', DEFAULT_FEE_PERCENT)
    const pawaFee = Math.round((amount * feePercent) / 100)
    const availableProviders: Provider[] = []

    // Provider routing:
    //  - On-ramp (fiat → cNGN): Flint delivers cNGN to custody. Flipeet is NOT
    //    used here — it does not accept cNGN on-ramp (V2 on-ramp fix).
    //  - Off-ramp (cNGN → fiat): Flipeet (custody sends cNGN to its address).
    // Flint/Xend are NGN-only.
    if (FLINT_CONFIGURED && type === 'on' && depositCurrency === 'NGN') availableProviders.push('flint')
    if (XEND_CONFIGURED && depositCurrency === 'NGN') availableProviders.push('xend')
    if (FLIPEET_CONFIGURED && type === 'off') availableProviders.push('flipeet')

    if (availableProviders.length === 0) {
      const reason =
        type === 'on'
          ? (depositCurrency === 'USD'
              ? 'USD on-ramp is not currently available.'
              : 'No on-ramp provider configured. Enable Flint (FLINT_ENABLED=true + FLINT_API_KEY) for fiat → cNGN deposits.')
          : 'No off-ramp provider configured. Set FLIPEET_API_KEY and FLIPEET_CUSTODY_ADDRESS.'
      return NextResponse.json({ error: reason }, { status: 503 })
    }

    const estimatedFlint = pawaFee + calcFlintFees(amount, type)
    const estimatedXend = pawaFee + await getNumberSetting(supabase, 'xend_estimated_fee_naira', DEFAULT_XEND_ESTIMATED_FEE)
    const flipeetRate = availableProviders.includes('flipeet') ? await getFlipeetRate(type).catch(() => null) : null
    const estimatedFlipeet = pawaFee + await getNumberSetting(
      supabase,
      'flipeet_estimated_fee_naira',
      Number(flipeetRate?.rate) > 0 ? 0 : DEFAULT_FLIPEET_ESTIMATED_FEE,
    )

    const orderedProviders = [...availableProviders].sort((a, b) => {
      const feeA = a === 'flint'
        ? estimatedFlint
        : a === 'xend'
          ? estimatedXend
          : estimatedFlipeet
      const feeB = b === 'flint'
        ? estimatedFlint
        : b === 'xend'
          ? estimatedXend
          : estimatedFlipeet
      return feeA - feeB
    })

    const run = async (provider: Provider) => {
      if (provider === 'flint') return runFlint(request, supabase, user.id, type, amount)
      if (provider === 'flipeet') return runFlipeet(request, supabase, user.id, type, amount, bankCode, accountNumber, holderName, bankName, depositCurrency)
      return runXend(supabase, user.id, type, amount, bankCode, accountNumber, holderName)
    }

    try {
      const result = await run(orderedProviders[0])
      return NextResponse.json({ ...result, selectedBy: 'best_rate' })
    } catch (primaryErr: any) {
      // Surface genuine validation errors (e.g. amount below the provider minimum)
      // with their real message — safe and actionable, not a provider outage.
      if (primaryErr?.isValidation) {
        return NextResponse.json({ error: primaryErr.message }, { status: 400 })
      }
      // Never fall back for off-ramps: every run*() debits the user's balance before
      // calling the provider and refunds on failure. A fallback would debit a second time.
      if (type === 'off') {
        if (primaryErr?.message === 'INSUFFICIENT_BALANCE') {
          return NextResponse.json({ error: 'Insufficient balance for this withdrawal.' }, { status: 400 })
        }
        // On-chain settlement failures are our OWN custody errors (not a provider
        // secret) and are actionable — surface the real reason instead of masking.
        if (primaryErr?.onChainFail) {
          console.error('Ramp off-ramp on-chain failure', { message: primaryErr?.message })
          return NextResponse.json({ error: primaryErr.message }, { status: 422 })
        }
        const errMsg = formatProviderError(orderedProviders[0], primaryErr)
        console.error('Ramp off-ramp failure', { provider: orderedProviders[0], primaryErr })
        return NextResponse.json({ error: errMsg }, { status: 422 })
      }
      const fallbackProvider = orderedProviders[1]
      if (!fallbackProvider) {
        const errMsg = formatProviderError(orderedProviders[0], primaryErr)
        console.error('Ramp provider failure', { provider: orderedProviders[0], primaryErr })
        return NextResponse.json({ error: errMsg }, { status: 422 })
      }

      try {
        const result = await run(fallbackProvider)
        return NextResponse.json({ ...result, selectedBy: 'fallback' })
      } catch (fallbackErr: any) {
        const errMsg = formatProviderError(orderedProviders[0], primaryErr)
        console.error('Ramp provider failure', { providers: orderedProviders, primaryErr, fallbackErr })
        return NextResponse.json({ error: errMsg }, { status: 422 })
      }
    }
  } catch (err: any) {
    console.error('Ramp API error:', err)
    return NextResponse.json({ error: err.message || 'Server error' }, { status: 500 })
  }
}
