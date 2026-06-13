import { NextRequest, NextResponse } from 'next/server'

/**
 * Fail-closed authentication for /api/cron/* endpoints.
 *
 * Returns a NextResponse to return immediately when auth fails, or `null` when
 * the request is authorised and the handler may proceed.
 *
 * Security (FIND-API-06): if CRON_SECRET is unset the route REFUSES the request
 * (503) instead of accepting it. Vercel Cron sends `Authorization: Bearer <secret>`
 * automatically when CRON_SECRET is configured in the project.
 */
export function checkCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron] CRON_SECRET not set — refusing request (fail closed)')
    return NextResponse.json({ error: 'Cron not configured' }, { status: 503 })
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}