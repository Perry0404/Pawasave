import { NextResponse } from 'next/server'
import { clearAdminCookie } from '@/lib/admin-session'

/** POST /api/admin/logout — clears the admin session cookie (V2-HIGH-03). */
export const dynamic = 'force-dynamic'

export async function POST() {
  return clearAdminCookie(NextResponse.json({ ok: true }))
}