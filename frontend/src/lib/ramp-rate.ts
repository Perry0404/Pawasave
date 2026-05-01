const FLINT_BASE = 'https://stables.flintapi.io/v1'
const FLIPEET_BASE = 'https://api.pay.flipeet.io/api/v1/public'
const FALLBACK_RATE = Number(process.env.NGN_USD_RATE || 1550)

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

export async function getNgnUsdRateFromFlint(apiKey?: string): Promise<number> {
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
        if (rate) return rate
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
        if (flipeetRate) return flipeetRate
      }
    } catch {
      // Fall through to static fallback
    }
  }

  return FALLBACK_RATE
}
