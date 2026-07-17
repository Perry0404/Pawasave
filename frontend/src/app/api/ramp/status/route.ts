import { NextResponse } from 'next/server'
import { custodyAddress } from '@/lib/custody'

/**
 * GET /api/ramp/status — is the fiat (naira) on-ramp actually usable right now?
 *
 * The Receive screen needs an honest answer BEFORE the user types an amount.
 * A Flint outage used to be swallowed by a silent fallback to the crypto address,
 * so a provider failure looked like the naira option had been removed. This
 * reports the real state so the UI can show "temporarily unavailable" instead.
 *
 * How we probe (verified against Flint 2026-07-16):
 *   • /ramp/rate*        → 401 for everyone, regardless of health. Useless signal.
 *   • /ramp/initialise, amount below minimum → 400 validation. Proves auth only —
 *     it never reaches the code that's actually broken, so it can't detect an outage.
 *   • /ramp/initialise, FULL valid payload → the only true test. Today it returns
 *     500 "Failed to initialize ramp transaction", while a malformed body still
 *     returns 422 — i.e. their validation is fine and ramp creation is broken.
 *     Their bug, not ours. (A one-off diagnostic confirmed every asset 500s, so the
 *     outage is not specific to cNGN — PawaSave is cNGN-only and stays that way.)
 *
 * Side effects: while Flint is DOWN the probe 500s, so nothing is created — we can
 * poll cheaply. The moment it recovers, one throwaway unpaid intent is created, so
 * we cache "up" for a long time to avoid minting more; real user traffic surfaces
 * any later failure anyway.
 */
export const dynamic = 'force-dynamic'

const FLINT_BASE = 'https://stables.flintapi.io/v1'
const DOWN_TTL_MS = Number(process.env.RAMP_STATUS_DOWN_TTL_MS) || 120_000
const UP_TTL_MS = Number(process.env.RAMP_STATUS_UP_TTL_MS) || 3_600_000
const PROBE_TIMEOUT_MS = 8000

type Availability = { available: boolean; reason?: string }
let cache: { at: number; ttl: number; body: unknown } | null = null

async function probeFlint(): Promise<Availability> {
  const key = process.env.FLINT_API_KEY
  if (!key) return { available: false, reason: 'Bank deposits are not set up yet' }
  if (process.env.FLINT_ENABLED !== 'true') return { available: false, reason: 'Bank deposits are turned off' }

  let dest = ''
  try { dest = await custodyAddress() } catch { /* fall through */ }
  if (!dest) return { available: false, reason: 'Bank deposits are not set up yet' }

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    const res = await fetch(`${FLINT_BASE}/ramp/initialise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      signal: ctrl.signal,
      cache: 'no-store',
      body: JSON.stringify({
        type: 'on',
        reference: `probe-${Date.now()}`,
        network: 'base',
        asset: process.env.FLINT_ASSET || 'cngn',
        currency: 'NGN',
        fiatCurrency: 'NGN',
        amount: Number(process.env.FLINT_MIN_ONRAMP_NGN) || 2000,
        destination: { address: dest },
      }),
    })
    clearTimeout(t)

    if (res.ok) return { available: true }
    if (res.status === 401 || res.status === 403) {
      return { available: false, reason: 'Our bank partner rejected our credentials' }
    }
    if (res.status >= 500) {
      return { available: false, reason: 'Our bank partner is having an outage' }
    }
    // 4xx that isn't auth = our payload drifted from their schema — surface it as
    // down (users can't deposit either way) but keep the code so we can see it.
    return { available: false, reason: `Bank deposits are unavailable (${res.status})` }
  } catch {
    return { available: false, reason: 'Our bank partner is unreachable' }
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < cache.ttl) {
    return NextResponse.json(cache.body)
  }
  const naira = await probeFlint()
  const body = {
    naira,
    crypto: { available: true }, // self-hosted HD address — always available
    checkedAt: new Date().toISOString(),
  }
  cache = { at: Date.now(), ttl: naira.available ? UP_TTL_MS : DOWN_TTL_MS, body }
  console.info('[ramp/status] naira on-ramp:', naira.available ? 'UP' : `DOWN — ${naira.reason}`)
  return NextResponse.json(body)
}