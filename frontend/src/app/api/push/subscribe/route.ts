import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { sendPushToUser } from '@/lib/push-send'

/**
 * /api/push/subscribe — store (POST) or remove (DELETE) a Web Push subscription
 * for the signed-in user. Writes with the service role; on subscribe, sends a
 * confirmation push so the user immediately sees it working.
 */
async function getUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export async function POST(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  let sub: any
  try { sub = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const endpoint = sub?.endpoint
  const p256dh = sub?.keys?.p256dh
  const auth = sub?.keys?.auth
  if (!endpoint || !p256dh || !auth) return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })

  const { error } = await admin()
    .from('push_subscriptions')
    .upsert({ user_id: user.id, endpoint, p256dh, auth }, { onConflict: 'endpoint' })
  if (error) return NextResponse.json({ error: 'Could not save subscription' }, { status: 500 })

  // Immediate confirmation so the user sees a notification land.
  sendPushToUser(user.id, { title: 'Notifications on ✓', body: 'You’ll hear from PawaSave about deposits, Ajo payouts and loans.', url: '/' }).catch(() => {})

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  if (!body?.endpoint) return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 })

  await admin().from('push_subscriptions').delete().eq('endpoint', body.endpoint).eq('user_id', user.id)
  return NextResponse.json({ ok: true })
}