import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/strails/probe — allowlist diagnostic (cron-auth gated).
 *
 * Strails requires calls to come from a pre-allowlisted IP, but /manageipallowlist
 * must itself be reachable to bootstrap that (chicken-and-egg), so it is very likely
 * exempt. This does the whole bootstrap in ONE invocation — so the egress IP stays
 * constant across all three steps:
 *   1. discover this function's outbound IP
 *   2. register it via /manageipallowlist (payload shape undocumented → try several)
 *   3. immediately retry a read call on both prod and sandbox
 *
 * Kept rather than deleted after the 2026-09-18 outage: it is the only way to check our egress
 * IP and allowlist state WITHOUT calling /onboarduser, and every /onboarduser call counts
 * against Strails' failure-rate limit. Step 3 returns counts and status only, never the
 * customer virtual accounts themselves.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const KEY = process.env.STRAILS_API_KEY || ''
const PROD = 'https://api.strails.io/v1'
const SANDBOX = 'https://beta.stablesrail.io/v1'

async function jsonOrText(res: Response) {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { raw: text.slice(0, 300) } }
}

async function call(url: string, method: 'GET' | 'POST', body?: unknown) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(12_000),
    })
    return { status: res.status, body: await jsonOrText(res) }
  } catch (e) {
    return { status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied
  if (!KEY) return NextResponse.json({ error: 'STRAILS_API_KEY not set' }, { status: 503 })

  // ── 1. what IP do we call out from? ────────────────────────────────────────
  let egressIp = 'unknown'
  for (const svc of ['https://api.ipify.org?format=json', 'https://ifconfig.me/all.json']) {
    try {
      const r = await fetch(svc, { signal: AbortSignal.timeout(8_000) })
      const j: any = await r.json()
      egressIp = j.ip || j.ip_addr || egressIp
      if (egressIp !== 'unknown') break
    } catch { /* try next */ }
  }

  // ── 2. try to register it (payload shape is undocumented) ──────────────────
  // The API told us the exact contract: action + ipAddress.
  const shapes: Array<[string, unknown]> = [
    ['action+ipAddress', { action: 'add', ipAddress: egressIp }],
  ]
  const allowlistAttempts: any[] = []
  let allowlisted = false
  for (const base of [PROD, SANDBOX]) {
    for (const [label, payload] of shapes) {
      const r = await call(`${base}/manageipallowlist`, 'POST', payload)
      const ok = r.status === 200 && !/failed/i.test(String((r.body as any)?.status ?? ''))
      allowlistAttempts.push({ base, shape: label, status: r.status, body: r.body })
      if (ok) { allowlisted = true; break }
    }
    if (allowlisted) break
  }

  // ── 3. retry the read on both environments ────────────────────────────────
  // What we need to know is whether an authenticated read succeeds from this IP, not what it
  // returns. The full body is a list of customer virtual accounts, names and account numbers
  // included, so summarise it: the status and count answer the question on their own.
  const summarise = (r: { status: number; body?: unknown; error?: string }) => {
    const b = r.body as any
    return {
      status: r.status,
      error: r.error ?? null,
      providerStatus: b?.status ?? null,
      message: b?.message ?? null,
      virtualAccounts: Array.isArray(b?.data?.virtualAccounts) ? b.data.virtualAccounts.length : null,
    }
  }
  const after = {
    prod: summarise(await call(`${PROD}/getfintechvirtualaccount`, 'GET')),
    sandbox: summarise(await call(`${SANDBOX}/getfintechvirtualaccount`, 'GET')),
  }

  return NextResponse.json({ ok: true, egressIp, allowlisted, allowlistAttempts, after })
}