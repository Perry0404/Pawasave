const BASE_URL = process.env.FLIPEET_BASE_URL || 'https://api.pay.flipeet.io/api/v1/public'
const API_KEY = process.env.FLIPEET_API_KEY || ''
const DEFAULT_COUNTRY = process.env.FLIPEET_COUNTRY_CODE || 'NG'
const DEFAULT_ASSET = process.env.FLIPEET_ASSET || 'usdc'
const DEFAULT_NETWORK = process.env.FLIPEET_NETWORK || 'base'
const DEFAULT_CURRENCY = process.env.FLIPEET_FIAT_CURRENCY || 'NGN'

type FlipeetEnvelope<T> = {
  message?: string
  status?: string
  statusCode?: number
  data?: {
    success?: boolean
    message?: string
    timestamp?: string
    data?: T
  }
}

export class FlipeetApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'FlipeetApiError'
    this.status = status
  }
}

export interface FlipeetRateResult {
  currency?: string
  channel?: string
  rate?: number
}

export interface FlipeetInitResult {
  status?: string
  type?: string
  reference?: string
  beneficiary?: string
  rate?: number
  developer_fee?: {
    amount?: number
    amount_usd?: number
    currency?: string
    network?: string
    recipient?: string
  }
  source?: {
    amount?: number
    amount_usd?: number
    currency?: string
    network?: string
  }
  destination?: {
    amount?: number
    amount_usd?: number
    currency?: string
    network?: string
  }
  deposit?: {
    amount?: number
    provider?: string
    expires_at?: string
    account_id?: string
    account_number?: string
    account_name?: string
    bank_code?: string
    bank_name?: string
    address?: string
    asset?: string
    note?: string[]
  }
  meta?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

function getHeaders() {
  if (!API_KEY) {
    throw new FlipeetApiError('Flipeet provider unavailable', 503)
  }

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
  }
}

async function request<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  })

  const json = (await res.json().catch(() => null)) as FlipeetEnvelope<T> | null
  const message =
    json?.data?.message
    || json?.message
    || `Flipeet API error ${res.status}`

  if (!res.ok || json?.status === 'failed' || json?.data?.success === false || !json?.data?.data) {
    throw new FlipeetApiError(message, res.status)
  }

  return json.data.data
}

export async function getFlipeetRate(type: 'on' | 'off'): Promise<FlipeetRateResult> {
  return request<FlipeetRateResult>(
    type === 'on' ? '/on-ramp/rate' : '/off-ramp/rate',
    {
      asset: DEFAULT_ASSET,
      network: DEFAULT_NETWORK,
      currency: DEFAULT_CURRENCY,
      country: DEFAULT_COUNTRY,
    },
  )
}

export async function initializeFlipeetOnRamp(params: {
  amount: number
  reference: string
  callbackUrl: string
  walletAddress: string
  holderName?: string
}) {
  return request<FlipeetInitResult>('/on-ramp/initialize', {
    amount: Math.round(params.amount),
    asset: DEFAULT_ASSET,
    network: DEFAULT_NETWORK,
    currency: DEFAULT_CURRENCY,
    country: DEFAULT_COUNTRY,
    beneficiary: {
      holder_type: 'BUSINESS',
      holder_name: params.holderName || 'PawaSave Treasury',
      wallet_address: params.walletAddress,
    },
    callback_url: params.callbackUrl,
    reference: params.reference,
    channel: 'BANK',
    reason: 'OTHER',
  })
}

export async function initializeFlipeetOffRamp(params: {
  amount: number
  reference: string
  callbackUrl: string
  bankCode: string
  accountNumber: string
  holderName?: string
}) {
  return request<FlipeetInitResult>('/off-ramp/initialize', {
    amount: Math.round(params.amount),
    asset: DEFAULT_ASSET,
    network: DEFAULT_NETWORK,
    currency: DEFAULT_CURRENCY,
    country: DEFAULT_COUNTRY,
    beneficiary: {
      holder_type: 'INDIVIDUAL',
      holder_name: params.holderName || 'PawaSave User',
      account_number: params.accountNumber,
      bank_code: params.bankCode,
    },
    callback_url: params.callbackUrl,
    reference: params.reference,
    channel: 'BANK',
    reason: 'OTHER',
  })
}