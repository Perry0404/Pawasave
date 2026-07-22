import { NextResponse } from 'next/server'
import { custodyAddress } from '@/lib/custody'
import { STRAILS_ENABLED, getFintechVirtualAccount } from '@/lib/strails'

/**
 * GET /api/ramp/status — is the naira on-ramp actually usable right now?
 *
 * The Receive screen needs an honest answer BEFORE the user commits. A provider
 * outage used to be swallowed by a silent fallback to the crypto address, so it
 * looked like the naira option had been removed.
 *
 * The naira rail is STRAILS now, not Flint: each verified user gets a permanent
 * NUBAN and transfers to it mint cNGN. So this probes Strails — probing Flint here
 * reported "bank partner outage" while naira deposits were in fact working, which
 * is worse than no banner at all.
 *
 * Probe = getfintechvirtualaccount (read-only, creates nothing, so it's cheap to
 * poll in either state). It exercises the whole path that matters: the fixed-IP
 * relay, the IP allowlist, and the API key. Flint is kept only as a fallback for
 * when Strails is disabled.
 */
export const dynamic = 'force-dynamic'

const FLINT_BASE = 'https://stables.flintapi.io/v1'
const DOWN_TTL_MS = Number(process.env.RAMP_STATUS_DOWN_TTL_MS) || 120_000
const UP_TTL_MS = Number(process.env.RAMP_STATUS_UP_TTL_MS) || 600_000
const PROBE_TIMEOUT_MS = 8000

type Availability = { available: boolean; reason?: string; provider?: string }
let cache: { at: number; ttl: number; body: unknown } | null = null

/** Strails: the live naira rail (permanent per-user NUBANs). */
async function probeStrails(): Promise<Availability> {
  try {
    const acct = await getFintechVirtualAccount()
    if (acct?.accountNumber) return { available: true, provider: 'strails' }
    return { available: false, provider: 'strails', reason: 'Bank deposits are being set up' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // IP_NOT_ALLOWED means the relay's IP fell off the allowlist — an operator
    // problem, not a user one, but the rail really is down until it's fixed.
    if (/IP_NOT_ALLOWED|IP_ALLOWLIST/i.test(msg)) {
      return { available: false, provider: 'strails', reason: 'Bank deposits are temporarily offline' }
    }
    if (/access denied|invalid api key/i.test(msg)) {
      return { available: false, provider: 'strails', reason: 'Our bank partner rejected our credentials' }
    }
    return { available: false, provider: 'strails', reason: 'Our bank partner is unreachable' }
  }
}

/** Legacy Flint path — only used when Strails is turned off. */
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

    if (res.ok) return { available: true, provider: 'flint' }
    if (res.status === 401 || res.status === 403) {
      return { available: false, provider: 'flint', reason: 'Our bank partner rejected our credentials' }
    }
    if (res.status >= 500) {
      return { available: false, provider: 'flint', reason: 'Our bank partner is having an outage' }
    }
    return { available: false, provider: 'flint', reason: `Bank deposits are unavailable (${res.status})` }
  } catch {
    return { available: false, provider: 'flint', reason: 'Our bank partner is unreachable' }
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < cache.ttl) {
    return NextResponse.json(cache.body)
  }
  const naira = STRAILS_ENABLED ? await probeStrails() : await probeFlint()
  const body = {
    naira,
    crypto: { available: true }, // self-hosted HD address — always available
    checkedAt: new Date().toISOString(),
  }
  cache = { at: Date.now(), ttl: naira.available ? UP_TTL_MS : DOWN_TTL_MS, body }
  console.info('[ramp/status] naira on-ramp:', naira.available ? `UP (${naira.provider})` : `DOWN — ${naira.reason}`)
  return NextResponse.json(body)
}