import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/strails/probe  — TEMPORARY diagnostic (cron-auth gated).
 *
 * The Strails API hosts sit behind Cloudflare and drop connections from some
 * networks, and their docs never say how the issued `aesKey` is used. Rather than
 * guess an encryption scheme, this endpoint calls a harmless read-only Strails
 * endpoint FROM Vercel's egress (the real integration path) and reports exactly
 * what comes back: HTTP status, content-type, and whether the body is plain JSON
 * or an encrypted blob. That single answer decides how the client is built.
 *
 * Delete this route once the integration is wired.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const KEY = process.env.STRAILS_API_KEY || ''

function shape(text: string) {
  const trimmed = text.trim()
  let json: unknown = null
  try { json = JSON.parse(trimmed) } catch { /* not json */ }
  const isHex = /^[0-9a-fA-F]{32,}$/.test(trimmed)
  const isB64 = /^[A-Za-z0-9+/=]{40,}$/.test(trimmed) && !json
  return {
    isJson: json !== null,
    looksEncrypted: isHex || isB64,
    preview: trimmed.slice(0, 300),
    json: json ?? undefined,
  }
}

async function hit(base: string, path: string, method: 'GET' | 'POST', body?: unknown) {
  const url = `${base}${path}`
  try {
    const res = await fetch(url, {
      method,
      headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      // fail fast — we just want the shape
      signal: AbortSignal.timeout(12_000),
    })
    const text = await res.text()
    return { url, method, status: res.status, contentType: res.headers.get('content-type'), ...shape(text) }
  } catch (e) {
    return { url, method, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!KEY) return NextResponse.json({ error: 'STRAILS_API_KEY not set' }, { status: 503 })

  const bases = [
    process.env.STRAILS_BASE_URL || 'https://api.strails.io/v1',
    'https://beta.stablesrail.io/v1',
  ]
  const results = []
  for (const base of bases) {
    // read-only: retrieve our own fintech virtual account
    results.push(await hit(base, '/getfintechvirtualaccount', 'GET'))
    results.push(await hit(base, '/getfintechvirtualaccount', 'POST'))
  }
  return NextResponse.json({ ok: true, keyLen: KEY.length, results })
}