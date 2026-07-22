import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'

/**
 * GET /api/strails/probe — TEMPORARY diagnostic (cron-auth gated).
 *
 * Strails requires calls to come from a pre-allowlisted IP, but /manageipallowlist
 * must itself be reachable to bootstrap that (chicken-and-egg), so it is very likely
 * exempt. This does the whole bootstrap in ONE invocation — so the egress IP stays
 * constant across all three steps:
 *   1. discover this function's outbound IP
 *   2. register it via /manageipallowlist (payload shape undocumented → try several)
 *   3. immediately retry a read call on both prod and sandbox
 *
 * Delete once the integration is wired.
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
  const shapes: Array<[string, unknown]> = [
    ['ips[]', { ips: [egressIp] }],
    ['ip', { ip: egressIp }],
    ['ipAddresses[]', { ipAddresses: [egressIp] }],
    ['action+ips[]', { action: 'add', ips: [egressIp] }],
    ['action+ip', { action: 'add', ip: egressIp }],
    ['whitelist[]', { whitelist: [egressIp] }],
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
  const after = {
    prod: await call(`${PROD}/getfintechvirtualaccount`, 'GET'),
    sandbox: await call(`${SANDBOX}/getfintechvirtualaccount`, 'GET'),
  }

  return NextResponse.json({ ok: true, egressIp, allowlisted, allowlistAttempts, after })
}