import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'

/** Server helpers shared by /api/coop/* (migration 116). */

export async function sessionUser() {
  const store = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false },
    global: { fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, { ...init, cache: 'no-store' }) },
  })
}

/** The functions RAISE 'coop: <reason>' for anything a member should see; everything else is generic. */
export function coopError(m?: string) {
  if (!m?.startsWith('coop:')) return 'Something went wrong'
  const s = m.slice(5).trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** ₦ (number or string) → cNGN micro. 1 NGN = 1 cNGN = 1,000,000 micro. */
export const ngnToMicro = (ngn: unknown) => Math.round(Number(ngn || 0) * 100) * 10_000
