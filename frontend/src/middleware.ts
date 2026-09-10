import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// ── Rate limiting (FIND-API-05) ──────────────────────────────────────────────
// Preferred: Upstash Redis (persistent — survives serverless cold starts, so an
// attacker can't reset their counter by forcing new processes). Set
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to enable. Falls back to an
// in-memory limiter when Upstash isn't configured (dev / single instance).

const RATE_LIMIT_WINDOW = 60_000 // 1 minute
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

// Tighter limits on sensitive surfaces; generous default elsewhere.
function limitFor(path: string): { max: number; bucket: string } {
  if (path.startsWith('/api/admin')) return { max: 10, bucket: 'admin' }
  if (path.startsWith('/api/ramp'))  return { max: 15, bucket: 'ramp' }
  return { max: 30, bucket: 'api' }
}

function checkRateLimitMemory(key: string, max: number): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

// Returns the post-increment count, or null if Upstash isn't configured/errored
// (caller then falls back to the in-memory limiter / fails open).
async function upstashIncr(key: string): Promise<number | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, Math.ceil(RATE_LIMIT_WINDOW / 1000)],
      ]),
      // never let the limiter add meaningful latency / hang the request
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const data = await res.json()
    const count = Array.isArray(data) ? Number(data[0]?.result) : NaN
    return Number.isFinite(count) ? count : null
  } catch {
    return null // fail open on Redis error — availability over strictness
  }
}

// Clean up stale in-memory entries periodically.
if (typeof globalThis !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    rateLimitMap.forEach((val, key) => {
      if (now > val.resetAt) rateLimitMap.delete(key)
    })
  }, 60_000)
}

// Runs on /api/* ONLY (see matcher). Security headers moved to next.config `headers()`
// so they apply to every route without a per-request middleware invocation — the
// matcher below keeps middleware off pages/assets, which is the main cost saver.
export async function middleware(request: NextRequest) {
  // Rate limit API routes
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
  const { max, bucket } = limitFor(request.nextUrl.pathname)
  const key = `rl:${bucket}:${ip}`

  const count = await upstashIncr(key)
  const allowed = count === null ? checkRateLimitMemory(key, max) : count <= max

  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429 },
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}