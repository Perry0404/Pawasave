import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

/**
 * admin-session.ts — short-lived, httpOnly admin session (V2-HIGH-03).
 *
 * Replaces "store the admin password in sessionStorage and re-send it on every
 * call". On a correct password, /api/admin/verify issues a signed token in an
 * httpOnly cookie (JS can't read it → an XSS payload can't steal it and drain
 * revenue). Admin routes accept the cookie session OR, as a fallback, the
 * password in the body (so nothing breaks during rollout).
 */
const COOKIE = 'pawa_admin'
const TTL_MS = 30 * 60_000 // 30 minutes

function secret(): string {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || ''
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function issueAdminToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyAdminToken(token: string | undefined): boolean {
  if (!token || !secret()) return false
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return false
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return typeof exp === 'number' && Date.now() < exp
  } catch {
    return false
  }
}

export function setAdminCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE, issueAdminToken(), {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: TTL_MS / 1000,
  })
  return res
}

export function clearAdminCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE, '', { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 })
  return res
}

/** Authorised if a valid session cookie is present, OR (fallback) the body password matches. */
export function isAuthorisedAdmin(request: NextRequest, bodyPassword?: string): boolean {
  if (verifyAdminToken(request.cookies.get(COOKIE)?.value)) return true
  const pw = process.env.ADMIN_PASSWORD || ''
  if (!pw || !bodyPassword) return false
  const a = Buffer.from(bodyPassword)
  const b = Buffer.from(pw)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}