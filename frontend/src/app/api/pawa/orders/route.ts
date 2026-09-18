import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

/**
 * GET /api/pawa/orders  → the caller's Pay with Pawa orders, split into purchases (as buyer) and
 * sales (as seller), newest first. Powers the in-app orders/escrow list.
 */
export const dynamic = 'force-dynamic'

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

function serviceDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } })
}

export async function GET() {
  const user = await sessionUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const admin = serviceDb()

  const [{ data: buying }, { data: selling }] = await Promise.all([
    admin.from('pawa_orders')
      .select('id, reference, seller_id, buyer_id, amount_micro, escrow, status, note, surface, auto_release_at, created_at')
      .eq('buyer_id', user.id).order('created_at', { ascending: false }).limit(50),
    admin.from('pawa_orders')
      .select('id, reference, seller_id, buyer_id, amount_micro, escrow, status, note, surface, auto_release_at, created_at')
      .eq('seller_id', user.id).order('created_at', { ascending: false }).limit(50),
  ])

  // Resolve counterparty names in one pass.
  const rows = [...(buying || []), ...(selling || [])]
  const otherIds = Array.from(new Set(rows.flatMap((r: any) => [r.seller_id, r.buyer_id]).filter(Boolean).filter((id) => id !== user.id)))
  const nameById: Record<string, string> = {}
  if (otherIds.length) {
    const { data: profs } = await admin.from('profiles').select('id, display_name, merchant_name, tag').in('id', otherIds)
    for (const p of profs || []) nameById[p.id] = p.merchant_name || p.display_name || (p.tag ? `@${p.tag}` : 'PawaSave user')
  }

  const shape = (r: any, role: 'buyer' | 'seller') => ({
    id: r.id,
    reference: r.reference,
    amountNgn: Number(r.amount_micro) / 1_000_000,
    escrow: Boolean(r.escrow),
    status: r.status,
    note: r.note || null,
    surface: r.surface,
    autoReleaseAt: r.auto_release_at || null,
    createdAt: r.created_at,
    role,
    counterparty: role === 'buyer' ? (nameById[r.seller_id] || 'a seller') : (r.buyer_id ? (nameById[r.buyer_id] || 'a buyer') : 'awaiting payment'),
  })

  return NextResponse.json({
    buying: (buying || []).map((r) => shape(r, 'buyer')),
    selling: (selling || []).map((r) => shape(r, 'seller')),
  })
}
