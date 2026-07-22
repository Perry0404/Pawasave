import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { STRAILS_ENABLED, listTransactions, getUserDetails, addExternalWallet, withdrawAsset } from '@/lib/strails'
import { custodyAddress, custodyCngnBalance, cngnBalanceOf, supplyToLend } from '@/lib/custody'

/**
 * GET /api/cron/strails-reconcile
 *
 * Two jobs, both of which exist because a webhook is not a guarantee:
 *
 *  1. CREDIT — poll Strails for completed naira deposits and credit any the webhook
 *     missed. The first live deposit proved this is needed: Strails delivered the
 *     webhook three times and all three 401'd on signature verification, so the
 *     money arrived with nothing crediting it. Polling makes deposits land even if
 *     the signature scheme is wrong; the webhook just makes them land faster.
 *     Idempotent on Strails' own reference, so webhook + poll can't double-credit.
 *
 *  2. SWEEP — deposits mint into each user's Strails-custodied wallet, NOT ours, so
 *     the ledger would drift out of on-chain backing. Sweep those balances into
 *     PawaSave custody and supply the idle float to PawasaveLend. Strails takes no
 *     fee, but warns gas is high relative to small amounts — hence a THRESHOLD
 *     (STRAILS_SWEEP_MIN_CNGN, default 500) instead of sweeping every deposit.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SWEEP_MIN = Number(process.env.STRAILS_SWEEP_MIN_CNGN) || 500

function num(v: unknown) { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export async function GET(request: NextRequest) {
  const auth = checkCronAuth(request)
  if (auth) return auth
  if (!STRAILS_ENABLED) return NextResponse.json({ ok: true, skipped: 'STRAILS_ENABLED not set' })
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )
  const result = { credited: 0, creditedNgn: 0, swept: 0, sweptCngn: 0, supplied: '0', errors: [] as string[] }

  // ── 1. credit completed deposits the webhook didn't ────────────────────────
  let txs: any[] = []
  try {
    txs = await listTransactions()
  } catch (e) {
    result.errors.push(`listTransactions: ${e instanceof Error ? e.message : e}`)
  }
  ;(result as any).txsSeen = txs.length
  if (txs.length) {
    const t0 = txs[0]
    ;(result as any).sample = { type: t0?.type, status: t0?.status, ref: t0?.transactionReference, user: t0?.userId }
  }

  for (const t of txs) {
    const type = String(t.type ?? t.transactionType ?? '')
    const status = String(t.status ?? '')
    if (!/onramp|deposit/i.test(type) || !/completed|success/i.test(status)) continue

    // Their field is `transactionReference` (there is no `reference`); `id` carries
    // the same value. Key on it so a deposit is credited exactly once.
    const ref = String(t.transactionReference ?? t.id ?? t.transactionId ?? '')
    if (!ref) continue
    const reference = `strails_${ref}`

    // NOT maybeSingle(): it errors when more than one row matches and returns null,
    // which reads as "not credited" and credits AGAIN — compounding every run. A
    // duplicate must still count as already-processed.
    const { data: seen } = await admin
      .from('transactions').select('id').eq('reference', reference).limit(1)
    if (seen && seen.length > 0) continue // already credited (webhook or earlier run)

    // Map Strails' user id back to our profile.
    const sUser = String(t.userId ?? t.user_id ?? '')
    if (!sUser) continue
    const { data: profile } = await admin.from('profiles').select('id').eq('strails_user_id', sUser).maybeSingle()
    if (!profile?.id) continue

    // Credit what was actually MINTED, not what the user sent. Strails deducts its
    // fee at source: amount 1000 -> fundingAmount 983 (strailsFee 17). Crediting
    // `amount` would put more on the ledger than exists on-chain — the ledger must
    // never claim more cNGN than backs it.
    const gross = num(t.amount)
    const ngn = num(t.fundingAmount) || gross
    if (ngn <= 0) continue
    const micro = Math.floor(ngn * 1_000_000)
    const feeKobo = Math.round(Math.max(0, gross - ngn) * 100)

    await admin.from('transactions').insert({
      user_id: profile.id, type: 'deposit', direction: 'credit',
      amount_kobo: Math.round(ngn * 100), amount_usdc_micro: micro,
      platform_fee_kobo: feeKobo,
      description: 'Received via Strails', reference, status: 'completed',
    })
    await admin.rpc('credit_wallet', { p_user_id: profile.id, p_naira_kobo: 0, p_usdc_micro: micro })
    result.credited++
    result.creditedNgn += ngn
  }

  // ── 2. sweep user wallets into custody, then put idle float to work ────────
  try {
    const dest = await custodyAddress()
    const { data: users } = await admin
      .from('profiles')
      .select('id, strails_user_id')
      .not('strails_user_id', 'is', null)

    for (const u of users ?? []) {
      try {
        const details = await getUserDetails(u.strails_user_id as string)
        const wallet = details.evmWallet
        if (!wallet) continue
        // Read the wallet's REAL cNGN balance on Base. getuserdetails returns no
        // balance field at all, so an earlier version read undefined -> 0 and never
        // swept, leaving the ledger credited but unbacked. The chain is the truth.
        const bal = Number(await cngnBalanceOf(wallet)) / 1e6
        if (bal < SWEEP_MIN) continue

        await addExternalWallet({ address: dest, label: 'PawaSave custody' }).catch(() => {})
        const w = await withdrawAsset({
          internalWallet: wallet,
          userId: u.strails_user_id as string,
          destinationWallet: dest,
          amount: Math.floor(bal),
        })
        result.swept++
        result.sweptCngn += Math.floor(bal)
        console.info('[strails-reconcile] swept', { user: u.id, amount: bal, tx: w.txHash })
      } catch (e) {
        result.errors.push(`sweep ${u.id}: ${e instanceof Error ? e.message : e}`)
      }
    }

    // Idle custody cNGN → PawasaveLend, so swept deposits actually earn.
    const idle = await custodyCngnBalance()
    if (idle >= 1_000_000n) {
      const { txHash, shares } = await supplyToLend(idle)
      result.supplied = idle.toString()
      console.info('[strails-reconcile] supplied to pool', { txHash, shares: shares.toString() })
    }
  } catch (e) {
    result.errors.push(`sweep phase: ${e instanceof Error ? e.message : e}`)
  }

  console.info('[strails-reconcile]', result)
  return NextResponse.json({ ok: true, ...result })
}