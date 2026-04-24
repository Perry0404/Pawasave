const FLINT_BASE = 'https://stables.flintapi.io/v1'
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
  if (!apiKey) return FALLBACK_RATE

  const endpoints = [
    `${FLINT_BASE}/rates`,
    `${FLINT_BASE}/ramp/rates`,
    `${FLINT_BASE}/ramp/rate?from=NGN&to=USDC`,
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
      // Try next endpoint and fall back if none works.
    }
  }

  return FALLBACK_RATE
}
