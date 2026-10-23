import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { isAuthorisedAdmin } from '@/lib/admin-session'
import { sendPinResetEmail } from '@/lib/notify-tx'

/**
 * POST /api/admin/compliance — the admin compliance desk (migration 119).
 *
 *   { action: 'overview' }                                  metrics, open flags, recent actions
 *   { action: 'scan' }                                      run the monitoring rules now
 *   { action: 'lookup', email }                             one customer's status, money and history
 *   { action: 'set_status', userId, status, reason }        clear | review | frozen
 *   { action: 'resolve_flag', flagId, outcome, note? }      dismissed | actioned
 *   { action: 'pin_reset', userId, reason }                 clears the PIN; user sets a new one at sign-in
 *   { action: 'log', userId, kind, reason }                 str_filed | ctr_filed | note
 *
 * Every change is written to compliance_actions with the reason, so there is an audit trail.
 */
export const dynamic = 'force-dynamic'

const ACTOR = 'admin'

function db(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

async function emailMap(admin: SupabaseClient): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error || !data?.users?.length) break
    for (const u of data.users) out.set(u.id, u.email || '')
    if (data.users.length < 1000) break
  }
  return out
}

async function logAction(admin: SupabaseClient, userId: string, action: string, reason: string | null) {
  await admin.from('compliance_actions').insert({ user_id: userId, action, reason, actor: ACTOR })
}

export async function POST(request: NextRequest) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Service role key not configured' }, { status: 503 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!isAuthorisedAdmin(request, body?.password)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = db()
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

  try {
    switch (body.action) {
      case 'overview': {
        const [metrics, flags, actions, held] = await Promise.all([
          admin.rpc('compliance_metrics'),
          admin.from('compliance_flags').select('id, user_id, rule, severity, details, status, created_at').eq('status', 'open')
            .order('created_at', { ascending: false }).limit(200),
          admin.from('compliance_actions').select('id, user_id, action, reason, actor, created_at').order('created_at', { ascending: false }).limit(50),
          admin.from('profiles').select('id, display_name, compliance_status, compliance_reason, compliance_updated_at').neq('compliance_status', 'clear').limit(200),
        ])
        if (metrics.error) {
          const missing = /compliance_metrics|does not exist|schema cache/i.test(metrics.error.message)
          return NextResponse.json({ error: missing ? 'Run migration 119 to enable the compliance desk' : metrics.error.message }, { status: missing ? 503 : 500 })
        }
        const emails = await emailMap(admin)
        const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2 }
        return NextResponse.json({
          metrics: metrics.data,
          flags: (flags.data || []).map((f: any) => ({ ...f, email: emails.get(f.user_id) || '' }))
            .sort((a: any, b: any) => sevRank[a.severity] - sevRank[b.severity]),
          actions: (actions.data || []).map((a: any) => ({ ...a, email: emails.get(a.user_id) || '' })),
          held: (held.data || []).map((p: any) => ({ ...p, email: emails.get(p.id) || '' })),
        })
      }

      case 'scan': {
        const { data, error } = await admin.rpc('compliance_scan')
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ opened: data })
      }

      case 'lookup': {
        const email = String(body.email || '').trim().toLowerCase()
        if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 })
        const emails = await emailMap(admin)
        const userId = [...emails.entries()].find(([, e]) => e.toLowerCase() === email)?.[0]
        if (!userId) return NextResponse.json({ error: 'No account with that email' }, { status: 404 })
        const [profile, wallet, txs, flags, actions] = await Promise.all([
          admin.from('profiles').select('*').eq('id', userId).maybeSingle(),
          admin.from('wallets').select('naira_balance_kobo, usdc_balance_micro, cngn_pool_micro').eq('user_id', userId).maybeSingle(),
          admin.from('transactions').select('created_at, type, direction, amount_kobo, status, description').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(25),
          admin.from('compliance_flags').select('id, rule, severity, details, status, created_at, note').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(50),
          admin.from('compliance_actions').select('action, reason, actor, created_at').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(50),
        ])
        const p: any = profile.data || {}
        return NextResponse.json({
          user: {
            id: userId, email, name: p.display_name || '', joined: p.created_at,
            kyc_status: p.kyc_status, kyc_tier: p.kyc_tier ?? null, bvn_account: !!p.strails_va_account_number,
            compliance_status: p.compliance_status || 'clear', compliance_reason: p.compliance_reason || null,
            pin_set: !!p.transaction_pin_hash,
            pin_format: !p.transaction_pin_hash ? 'none' : String(p.transaction_pin_hash).startsWith('scrypt$') ? 'current' : 'legacy',
            pin_locked_until: p.pin_locked_until || null, pin_failed_attempts: p.pin_failed_attempts ?? 0,
            deleted: !!p.deleted_at,
          },
          wallet: wallet.data,
          transactions: txs.data || [],
          flags: flags.data || [],
          actions: actions.data || [],
        })
      }

      case 'set_status': {
        const status = String(body.status)
        if (!['clear', 'review', 'frozen'].includes(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
        if (!body.userId || !reason) return NextResponse.json({ error: 'User and reason required' }, { status: 400 })
        const { error } = await admin.from('profiles')
          .update({ compliance_status: status, compliance_reason: status === 'clear' ? null : reason, compliance_updated_at: new Date().toISOString() })
          .eq('id', body.userId)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        await logAction(admin, body.userId, status === 'clear' ? 'clear' : status === 'frozen' ? 'freeze' : 'review', reason)
        if (status === 'clear') {
          await admin.from('compliance_flags').update({ status: 'actioned', resolved_at: new Date().toISOString(), resolved_by: ACTOR, note: reason })
            .eq('user_id', body.userId).eq('status', 'open')
        }
        return NextResponse.json({ ok: true })
      }

      case 'resolve_flag': {
        const outcome = String(body.outcome)
        if (!['dismissed', 'actioned'].includes(outcome)) return NextResponse.json({ error: 'Invalid outcome' }, { status: 400 })
        const { error } = await admin.from('compliance_flags')
          .update({ status: outcome, resolved_at: new Date().toISOString(), resolved_by: ACTOR, note: String(body.note || '').slice(0, 500) || null })
          .eq('id', body.flagId)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ ok: true })
      }

      case 'pin_reset': {
        if (!body.userId || !reason) return NextResponse.json({ error: 'User and reason required' }, { status: 400 })
        const { error } = await admin.from('profiles')
          .update({ transaction_pin_hash: null, pin_set_at: null, pin_failed_attempts: 0, pin_locked_until: null })
          .eq('id', body.userId)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        await logAction(admin, body.userId, 'pin_reset', reason)
        sendPinResetEmail(body.userId).catch(() => {})
        return NextResponse.json({ ok: true })
      }

      case 'log': {
        const kind = String(body.kind)
        if (!['str_filed', 'ctr_filed', 'note'].includes(kind)) return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
        if (!body.userId || !reason) return NextResponse.json({ error: 'User and reason required' }, { status: 400 })
        await logAction(admin, body.userId, kind, reason)
        return NextResponse.json({ ok: true })
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (e: unknown) {
    console.error('[admin-compliance]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Request failed' }, { status: 500 })
  }
}
