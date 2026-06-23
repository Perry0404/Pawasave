const FLINT_BASE = 'https://stables.flintapi.io/v1'
const FLIPEET_BASE = 'https://api.pay.flipeet.io/api/v1/public'
const FALLBACK_RATE = Number(process.env.NGN_USD_RATE || 1650) // V1 FIND-3P-04: was 1550

/**
 * Last-good rate cache (V2-LOW-03). Two jobs:
 *  1. Within RATE_CACHE_TTL_MS, return the cached value so a burst of calls
 *     (e.g. the oracle cron pricing several tokens) doesn't hammer the provider.
 *  2. When the provider is unreachable, return the last value we successfully
 *     fetched instead of jumping to the static FALLBACK_RATE — a stale-but-real
 *     rate is safer for crediting/pricing than a hard-coded guess.
 */
const RATE_TTL_MS = Number(process.env.RATE_CACHE_TTL_MS || 60_000)
const rateCache = new Map<string, { at: number; value: number }>()

function freshRate(key: string): number | null {
  const c = rateCache.get(key)
  return c && Date.now() - c.at < RATE_TTL_MS ? c.value : null
}
function lastGoodRate(key: string): number | null {
  return rateCache.get(key)?.value ?? null
}
function rememberRate(key: string, value: number): number {
  rateCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Canonical kobo ↔ cNGN-micro conversions (V2-LOW-01). cNGN is pegged 1:1 to NGN
 * with 6 decimals, so these are exact and provider-independent — use these
 * instead of inline magic numbers or USD/NGN rate detours.
 *   1 kobo = 0.01 NGN = 10_000 micro   (a synchronous NGN→micro helper is
 *   ngnToCngnMicro below, which honours the live peg rate)
 */
export function koboToCngnMicro(kobo: number): number {
  return Math.floor(kobo * 10_000)
}
export function cngnMicroToKobo(micro: number): number {
  return Math.floor(micro / 10_000)
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function extractRate(payload: any): number | null {
  if (!payload || typeof payload !== 'object') return null

  const direct = asNumber(payload.rate)
    || asNumber(payload.ngnUsdRate)
    || asNumber(payload.data?.rate)
    || asNumber(payload.data?.ngnUsdRate)
    || asNumber(payload.data?.buyRate)
    || asNumber(payload.data?.sellRate)
  if (direct) return direct

  const list = payload.data?.rates || payload.rates
  if (Array.isArray(list)) {
    for (const item of list) {
      const src = String(item?.from || item?.source || '').toUpperCase()
      const dst = String(item?.to || item?.target || '').toUpperCase()
      if (src === 'NGN' && (dst === 'USDC' || dst === 'USD')) {
        const v = asNumber(item?.rate || item?.value || item?.price)
        if (v) return v
      }
    }
  }

  return null
}

/**
 * Get the live NGN/USD rate directly from Flipeet's on-ramp rate endpoint.
 * This is Flipeet's own rate — use for crediting users after Flipeet deposits.
 */
export async function getNgnUsdRateFromFlipeet(): Promise<number> {
  const KEY = 'flipeet:ngnusd'
  const cached = freshRate(KEY)
  if (cached !== null) return cached

  const apiKey = process.env.FLIPEET_API_KEY
  if (apiKey) {
    try {
      const res = await fetch(`${FLIPEET_BASE}/on-ramp/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ asset: 'cngn', network: 'base', currency: 'NGN', country: 'NG' }),
        next: { revalidate: 30 },
      })
      if (res.ok) {
        const data = await res.json()
        const rate = asNumber(data?.data?.data?.rate || data?.data?.rate || data?.rate)
        if (rate) return rememberRate(KEY, rate)
      }
    } catch {}
  }
  return lastGoodRate(KEY) ?? FALLBACK_RATE
}

/**
 * Get the official cNGN/NGN rate from cNGN's developer API.
 * cNGN is pegged 1:1 with NGN by design, but the API confirms the live rate.
 * Falls back to 1.0 (perfect peg) if the API is unreachable.
 */
export async function getCngnNgnRate(): Promise<number> {
  const KEY = 'cngn:ngn'
  const cached = freshRate(KEY)
  if (cached !== null) return cached

  try {
    const res = await fetch('https://api.cngn.co/v1/rates', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (res.ok) {
      const data = await res.json()
      // cNGN API returns rate in various formats — try common shapes
      const rate = asNumber(data?.rate)
        || asNumber(data?.data?.rate)
        || asNumber(data?.cngnNgn)
        || asNumber(data?.data?.cngnNgn)
      if (rate && rate > 0) return rememberRate(KEY, rate)
    }
  } catch {
    // cNGN API unreachable — use last good, else the 1:1 peg
  }
  return lastGoodRate(KEY) ?? 1.0 // 1 cNGN = 1 NGN (the peg)
}

/**
 * Convert NGN amount to cNGN micro units using the official cNGN rate.
 * e.g. 10,000 NGN → 10,000 cNGN → 10_000_000_000 micro (6 decimals)
 */
export async function ngnToCngnMicro(ngnAmount: number): Promise<bigint> {
  const rate = await getCngnNgnRate()
  return BigInt(Math.floor(ngnAmount * rate * 1_000_000))
}

export async function getNgnUsdRateFromFlint(apiKey?: string): Promise<number> {
  const KEY = 'flint:ngnusd'
  const cached = freshRate(KEY)
  if (cached !== null) return cached

  // Try Flint endpoints first
  if (apiKey) {
    const endpoints = [
      `${FLINT_BASE}/ramp/rate?from=NGN&to=USDC`,
      `${FLINT_BASE}/ramp/rates`,
      `${FLINT_BASE}/rates`,
    ]

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: { 'x-api-key': apiKey },
          next: { revalidate: 30 },
        })
        if (!res.ok) continue
        const data = await res.json()
        const rate = extractRate(data)
        if (rate) return rememberRate(KEY, rate)
      } catch {
        // Try next endpoint
      }
    }
  }

  // Fallback: try Flipeet rate endpoint (no auth needed for rate)
  const flipeetApiKey = process.env.FLIPEET_API_KEY
  if (flipeetApiKey) {
    try {
      const res = await fetch(`${FLIPEET_BASE}/on-ramp/rate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': flipeetApiKey,
        },
        body: JSON.stringify({ asset: 'usdc', network: 'base', currency: 'NGN', country: 'NG' }),
        next: { revalidate: 30 },
      })
      if (res.ok) {
        const data = await res.json()
        const flipeetRate = asNumber(
          data?.data?.data?.rate
          || data?.data?.rate
          || data?.rate,
        )
        if (flipeetRate) return rememberRate(KEY, flipeetRate)
      }
    } catch {
      // Fall through to last-good, then static fallback
    }
  }

  return lastGoodRate(KEY) ?? FALLBACK_RATE
}
