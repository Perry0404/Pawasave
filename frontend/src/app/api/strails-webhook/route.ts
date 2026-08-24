import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyStrailsWebhook, getUserDetails } from '@/lib/strails'
import { sendPushToUser } from '@/lib/push-send'
import { sendDepositEmail } from '@/lib/notify-tx'

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

/**
 * Strails' webhook signature scheme is undocumented and currently fails verification,
 * so a signed deposit event would be dropped (401) and never credit until the 3-min
 * poll catches it. Instead of trusting the unverifiable payload, use the webhook as an
 * UNTRUSTED TRIGGER: fire the reconciler, which independently re-checks Strails' own API
 * (idempotent, keyed on Strails' reference) and credits any completed deposit. Nothing is
 * trusted from the request body — the credit only happens after our own authoritative API
 * check — so an unverified (or even forged) POST can at worst cause a harmless reconcile.
 * This makes deposits land in seconds without needing to crack the signature.
 */
function triggerReconcile(request: NextRequest): void {
  const secret = process.env.CRON_SECRET
  if (!secret) return
  const origin = request.nextUrl.origin
  fetch(`${origin}/api/cron/strails-reconcile`, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: 'no-store',
  }).catch(() => {}) // fire-and-forget; the reconciler is idempotent so overlap with the cron is safe
}

export async function POST(request: NextRequest) {
  const raw = await request.text()
  const signature = request.headers.get('x-strails-signature')
  const ts = request.headers.get('x-strails-timestamp')
  const verdict = verifyStrailsWebhook(raw, signature, ts)
  if (!verdict.ok) {
    // Signature scheme is undocumented and currently unverifiable. Don't drop the event:
    // trigger the reconciler (re-verifies via Strails' API, idempotent) so deposits still
    // land in seconds. Still log the digest shape so the scheme can be pinned later.
    console.warn('[strails-webhook] signature unverified — triggering reconcile instead', {
      sigLen: signature?.length ?? 0,
      sigPrefix: signature?.slice(0, 12) ?? null,
      looksHex: signature ? /^[0-9a-f]+$/i.test(signature.replace(/^sha256=/i, '')) : null,
      hasTimestamp: Boolean(ts),
      bodyLen: raw.length,
      headers: Object.fromEntries(
        [...request.headers.entries()].filter(([k]) => k.toLowerCase().startsWith('x-')),
      ),
    })
    triggerReconcile(request)
    return NextResponse.json({ ok: true, reconcile_triggered: true })
  }
  console.info('[strails-webhook] signature verified via', verdict.matched)
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

    // Direct write, not the set_strails_account RPC — that function isn't in
    // PostgREST's schema cache, so RPC-based onboarding writes silently no-op'd.
    const update: Record<string, unknown> = {
      strails_onboard_status: 'completed',
      strails_onboarded_at: new Date().toISOString(),
    }
    if (refUserId) update.strails_user_id = refUserId
    if (acctNumber) update.strails_va_account_number = acctNumber
    if (acctName) update.strails_va_account_name = acctName
    if (bankName) update.strails_va_bank_name = bankName
    await admin.from('profiles').update(update).eq('id', userId)
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
    // PawaSave deposit fee (1.5%): a push-deposit can't be grossed up, so our fee is
    // DEDUCTED from what's credited (Strails already took its own fee upstream — that's
    // theirs; this is ours). The fee cNGN stays in custody after the sweep = real revenue.
    const depositFeePercent = Number(process.env.PAWA_DEPOSIT_FEE_PERCENT) || 1.5
    const ourFeeNgn = Math.round(amountNgn * depositFeePercent / 100)
    const netNgn = Math.max(0, amountNgn - ourFeeNgn)
    const cngnMicro = Math.floor(netNgn * 1_000_000) // credited (net of our fee), 1 NGN = 1 cNGN

    // Who sent it, if Strails passes it — surfaced in the app detail sheet + email.
    const senderName = readString(
      data?.senderName, data?.sourceAccountName, data?.payerName, data?.originatorName,
      data?.source?.accountName, data?.narration,
    )
    const senderAccount = readString(
      data?.senderAccountNumber, data?.sourceAccountNumber, data?.source?.accountNumber, data?.payerAccountNumber,
    )
    const reference = depositId || `strails_${Date.now()}`

    await admin.from('transactions').insert({
      user_id: userId,
      type: 'deposit',
      direction: 'credit',
      amount_kobo: Math.round(amountNgn * 100), // gross received into the NUBAN
      platform_fee_kobo: Math.round(ourFeeNgn * 100),
      amount_usdc_micro: cngnMicro,             // net credited to the wallet
      description: `Received via Strails${ourFeeNgn > 0 ? ` (₦${ourFeeNgn.toLocaleString('en-NG')} fee)` : ''}`,
      reference,
      status: 'completed',
      metadata: { channel: 'Strails', sender_name: senderName || null, sender_account: senderAccount || null, gross_naira: amountNgn, fee_naira: ourFeeNgn },
    })
    await admin.rpc('credit_wallet', { p_user_id: userId, p_naira_kobo: 0, p_usdc_micro: cngnMicro })
    if (ourFeeNgn > 0) {
      try {
        await admin.rpc('record_platform_fee', {
          p_user_id: userId, p_reference: reference, p_fee_type: 'ramp_onramp',
          p_gross_kobo: Math.round(amountNgn * 100), p_fee_kobo: Math.round(ourFeeNgn * 100), p_fee_percent: depositFeePercent,
        })
      } catch { /* fee-booking failure must not fail the credit */ }
    }
    sendPushToUser(userId, { title: 'Deposit received', body: `₦${netNgn.toLocaleString('en-NG')} has landed in your PawaSave balance.`, url: '/', tag: 'deposit' }).catch(() => {})
    sendDepositEmail(userId, { amountNgn: netNgn, senderName, senderAccount, channel: 'Strails', reference }).catch(() => {})
    return NextResponse.json({ ok: true, credited: cngnMicro })
  }

  // ── refund (BVN mismatch etc.) → nothing was credited, just record ───────────
  if (/refund/i.test(event)) {
    console.info('[strails-webhook] deposit refunded:', readString(data?.refundReason, data?.reason))
    return NextResponse.json({ ok: true, refunded: true })
  }

  return NextResponse.json({ ok: true, ignored: event || 'unknown' })
}