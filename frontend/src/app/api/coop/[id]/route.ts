import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { sessionUser, serviceDb, coopError, ngnToMicro } from '@/lib/coop-server'

/**
 * One cooperative society (migration 116).
 *
 *   GET  /api/coop/:id   → the society, members (who has paid, who owes), my charges, payouts with
 *                          votes, and the fund ledger. Members only.
 *   POST /api/coop/:id   { action, ... }
 *     pay                         pay everything I owe (spendable first, then savings pool)
 *     autopay  { on }             turn auto-pay of my dues on/off
 *     leave
 *     role     { userId, role }   chairman only
 *     remove   { userId }         chairman only
 *     levy     { amountNgn, memo }                    officers
 *     propose  { amountNgn, reason, recipientTag | recipientId }   officers
 *     vote     { payoutId, approve }                  officers
 *     cancel   { payoutId }                           the proposer
 *
 * Authorisation is enforced inside the functions; this route only supplies the session user.
 */
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f-]{36}$/

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { id } = params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid society' }, { status: 400 })
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const db = serviceDb()

    const { data: me } = await db.from('coop_members').select('id, role, auto_pay, total_paid_micro')
      .eq('coop_id', id).eq('user_id', user.id).eq('status', 'active').maybeSingle()
    if (!me) return NextResponse.json({ error: 'You are not a member of this society' }, { status: 403 })

    const [{ data: coop }, { data: members }, { data: owing }, { data: myCharges }, { data: payouts }, { data: ledger }] = await Promise.all([
      db.from('cooperatives').select('*').eq('id', id).single(),
      db.from('coop_members').select('id, user_id, role, total_paid_micro, joined_at').eq('coop_id', id).eq('status', 'active').order('joined_at'),
      db.from('coop_charges').select('member_id, amount_micro').eq('coop_id', id).eq('status', 'owing'),
      db.from('coop_charges').select('id, kind, label, memo, amount_micro, status, due_at, paid_at').eq('member_id', me.id).order('due_at', { ascending: false }).limit(24),
      db.from('coop_disbursements').select('*').eq('coop_id', id).order('created_at', { ascending: false }).limit(20),
      db.from('coop_ledger').select('id, kind, amount_micro, user_id, memo, created_at').eq('coop_id', id).order('created_at', { ascending: false }).limit(50),
    ])
    if (!coop) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const payoutIds = (payouts || []).map((p) => p.id)
    const { data: votes } = payoutIds.length
      ? await db.from('coop_approvals').select('disbursement_id, officer_id, approve').in('disbursement_id', payoutIds)
      : { data: [] as { disbursement_id: number; officer_id: string; approve: boolean }[] }

    const userIds = new Set<string>()
    for (const m of members || []) userIds.add(m.user_id)
    for (const p of payouts || []) { userIds.add(p.recipient_id); userIds.add(p.proposed_by) }
    for (const l of ledger || []) if (l.user_id) userIds.add(l.user_id)
    const { data: profiles } = await db.from('profiles').select('id, display_name, tag').in('id', [...userIds])
    const nameOf = (uid?: string | null) => {
      if (!uid) return null
      if (uid === user.id) return 'You'
      const p = profiles?.find((x) => x.id === uid)
      return p?.display_name || (p?.tag ? '@' + p.tag : 'Member')
    }

    const owingBy: Record<number, number> = {}
    for (const o of owing || []) owingBy[o.member_id] = (owingBy[o.member_id] || 0) + Number(o.amount_micro)

    return NextResponse.json({
      coop: {
        id: coop.id, name: coop.name, description: coop.description, joinCode: coop.join_code,
        duesMicro: Number(coop.dues_amount_micro), period: coop.dues_period, entranceMicro: Number(coop.entrance_fee_micro),
        approvalsRequired: coop.approvals_required, fundMicro: Number(coop.fund_balance_micro),
        interestMicro: Number(coop.interest_earned_micro), nextDuesAt: coop.next_dues_at, status: coop.status,
      },
      me: { userId: user.id, role: me.role, autoPay: me.auto_pay, totalPaidMicro: Number(me.total_paid_micro), owingMicro: owingBy[me.id] || 0 },
      members: (members || []).map((m) => ({
        userId: m.user_id, name: nameOf(m.user_id), role: m.role,
        totalPaidMicro: Number(m.total_paid_micro), owingMicro: owingBy[m.id] || 0,
      })),
      charges: (myCharges || []).map((c) => ({
        id: c.id, kind: c.kind, label: c.label, memo: c.memo, amountMicro: Number(c.amount_micro), status: c.status, dueAt: c.due_at, paidAt: c.paid_at,
      })),
      payouts: (payouts || []).map((p) => {
        const vs = (votes || []).filter((v) => v.disbursement_id === p.id)
        return {
          id: p.id, amountMicro: Number(p.amount_micro), reason: p.reason, status: p.status,
          recipient: nameOf(p.recipient_id), proposedBy: nameOf(p.proposed_by), mine: p.proposed_by === user.id,
          approvals: vs.filter((v) => v.approve).length, rejections: vs.filter((v) => !v.approve).length,
          iVoted: vs.some((v) => v.officer_id === user.id), createdAt: p.created_at, expiresAt: p.expires_at,
        }
      }),
      ledger: (ledger || []).map((l) => ({
        id: l.id, kind: l.kind, amountMicro: Number(l.amount_micro), who: nameOf(l.user_id), memo: l.memo, at: l.created_at,
      })),
    })
  } catch (e: unknown) {
    console.error('[coop/:id] get error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { id } = params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid society' }, { status: 400 })
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const body = await request.json().catch(() => ({}))
    const db = serviceDb()
    const actor = user.id

    let call: { fn: string; args: Record<string, unknown> }
    switch (body?.action) {
      case 'pay':
        call = { fn: 'coop_pay', args: { p_actor: actor, p_coop_id: id, p_reference: `coop_pay_${id}_${randomUUID()}` } }
        break
      case 'autopay':
        call = { fn: 'coop_set_autopay', args: { p_actor: actor, p_coop_id: id, p_on: !!body.on } }
        break
      case 'leave':
        call = { fn: 'coop_leave', args: { p_actor: actor, p_coop_id: id } }
        break
      case 'role':
        if (!UUID.test(String(body.userId))) return NextResponse.json({ error: 'Pick a member' }, { status: 400 })
        call = { fn: 'coop_set_role', args: { p_actor: actor, p_coop_id: id, p_user: body.userId, p_role: String(body.role) } }
        break
      case 'remove':
        if (!UUID.test(String(body.userId))) return NextResponse.json({ error: 'Pick a member' }, { status: 400 })
        call = { fn: 'coop_remove_member', args: { p_actor: actor, p_coop_id: id, p_user: body.userId } }
        break
      case 'levy': {
        const amount = ngnToMicro(body.amountNgn)
        if (!(amount >= 100 * 1_000_000)) return NextResponse.json({ error: 'Levy must be at least ₦100' }, { status: 400 })
        call = { fn: 'coop_raise_levy', args: { p_actor: actor, p_coop_id: id, p_amount_micro: amount, p_memo: String(body.memo || '').slice(0, 140) } }
        break
      }
      case 'propose': {
        const amount = ngnToMicro(body.amountNgn)
        if (!(amount > 0)) return NextResponse.json({ error: 'Enter an amount' }, { status: 400 })
        let recipient = UUID.test(String(body.recipientId || '')) ? String(body.recipientId) : ''
        if (!recipient && body.recipientTag) {
          const tag = String(body.recipientTag).replace(/^@+/, '').toLowerCase()
          const { data: p } = await db.from('profiles').select('id').eq('tag', tag).maybeSingle()
          if (!p) return NextResponse.json({ error: `No PawaSave user @${tag}` }, { status: 404 })
          recipient = String(p.id)
        }
        if (!recipient) return NextResponse.json({ error: 'Who is the money for?' }, { status: 400 })
        call = { fn: 'coop_propose_payout', args: { p_actor: actor, p_coop_id: id, p_recipient: recipient, p_amount_micro: amount, p_reason: String(body.reason || '').slice(0, 300) } }
        break
      }
      case 'vote':
        call = { fn: 'coop_vote_payout', args: { p_actor: actor, p_disb_id: Number(body.payoutId), p_approve: !!body.approve } }
        break
      case 'cancel':
        call = { fn: 'coop_cancel_payout', args: { p_actor: actor, p_disb_id: Number(body.payoutId) } }
        break
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    // Votes and cancels name a payout, not the society; make sure it belongs to this one.
    if (body.action === 'vote' || body.action === 'cancel') {
      const { data: d } = await db.from('coop_disbursements').select('coop_id').eq('id', Number(body.payoutId)).maybeSingle()
      if (!d || d.coop_id !== id) return NextResponse.json({ error: 'Payout not found' }, { status: 404 })
    }

    const { data, error } = await db.rpc(call.fn, call.args)
    if (error) {
      const msg = /check constraint|reason/i.test(error.message) && body.action === 'propose'
        ? 'Give a reason (at least 3 characters)'
        : coopError(error.message)
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json(data ?? { ok: true })
  } catch (e: unknown) {
    console.error('[coop/:id] post error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
