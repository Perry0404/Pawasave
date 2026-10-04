import { NextRequest, NextResponse } from 'next/server'
import { sessionUser, serviceDb, coopError, ngnToMicro } from '@/lib/coop-server'

/**
 * Cooperative societies (migration 116).
 *
 *   GET  /api/coop                          → the caller's societies, with fund and what they owe
 *   POST /api/coop { action: 'create', name, description?, duesNgn, period, entranceNgn?, approvals? }
 *   POST /api/coop { action: 'join', code }
 *
 * Every cooperative table is service-role only; this route checks the session and passes the
 * caller to the SECURITY DEFINER functions as p_actor.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const db = serviceDb()

    const { data: mine, error } = await db.from('coop_members')
      .select('id, coop_id, role').eq('user_id', user.id).eq('status', 'active')
    if (error) throw error
    if (!mine?.length) return NextResponse.json({ coops: [] })

    const ids = mine.map((m) => m.coop_id)
    const [{ data: coops }, { data: owing }, { data: counts }] = await Promise.all([
      db.from('cooperatives').select('id, name, dues_amount_micro, dues_period, fund_balance_micro, status').in('id', ids),
      db.from('coop_charges').select('member_id, amount_micro').in('member_id', mine.map((m) => m.id)).eq('status', 'owing'),
      db.from('coop_members').select('coop_id').in('coop_id', ids).eq('status', 'active'),
    ])
    const owingBy: Record<number, number> = {}
    for (const o of owing || []) owingBy[o.member_id] = (owingBy[o.member_id] || 0) + Number(o.amount_micro)
    const countBy: Record<string, number> = {}
    for (const c of counts || []) countBy[c.coop_id] = (countBy[c.coop_id] || 0) + 1

    return NextResponse.json({
      coops: (coops || []).map((c) => {
        const me = mine.find((m) => m.coop_id === c.id)!
        return {
          id: c.id, name: c.name, duesMicro: Number(c.dues_amount_micro), period: c.dues_period,
          fundMicro: Number(c.fund_balance_micro), members: countBy[c.id] || 0,
          role: me.role, owingMicro: owingBy[me.id] || 0,
        }
      }),
    })
  } catch (e: unknown) {
    console.error('[coop] list error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const body = await request.json().catch(() => ({}))
    const db = serviceDb()

    if (body?.action === 'create') {
      const name = String(body.name || '').trim().slice(0, 80)
      const period = String(body.period || 'monthly')
      const dues = ngnToMicro(body.duesNgn)
      const entrance = ngnToMicro(body.entranceNgn)
      const approvals = Math.min(5, Math.max(1, Math.floor(Number(body.approvals) || 2)))
      if (name.length < 2) return NextResponse.json({ error: 'Give the society a name' }, { status: 400 })
      if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(period)) return NextResponse.json({ error: 'Pick how often dues are paid' }, { status: 400 })
      if (!(dues >= 100 * 1_000_000)) return NextResponse.json({ error: 'Dues must be at least ₦100' }, { status: 400 })
      if (entrance < 0 || dues > 100_000_000 * 1_000_000 || entrance > 100_000_000 * 1_000_000) {
        return NextResponse.json({ error: 'Check the amounts' }, { status: 400 })
      }
      const { data, error } = await db.rpc('coop_create', {
        p_actor: user.id, p_name: name, p_description: body.description ? String(body.description).slice(0, 300) : null,
        p_dues_micro: dues, p_period: period, p_entrance_micro: entrance, p_approvals: approvals,
      })
      if (error) return NextResponse.json({ error: coopError(error.message) }, { status: 400 })
      return NextResponse.json(data)
    }

    if (body?.action === 'join') {
      const code = String(body.code || '').trim().toUpperCase()
      if (!/^[0-9A-F]{7}$/.test(code)) return NextResponse.json({ error: 'That code doesn’t look right' }, { status: 400 })
      const { data, error } = await db.rpc('coop_join', { p_actor: user.id, p_code: code })
      if (error) return NextResponse.json({ error: coopError(error.message) }, { status: 400 })
      return NextResponse.json(data)
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e: unknown) {
    console.error('[coop] post error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
