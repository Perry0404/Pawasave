import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyStrailsWebhook, getUserDetails } from '@/lib/strails'

/**
 * POST /api/strails-webhook
 *
 * Strails delivery of onboarding + deposit events. HMAC-SHA256 signed
 * (X-Strails-Signature over the raw body). Fail closed on a bad signature.
 *
 * Handled:
 *  - user.onboarded                          → store the user's permanent NUBAN
 *  - fintech.user.deposit.funding.completed  → credit the user's cNGN balance
 *  - fintech.user.deposit.refunded           → log (nothing was credited)
 *
 * Field names are read defensively — validate against real sandbox payloads.
 */
export const maxDuration = 30

function readString(...v: unknown[]) {
  for (const x of v) if (typeof x === 'string' && x.trim()) return x.trim()
  return ''
}
function readNumber(...v: unknown[]) {
  for (const x of v) { const n = typeof x === 'number' ? x : Number(x); if (Number.isFinite(n) && n > 0) return n }
  return 0
}

export async function POST(request: NextRequest) {
  const raw = await request.text()
  const signature = request.headers.get('x-strails-signature')
  if (!verifyStrailsWebhook(raw, signature)) {
    console.error('[strails-webhook] signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Replay protection when a timestamp is supplied.
  const ts = request.headers.get('x-strails-timestamp')
  if (ts) {
    const t = new Date(ts).getTime()
    if (Number.isFinite(t) && Math.abs(Date.now() - t) > 300_000) {
      return NextResponse.json({ error: 'Stale timestamp' }, { status: 401 })
    }
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  let body: any
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const event = readString(request.headers.get('x-strails-event'), body?.event, body?.type)
  const data = body?.data?.data || body?.data || body
  console.info('[strails-webhook] event:', event)

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  // The user reference: we pass our Supabase user id as Strails `userId`, but Strails
  // may echo its own — resolve the local profile by either.
  const refUserId = readString(data?.userId, data?.user_id, body?.userId)
  async function resolveProfileId(): Promise<string | null> {
    if (!refUserId) return null
    const { data: byStrails } = await admin.from('profiles').select('id').eq('strails_user_id', refUserId).maybeSingle()
    if (byStrails?.id) return byStrails.id
    const { data: byId } = await admin.from('profiles').select('id').eq('id', refUserId).maybeSingle()
    return byId?.id ?? null
  }

  // ── user.onboarded → persist the permanent virtual account ───────────────────
  if (/onboard/i.test(event)) {
    const userId = await resolveProfileId()
    if (!userId) return NextResponse.json({ ok: true, note: 'no matching profile' })

    let acctNumber = readString(data?.virtualAccount?.accountNumber, data?.accountNumber, data?.account_number)
    let acctName = readString(data?.virtualAccount?.accountName, data?.accountName, data?.account_name)
    let bankName = readString(data?.virtualAccount?.bankName, data?.bankName, data?.bank_name)

    // If the account isn't in the payload, fetch it.
    if (!acctNumber && refUserId) {
      try {
        const details = await getUserDetails(refUserId)
        acctNumber = details.account.accountNumber || ''
        acctName = details.account.accountName || ''
        bankName = details.account.bankName || ''
      } catch (e) {
        console.warn('[strails-webhook] getUserDetails failed:', e instanceof Error ? e.message : e)
      }
    }

    await admin.rpc('set_strails_account', {
      p_user_id: userId,
      p_strails_uid: refUserId || null,
      p_acct_number: acctNumber || null,
      p_acct_name: acctName || null,
      p_bank_name: bankName || null,
    })
    return NextResponse.json({ ok: true, onboarded: true })
  }

  // ── deposit funding completed → credit the user's cNGN balance ───────────────
  if (/funding\.completed|deposit.*complete/i.test(event)) {
    const userId = await resolveProfileId()
    if (!userId) return NextResponse.json({ ok: true, note: 'no matching profile' })

    // Idempotency: key on Strails' deposit/transaction id.
    const depositId = readString(data?.depositId, data?.transactionReference, data?.reference, data?.id)
    if (depositId) {
      const { data: seen } = await admin.from('transactions').select('id').eq('reference', depositId).maybeSingle()
      if (seen) return NextResponse.json({ ok: true, already_processed: true })
    }

    const amountNgn = readNumber(data?.amount, data?.source?.amount, body?.amount)
    if (amountNgn <= 0) return NextResponse.json({ ok: true, note: 'no amount' })
    const cngnMicro = Math.floor(amountNgn * 1_000_000) // 1 NGN = 1 cNGN

    await admin.from('transactions').insert({
      user_id: userId,
      type: 'deposit',
      direction: 'credit',
      amount_kobo: Math.round(amountNgn * 100),
      amount_usdc_micro: cngnMicro,
      description: 'Received via Strails',
      reference: depositId || `strails_${Date.now()}`,
      status: 'completed',
    })
    await admin.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: cngnMicro })
    return NextResponse.json({ ok: true, credited: cngnMicro })
  }

  // ── refund (BVN mismatch etc.) → nothing was credited, just record ───────────
  if (/refund/i.test(event)) {
    console.info('[strails-webhook] deposit refunded:', readString(data?.refundReason, data?.reason))
    return NextResponse.json({ ok: true, refunded: true })
  }

  return NextResponse.json({ ok: true, ignored: event || 'unknown' })
}