import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { isAuthorisedAdmin } from '@/lib/admin-session'

/**
 * Proxy member wallets (Xend POS rail).
 *
 *   GET  /api/proxy?what=member      the caller's own proxy member id
 *   GET  /api/proxy?what=transfers   recent transfers, admin only
 *   POST /api/proxy { action: 'register', proxyMemberId, provider }
 *   POST /api/proxy { action: 'transfer', proxyMemberId, transferAction, amountUsdcMicro, description }
 *
 * All four functions behind this were callable from the browser. proxy_transfer is the one
 * that mattered: it is described in the code it came from as an admin function, it moves value
 * between the master wallet and member wallets, and it takes a proxy member id rather than a
 * user id, so it carried no notion of who was asking. Any signed-in user could call it for any
 * member. It is now admin-only and checked here.
 *
 * get_proxy_transfers was equally open and lists other people's transfers, so it is admin-only
 * too. Registration and the member lookup stay available to a signed-in user, scoped to
 * themselves.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

async function sessionUser() {
  const store = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => store.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const what = request.nextUrl.searchParams.get('what') || 'member'
    const admin = serviceDb()

    if (what === 'member') {
      const { data, error } = await admin.rpc('get_proxy_member_for_user', { p_user_id: user.id })
      if (error) return NextResponse.json({ proxyMemberId: null })
      return NextResponse.json({ proxyMemberId: (data as string | null) ?? null })
    }

    if (what === 'transfers') {
      // Lists transfers across members, so it is not a customer-facing read.
      if (!process.env.ADMIN_PASSWORD || !isAuthorisedAdmin(request)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? 50)
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50
      const { data, error } = await admin.rpc('get_proxy_transfers', { p_limit: limit })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ transfers: data ?? [] })
    }

    return NextResponse.json({ error: "what must be 'member' or 'transfers'" }, { status: 400 })
  } catch (e: unknown) {
    console.error('[proxy] GET error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const action = body?.action
    const admin = serviceDb()

    if (action === 'register') {
      const proxyMemberId = String(body?.proxyMemberId ?? '').trim()
      if (!proxyMemberId) return NextResponse.json({ error: 'proxyMemberId required' }, { status: 400 })
      const provider = String(body?.provider ?? 'xend').trim() || 'xend'

      // p_user_id comes from the session, never the request body.
      const { data, error } = await admin.rpc('register_proxy_member', {
        p_user_id: user.id, p_proxy_member_id: proxyMemberId, p_provider: provider,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ ok: true, result: data })
    }

    if (action === 'transfer') {
      if (!process.env.ADMIN_PASSWORD || !isAuthorisedAdmin(request, body?.password)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const proxyMemberId = String(body?.proxyMemberId ?? '').trim()
      const transferAction = String(body?.transferAction ?? '').toUpperCase()
      const amountUsdcMicro = Number(body?.amountUsdcMicro)

      if (!proxyMemberId) return NextResponse.json({ error: 'proxyMemberId required' }, { status: 400 })
      if (transferAction !== 'CREDIT' && transferAction !== 'DEBIT') {
        return NextResponse.json({ error: "transferAction must be CREDIT or DEBIT" }, { status: 400 })
      }
      if (!Number.isSafeInteger(amountUsdcMicro) || amountUsdcMicro <= 0) {
        return NextResponse.json({ error: 'amountUsdcMicro must be a positive integer' }, { status: 400 })
      }

      const { data, error } = await admin.rpc('proxy_transfer', {
        p_proxy_member_id: proxyMemberId,
        p_action: transferAction,
        p_amount_usdc_micro: amountUsdcMicro,
        p_description: String(body?.description ?? '').slice(0, 500) || null,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      console.info('[proxy] admin transfer', { proxyMemberId, transferAction, amountUsdcMicro })
      return NextResponse.json({ ok: true, result: data })
    }

    return NextResponse.json({ error: "action must be 'register' or 'transfer'" }, { status: 400 })
  } catch (e: unknown) {
    console.error('[proxy] POST error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
