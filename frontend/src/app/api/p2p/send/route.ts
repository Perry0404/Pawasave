import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { sendP2pSentEmail, sendP2pReceivedEmail, sendP2pClaimInviteEmail } from '@/lib/notify-tx'

/**
 * POST /api/p2p/send  { to, amountNgn, note? }   (`to` = a @tag or an email; `email` still accepted)
 *
 * One send box, routed by what `to` is:
 *   • a @tag           → an existing PawaSave user → DIRECT transfer (instant, free)
 *   • an email (user)  → DIRECT transfer
 *   • an email (no acct) → CLAIM (held in escrow, emailed, auto-returns if unclaimed)
 * Tags only ever resolve to existing users — you can't create a claim against a tag.
 *
 * cNGN moves on the internal ledger only (usdc_balance_micro, 6dp, pegged 1:1 to naira). No custody
 * signing, no on-chain — so this is safe to run under automation. Balance moves happen inside a
 * SECURITY DEFINER RPC under FOR UPDATE; this route only decides the route, enforces the
 * identity/limit policy, and sends the receipts.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const DAY_MS = 86_400_000
const MIN_NGN = Number(process.env.P2P_MIN_NGN || 100)
const EXPIRY_DAYS = Number(process.env.P2P_CLAIM_EXPIRY_DAYS || 7)
const CAP_LITE_NGN = Number(process.env.P2P_DAILY_CAP_LITE_NGN || 50_000)
const CAP_FULL_NGN = Number(process.env.P2P_DAILY_CAP_FULL_NGN || 1_000_000)

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TAG_RE = /^[a-z0-9_]{3,20}$/
const ltrimAt = (s: string) => s.replace(/^@+/, '')

export async function POST(request: NextRequest) {
  try {
    const user = await sessionUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const raw = String(body?.to ?? body?.email ?? '').trim()
    const amountNgn = Number(body?.amountNgn)
    const note = body?.note ? String(body.note).slice(0, 140) : null

    // Classify the destination: an email (has '@') or a @tag.
    const isEmail = raw.includes('@') && EMAIL_RE.test(raw.toLowerCase())
    const tag = ltrimAt(raw).toLowerCase()
    const isTag = !raw.includes('@') || (raw.startsWith('@') && !raw.slice(1).includes('@'))
    const email = raw.toLowerCase()

    if (!isEmail && !(isTag && TAG_RE.test(tag))) {
      return NextResponse.json({ error: 'Enter a @tag or an email' }, { status: 400 })
    }
    if (!(amountNgn >= MIN_NGN)) return NextResponse.json({ error: `Minimum is ₦${MIN_NGN.toLocaleString('en-NG')}` }, { status: 400 })
    if (isEmail && email === (user.email || '').toLowerCase()) return NextResponse.json({ error: "You can't send money to yourself" }, { status: 400 })

    const admin = serviceDb()

    // Identity gate: at least a lite (BVN) account. You can't hold a balance without it, but
    // enforce explicitly so the send box is never a way around KYC.
    const { data: prof } = await admin
      .from('profiles')
      .select('kyc_tier, display_name')
      .eq('id', user.id)
      .maybeSingle()
    const tier = String(prof?.kyc_tier || 'none')
    if (tier === 'none') {
      return NextResponse.json({ error: 'Verify your identity (BVN) before sending money', code: 'kyc_required' }, { status: 403 })
    }

    const amountMicro = Math.round(amountNgn * 1_000_000)
    const amountKobo = Math.round(amountNgn * 100)

    // Daily send cap by tier (AML velocity guard). Sums completed transfer_out in the last 24h.
    const since = new Date(Date.now() - DAY_MS).toISOString()
    const { data: recent } = await admin
      .from('transactions')
      .select('amount_usdc_micro')
      .eq('user_id', user.id)
      .eq('type', 'transfer_out')
      .eq('status', 'completed')
      .gte('created_at', since)
    const sentTodayMicro = (recent || []).reduce((s: number, r: any) => s + Number(r.amount_usdc_micro || 0), 0)
    const capNgn = tier === 'full' ? CAP_FULL_NGN : CAP_LITE_NGN
    if (sentTodayMicro + amountMicro > capNgn * 1_000_000) {
      return NextResponse.json({
        error: `Daily send limit is ₦${capNgn.toLocaleString('en-NG')}${tier !== 'full' ? ' — complete full verification to raise it' : ''}`,
        code: 'daily_cap',
      }, { status: 403 })
    }

    const senderName = String(prof?.display_name || '').split(' ')[0] || 'A PawaSave friend'
    const reference = `p2p:${randomUUID()}`

    // Resolve the recipient. A tag MUST be an existing user; an email may or may not be.
    let recipientId: string | null = null
    let toLabel = isEmail ? email : `@${tag}`
    if (isEmail) {
      const { data } = await admin.rpc('find_user_by_email', { p_email: email })
      recipientId = data ? String(data) : null
    } else {
      const { data } = await admin.from('profiles').select('id').eq('tag', tag).maybeSingle()
      if (!data) return NextResponse.json({ error: `No PawaSave user @${tag}` }, { status: 404 })
      recipientId = String(data.id)
    }

    if (recipientId) {
      if (recipientId === user.id) return NextResponse.json({ error: "You can't send money to yourself" }, { status: 400 })
      const { data: transferId, error } = await admin.rpc('p2p_send_direct', {
        p_sender: user.id,
        p_recipient: recipientId,
        p_amount_micro: amountMicro,
        p_reference: reference,
        p_note: note,
      })
      if (error) {
        const msg = /insufficient balance/i.test(error.message) ? 'Not enough balance' : 'Could not send'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
      // Fire-and-forget receipts (don't fail the transfer if mail is down).
      sendP2pSentEmail(user.id, { amountNgn, toLabel, kind: 'direct', note, reference }).catch(() => {})
      sendP2pReceivedEmail(recipientId, { amountNgn, fromLabel: senderName, note, reference }).catch(() => {})
      return NextResponse.json({ ok: true, kind: 'direct', transferId })
    }

    // No account yet → claim escrow + invite email.
    const expiresAt = new Date(Date.now() + EXPIRY_DAYS * DAY_MS).toISOString()
    const { data: transferId, error } = await admin.rpc('p2p_send_claim', {
      p_sender: user.id,
      p_recipient_email: email,
      p_amount_micro: amountMicro,
      p_reference: reference,
      p_expires_at: expiresAt,
      p_note: note,
    })
    if (error) {
      const msg = /insufficient balance/i.test(error.message) ? 'Not enough balance' : 'Could not send'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    sendP2pSentEmail(user.id, { amountNgn, toLabel: email, kind: 'claim', note, expiresAt, reference }).catch(() => {})
    sendP2pClaimInviteEmail({ toEmail: email, amountNgn, senderName, note, expiresAt }).catch(() => {})
    return NextResponse.json({ ok: true, kind: 'claim', transferId, expiresAt })
  } catch (e: unknown) {
    console.error('[p2p/send] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
