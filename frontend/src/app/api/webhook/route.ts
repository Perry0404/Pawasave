import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { ngnToCngnMicro, koboToCngnMicro } from '@/lib/ramp-rate'

// Deposit path is DB-only now (deposits stay as spendable custody cNGN — no
// on-chain PawasaveLend supply until a real yield source is live). maxDuration
// kept generous for headroom.
export const maxDuration = 60

const WEBHOOK_SECRET = process.env.FLINT_WEBHOOK_SECRET || ''

function verifySignature(bodyObj: any, signature: string): boolean {
  if (!WEBHOOK_SECRET || !signature) return false
  // FlintAPI docs: HMAC SHA512 of JSON.stringify(body)
  const hash = crypto
    .createHmac('sha512', WEBHOOK_SECRET)
    .update(JSON.stringify(bodyObj))
    .digest('hex')
  return signature === hash
}

export async function POST(request: NextRequest) {
  // Flint is disabled unless explicitly enabled — reject when off so its legacy
  // USD-based crediting path can never run (FIND-API-04, FIND-FIN-02 family).
  if (process.env.FLINT_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Flint disabled' }, { status: 503 })
  }
  // Fail closed: refuse webhooks when the signing secret isn't configured.
  if (!WEBHOOK_SECRET) {
    console.error('[flint-webhook] FLINT_WEBHOOK_SECRET not set — refusing (fail closed)')
    return NextResponse.json({ error: 'Webhook verification not configured' }, { status: 503 })
  }

  const rawBody = await request.text()
  const signature = request.headers.get('x-flint-signature') || ''

  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Verify webhook signature (try both stringify and raw approaches)
  const valid = verifySignature(body, signature) || (() => {
    // Fallback: verify against raw body text in case FlintAPI signs raw bytes
    const hash = crypto.createHmac('sha512', WEBHOOK_SECRET).update(rawBody).digest('hex')
    return hash === signature
  })()
  if (!valid) {
    console.error('Webhook signature mismatch')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const { event, data } = body

  // Log the raw verified payload so the real field names are confirmable in logs.
  console.info('[flint-webhook] payload:', JSON.stringify(body))

  // Flint's "credit reference" is its own transactionId (trx_…) — it does NOT echo
  // the reference we send. So reconcile against ALL candidate identifiers, matched
  // against both our `reference` column and the provider id we stored (paychant_tx_id).
  const candidates = [data?.reference, data?.transactionId, data?.id, data?.transaction_id]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (candidates.length === 0) {
    return NextResponse.json({ error: 'Missing reference' }, { status: 400 })
  }

  // Use service role to bypass RLS
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Webhook service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  // Find the pending transaction by any candidate ref, on either column.
  const findTx = async (status?: 'pending') => {
    for (const col of ['reference', 'paychant_tx_id'] as const) {
      let q = supabase.from('transactions').select('*').in(col, candidates)
      if (status) q = q.eq('status', status)
      const { data: rows } = await q.limit(1)
      if (rows && rows.length) return rows[0]
    }
    return null
  }

  const tx = await findTx('pending')

  if (!tx) {
    // Already processed (any status) — return 200 so the provider stops retrying
    const existingTx = await findTx()
    if (existingTx) return NextResponse.json({ ok: true, already_processed: true })
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  const isCompleted = data.status === 'completed' || event?.includes('completed')
  const isFailed = data.status === 'failed' || event?.includes('failed')

  if (isCompleted) {
    // Mark transaction completed
    await supabase
      .from('transactions')
      .update({ status: 'completed', paychant_tx_id: data.transactionId || tx.paychant_tx_id })
      .eq('id', tx.id)

    if (tx.type === 'deposit') {
      // On-ramp completed. Flint delivered cNGN to custody, so credit the naira
      // value as cNGN micro 1:1 (no USD rate) — matching the Flipeet path and the
      // rest of the cNGN-end-to-end app. (*_usdc_micro params are legacy names.)
      const amountNaira = Number(data.processedAmount || data.amount || tx.amount_kobo / 100)
      const feeKobo = Number(tx.platform_fee_kobo || 0)
      const userNaira = Math.max(0, amountNaira - feeKobo / 100)

      const cngnMicro = Number(await ngnToCngnMicro(userNaira)) // ≈ userNaira * 1e6 (cNGN peg)

      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: cngnMicro,
      })

      await supabase
        .from('transactions')
        .update({ amount_usdc_micro: cngnMicro })
        .eq('id', tx.id)

      // Deposits land 100% spendable in custody (like crypto deposits): no 90%
      // pool auto-allocation and no PawasaveLend supply until a real yield source
      // exists. The pool earns 0 without borrowers, and auto-supply added the
      // share-accounting that broke off-ramps. Withdrawals settle from raw custody
      // cNGN. Re-enable ONE unified supply for all flexible balances when yield is real.

      // Book the platform fee on ACTUAL completion so revenue reflects paid
      // deposits only (the on-ramp initialise no longer records it). Idempotent:
      // a retry finds the tx already non-pending and never reaches here again.
      if (feeKobo > 0) {
        await supabase.rpc('record_platform_fee', {
          p_user_id: tx.user_id,
          p_reference: tx.reference,
          p_fee_type: 'ramp_onramp',
          p_gross_kobo: Math.round(amountNaira * 100),
          p_fee_kobo: feeKobo,
          p_fee_percent: amountNaira > 0 ? Math.round((feeKobo / amountNaira) * 100) / 100 : 0,
        })
      }

      // (PawasaveLend supply intentionally removed — see note above. Deposits stay
      // as spendable custody cNGN; re-enable a unified supply when yield is real.)
    }
    // For withdrawal: balance was already debited upfront, nothing more needed
  } else if (isFailed) {
    await supabase
      .from('transactions')
      .update({ status: 'failed' })
      .eq('id', tx.id)

    if (tx.type === 'withdrawal') {
      // Refund the debited balance as cNGN micro 1:1 (no USD rate).
      const cngnMicro = koboToCngnMicro(Number(tx.amount_kobo))
      await supabase.rpc('credit_wallet', {
        p_user_id: tx.user_id,
        p_naira_kobo: 0,
        p_usdc_micro: cngnMicro,
      })
    }
  }

  return NextResponse.json({ ok: true })
}
