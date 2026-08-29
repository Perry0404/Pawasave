import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { STRAILS_ENABLED, listTransactions, getUserDetails, addExternalWallet, withdrawAsset } from '@/lib/strails'
import { custodyAddress, custodyCngnBalance, cngnBalanceOf, supplyToLend } from '@/lib/custody'
import { acquireSupplyLock, releaseSupplyLock } from '@/lib/supply-lock'
import { sendDepositEmail } from '@/lib/notify-tx'

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
  const result = { credited: 0, creditedNgn: 0, onboarded: 0, swept: 0, sweptCngn: 0, supplied: '0', errors: [] as string[] }

  // ── 1. credit completed deposits the webhook didn't ────────────────────────
  let txs: any[] = []
  try {
    txs = await listTransactions()
  } catch (e) {
    result.errors.push(`listTransactions: ${e instanceof Error ? e.message : e}`)
  }
  ;(result as any).txsSeen = txs.length

  for (const t of txs) {
    const type = String(t.type ?? t.transactionType ?? '')
    const status = String(t.status ?? '')
    if (!/onramp|deposit/i.test(type) || !/completed|success/i.test(status)) continue

    // Their field is `transactionReference` (there is no `reference`); `id` carries
    // the same value. Key on it so a deposit is credited exactly once.
    const ref = String(t.transactionReference ?? t.id ?? t.transactionId ?? '')
    if (!ref) continue
    const reference = `strails_${ref}`

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
    const strailsFeeNgn = Math.max(0, gross - ngn) // Strails' own fee (theirs)
    // PawaSave 1.5% deposit fee — deducted from the funded amount (push can't gross up).
    // Kept in custody after the sweep = our revenue. Strails' fee stays theirs.
    const depositFeePercent = Number(process.env.PAWA_DEPOSIT_FEE_PERCENT) || 1.5
    const ourFeeNgn = Math.round(ngn * depositFeePercent / 100)
    const netNgn = Math.max(0, ngn - ourFeeNgn)
    const micro = Math.floor(netNgn * 1_000_000)

    // ATOMIC credit (migration 067): idempotency-check + ledger + wallet credit + fee
    // in one transaction, with an advisory lock on the reference so this cron can't race
    // the webhook and double-credit. Returns false if already processed (webhook/earlier
    // run) — replaces the old separate seen-check + insert + credit_wallet.
    const { data: didCredit } = await admin.rpc('credit_strails_deposit', {
      p_user_id: profile.id,
      p_reference: reference,
      p_gross_kobo: Math.round(ngn * 100),
      p_net_micro: micro,
      p_fee_kobo: Math.round(ourFeeNgn * 100),
      p_fee_percent: depositFeePercent,
      p_description: `Received via Strails${ourFeeNgn > 0 ? ` (₦${ourFeeNgn.toLocaleString('en-NG')} fee)` : ''}`,
      p_metadata: { channel: 'Strails', fee_naira: ourFeeNgn, strails_fee_naira: strailsFeeNgn },
    })
    if (didCredit === false) continue // already credited (webhook or earlier run)
    sendDepositEmail(profile.id, { amountNgn: netNgn, channel: 'Strails', reference }).catch(() => {})
    result.credited++
    result.creditedNgn += ngn
  }

  // ── 2. sweep user wallets into custody, then put idle float to work ────────
  try {
    const dest = await custodyAddress()
    const { data: users } = await admin
      .from('profiles')
      .select('id, strails_user_id, strails_va_account_number')
      .not('strails_user_id', 'is', null)

    for (const u of users ?? []) {
      try {
        const details = await getUserDetails(u.strails_user_id as string)

        // Back-fill the permanent NUBAN for anyone the `user.onboarded` webhook never
        // delivered (it 401s on signature verification, like the deposit one did) —
        // otherwise they're stranded on "Creating your account…" indefinitely.
        if (!u.strails_va_account_number && details.account.accountNumber) {
          // Direct service-role write (NOT the set_strails_account RPC — it isn't in
          // PostgREST's schema cache, so every RPC-based onboarding write silently
          // no-op'd and users were stranded on "Creating your account…").
          const { error: upErr } = await admin
            .from('profiles')
            .update({
              strails_va_account_number: details.account.accountNumber,
              strails_va_account_name: details.account.accountName || null,
              strails_va_bank_name: details.account.bankName || null,
              strails_onboard_status: 'completed',
              strails_onboarded_at: new Date().toISOString(),
            })
            .eq('id', u.id)
          if (upErr) {
            result.errors.push(`onboard ${u.id} (acct ${details.account.accountNumber}): ${upErr.message}`)
          } else {
            result.onboarded++
            console.info('[strails-reconcile] onboarded (webhook missed)', { user: u.id, acct: details.account.accountNumber })
          }
        }

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

    // Idle custody cNGN → PawasaveLend, so swept deposits actually earn. Guard with
    // the shared custody-supply lock (migration 054) so this can't race sweep-deposits
    // and both fire supply(idle) — the loser reverts "exceeds balance".
    if (await acquireSupplyLock()) {
      try {
        const idle = await custodyCngnBalance()
        if (idle >= 1_000_000n) {
          const { txHash, shares } = await supplyToLend(idle)
          result.supplied = idle.toString()
          console.info('[strails-reconcile] supplied to pool', { txHash, shares: shares.toString() })
        }
      } finally {
        await releaseSupplyLock()
      }
    } else {
      console.info('[strails-reconcile] skipped supply — custody-supply lock held')
    }
  } catch (e) {
    result.errors.push(`sweep phase: ${e instanceof Error ? e.message : e}`)
  }

  console.info('[strails-reconcile]', result)
  return NextResponse.json({ ok: true, ...result })
}