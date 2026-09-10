import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { verifyPin } from '@/lib/pin-hash'
import { pinLockGuard, recordPinResult } from '@/lib/pin-lockout'
import { refreshEquityPrices, heldSymbols } from '@/lib/equity-prices'
import { refreshRwaPrices } from '@/lib/getequity'

/**
 * /api/loans — custodial, in-app asset-backed lending.
 *
 *  GET   → the user's borrow limit (from pledged-eligible collateral), their active
 *          loan + collateral, recent loan history, and the current agreement version.
 *  POST  { action: 'borrow' | 'repay' }
 *          borrow: KYC + PIN gated, requires explicit agreement acceptance.
 *          repay : debits the user's spendable cNGN toward their own debt.
 *
 * All money movement happens inside SECURITY DEFINER RPCs (create_loan / repay_loan)
 * that re-check auth.uid(); this route is the thin, authenticated front door.
 */
const AGREEMENT_KEY = 'loan_agreement_version'

async function getUser() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  )
  const { data: { user } } = await supabase.auth.getUser()
  return { user, supabase }
}

async function agreementVersion(supabase: any): Promise<string> {
  const { data } = await supabase.from('platform_settings').select('value').eq('key', AGREEMENT_KEY).single()
  return data?.value || 'v1'
}

/** Refresh the cNGN price cache for this user's stocks so the borrow limit is
 *  priced against live values. Best-effort: a price hiccup just means stale/omitted
 *  equity, never a wrong loan (the RPC ignores prices older than the max age). */
async function refreshUserEquityPrices(userId: string): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )
    const symbols = await heldSymbols(admin, userId)
    if (symbols.length) await refreshEquityPrices(admin, symbols)
    // Naira assets (GetEquity rwa) are priced from the Market, not Yahoo — no-op until
    // GETEQUITY_ENABLED, so this is inert until GetEquity is live.
    await refreshRwaPrices(admin, userId)
  } catch {
    /* best-effort */
  }
}

async function ensurePin(supabase: any, userId: string, pin: string | undefined): Promise<NextResponse | null> {
  if (!/^\d{4}$/.test(pin || '')) {
    return NextResponse.json({ error: 'Valid 4-digit transaction PIN is required' }, { status: 400 })
  }
  const { data: profile } = await supabase.from('profiles').select('transaction_pin_hash').eq('id', userId).single()
  if (!profile?.transaction_pin_hash) {
    return NextResponse.json({ error: 'Set your transaction PIN in Settings first' }, { status: 400 })
  }
  const lock = await pinLockGuard(userId)
  if (lock.locked) return NextResponse.json({ error: lock.message }, { status: 429 })
  const { ok } = verifyPin(pin as string, profile.transaction_pin_hash)
  const attempt = await recordPinResult(userId, ok)
  if (!ok) return NextResponse.json({ error: attempt.message || 'Incorrect transaction PIN' }, { status: attempt.justLocked ? 429 : 401 })
  return null
}

export async function GET() {
  const { user, supabase } = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  await refreshUserEquityPrices(user.id)
  const { data: limit } = await supabase.rpc('loan_borrow_limit', { p_user_id: user.id })
  const { data: loans } = await supabase
    .from('loans')
    .select('id, principal_micro, apr_percent, origination_fee_micro, accrued_interest_micro, borrowed_at, due_date, status, closed_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10)

  const active = (loans || []).find((l: any) => l.status === 'active') || null
  let collateral: any[] = []
  if (active) {
    const { data } = await supabase.from('loan_collateral').select('asset_type, asset_ref, pledged_value_micro, ltv_percent').eq('loan_id', active.id)
    collateral = data || []
  }

  return NextResponse.json({
    limit: limit || null,
    activeLoan: active,
    collateral,
    history: loans || [],
    agreementVersion: await agreementVersion(supabase),
  })
}

export async function POST(request: NextRequest) {
  const { user, supabase } = await getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const action = body.action as string

  if (action === 'borrow') {
    if (body.agreementAccepted !== true) {
      return NextResponse.json({ error: 'You must accept the loan agreement to continue' }, { status: 400 })
    }
    const pinErr = await ensurePin(supabase, user.id, body.transactionPin)
    if (pinErr) return pinErr

    const amountNgn = Number(body.amountNgn)
    const tenorDays = Number(body.tenorDays)
    if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
      return NextResponse.json({ error: 'Enter a valid amount' }, { status: 400 })
    }
    if (!Number.isFinite(tenorDays) || tenorDays <= 0) {
      return NextResponse.json({ error: 'Choose a loan term' }, { status: 400 })
    }

    await refreshUserEquityPrices(user.id)
    const { data, error } = await supabase.rpc('create_loan', {
      p_user_id: user.id,
      p_amount_micro: Math.floor(amountNgn * 1_000_000),
      p_tenor_days: Math.floor(tenorDays),
      p_agreement_version: await agreementVersion(supabase),
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true, ...(data as object) })
  }

  if (action === 'repay') {
    const amountNgn = Number(body.amountNgn)
    if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
      return NextResponse.json({ error: 'Enter a valid amount' }, { status: 400 })
    }
    if (!body.loanId) return NextResponse.json({ error: 'Missing loan reference' }, { status: 400 })

    const { data, error } = await supabase.rpc('repay_loan', {
      p_user_id: user.id,
      p_loan_id: body.loanId,
      p_amount_micro: Math.floor(amountNgn * 1_000_000),
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ ok: true, ...(data as object) })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}