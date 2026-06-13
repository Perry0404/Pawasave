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

export async function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // Security headers
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('X-XSS-Protection', '1; mode=block')
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

  // Content-Security-Policy (FIND-INFRA-02). Pragmatic policy that hardens the app
  // without breaking Next.js hydration, Tailwind inline styles, Supabase (https +
  // realtime wss), the Base RPCs, and the external "Featured on Orynth" badge.
  // script-src keeps 'unsafe-inline'/'unsafe-eval' because App Router hydration
  // and dev mode require them without per-request nonces.
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' https: wss:",
    ].join('; '),
  )

  // Rate limit API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
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
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}