import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkCronAuth } from '@/lib/cron-auth'
import { withBaseRead } from '@/lib/rpc-provider'
import { custodyCngnTransferTo } from '@/lib/custody'

/**
 * GET /api/cron/reconcile-withdrawals
 *
 * Finalises off-ramp withdrawals that got stuck 'pending' because the serverless
 * request died (usually a 60s timeout during the on-chain send) BEFORE it could
 * write the deciding status. Two buckets:
 *
 *  1. Rows that carry an on-chain marker ("… on-chain: …") — the ambiguous case the
 *     SQL reconciler deliberately WON'T move money on, because the DB alone can't
 *     tell "cNGN sent, status-write died" from "cNGN never sent". This route
 *     resolves that ambiguity by ASKING THE CHAIN:
 *       • marker has a tx hash → look up the receipt: mined+success ⇒ completed;
 *         reverted, or still not mined after the drop grace ⇒ refund + failed.
 *       • marker is only "settling → <flipeet address>" (send was attempted but no
 *         hash came back) → scan custody's cNGN Transfer logs to that unique
 *         address: a matching transfer ⇒ completed; none after the drop grace ⇒
 *         refund + failed.
 *  2. Rows with NO on-chain marker (died before the send was attempted, so cNGN
 *     provably never left) → handed to the SQL reconcile_stale_transactions RPC,
 *     which also fails unpaid on-ramp deposit intents.
 *
 * Refund path flips status to 'failed' FIRST (claiming the row via a status=pending
 * guard so a concurrent run can't double-act), then credits; if the credit throws,
 * the row is reverted to 'pending' for the next run. Runs every 15 min (vercel.json).
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Tx = {
  id: string
  user_id: string
  amount_kobo: number
  description: string | null
}

function refundMicro(amountKobo: number): number {
  // amount_kobo is naira*100; *10000 → naira*1e6 = cNGN micro (1 NGN = 1 cNGN).
  return Math.floor(Number(amountKobo)) * 10_000
}

/** Claim a still-pending row by flipping it, then run `after`. Reverts on failure. */
async function resolve(
  // Typed `any` to match the rest of the codebase (the generated SupabaseClient
  // generics make `.update()`'s payload resolve to `never` here otherwise).
  supabase: any,
  tx: Tx,
  status: 'completed' | 'failed',
  note: string,
  after?: () => Promise<void>,
): Promise<boolean> {
  const { data } = await supabase
    .from('transactions')
    .update({ status, description: `${tx.description || ''}${note}` })
    .eq('id', tx.id)
    .eq('status', 'pending') // idempotent claim: no-op if another run already resolved it
    .select('id')
  if (!data || data.length === 0) return false // already handled elsewhere
  if (after) {
    try {
      await after()
    } catch (e) {
      // Money move failed after we claimed the row — revert so the next run retries.
      await supabase.from('transactions').update({ status: 'pending' }).eq('id', tx.id)
      throw e
    }
  }
  return true
}

export async function GET(request: NextRequest) {
  const denied = checkCronAuth(request)
  if (denied) return denied

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Service key not configured' }, { status: 503 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  )

  const minMinutes = Number(process.env.WITHDRAWAL_RECONCILE_MINUTES) || 20
  // Don't declare a send "dropped" (and refund) until it's had ample time to mine.
  // Only a mined receipt / found transfer completes a row before this grace.
  const dropGrace = Number(process.env.WITHDRAWAL_DROP_GRACE_MINUTES) || 45

  const summary = { completed: 0, refunded: 0, skipped: 0, onchainErrors: 0 }

  // ── Bucket 1: on-chain-marked rows → verify against the chain ────────────────
  const cutoff = new Date(Date.now() - minMinutes * 60_000).toISOString()
  const { data: marked } = await supabase
    .from('transactions')
    .select('id, user_id, amount_kobo, description, created_at')
    .eq('type', 'withdrawal')
    .eq('status', 'pending')
    .like('description', '%on-chain:%')
    .lt('created_at', cutoff)

  for (const row of (marked || []) as (Tx & { created_at: string })[]) {
    const desc = row.description || ''
    const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60_000
    const past = ageMinutes >= dropGrace
    const hashMatch = desc.match(/on-chain:\s*(0x[0-9a-fA-F]{64})/)
    const addrMatch = desc.match(/settling\s*(?:→|->)?\s*(0x[0-9a-fA-F]{40})/)

    try {
      if (hashMatch) {
        // Shape A: a real send hash was recorded — the receipt is authoritative.
        const hash = hashMatch[1]
        const receipt = await withBaseRead((p) => p.getTransactionReceipt(hash))
        if (receipt && receipt.status === 1) {
          if (await resolve(supabase, row, 'completed', ' [reconciled: on-chain mined ✓]')) summary.completed++
        } else if (receipt && receipt.status === 0) {
          // Reverted — cNGN stayed in custody. Safe to refund.
          if (await resolve(supabase, row, 'failed', ' [reconciled: on-chain reverted, refunded]',
            async () => { await supabase.rpc('credit_wallet', { p_user_id: row.user_id, p_naira_kobo: 0, p_usdc_micro: refundMicro(row.amount_kobo) }) })) summary.refunded++
        } else if (!receipt && past) {
          // Not mined after the grace → dropped. Refund.
          if (await resolve(supabase, row, 'failed', ' [reconciled: send dropped (no receipt), refunded]',
            async () => { await supabase.rpc('credit_wallet', { p_user_id: row.user_id, p_naira_kobo: 0, p_usdc_micro: refundMicro(row.amount_kobo) }) })) summary.refunded++
        } else {
          summary.skipped++ // still within grace, could yet mine
        }
      } else if (addrMatch) {
        // Shape B: the send was attempted (the durable settling marker is written
        // and confirmed BEFORE the send). Ask the chain whether custody actually
        // paid that unique deposit address — deterministic, no amount/time guessing.
        const found = await custodyCngnTransferTo(addrMatch[1], ageMinutes)
        if (found) {
          // Stamp the REAL send hash so the row is auditable and a later run hash-matches it.
          if (await resolve(supabase, row, 'completed', ` [reconciled: custody transfer ${found.hash} ✓]`)) summary.completed++
        } else if (past) {
          if (await resolve(supabase, row, 'failed', ' [reconciled: no custody transfer, refunded]',
            async () => { await supabase.rpc('credit_wallet', { p_user_id: row.user_id, p_naira_kobo: 0, p_usdc_micro: refundMicro(row.amount_kobo) }) })) summary.refunded++
        } else {
          summary.skipped++
        }
      } else {
        // Marker present but unparseable — leave for a human.
        summary.skipped++
      }
    } catch (e) {
      // RPC hiccup — leave the row pending and try again next run. Never guess.
      summary.onchainErrors++
      console.error('[reconcile-withdrawals] on-chain check failed for', row.id, e instanceof Error ? e.message : e)
    }
  }

  // ── Bucket 2: no-marker stale rows + unpaid deposits → SQL reconciler ─────────
  let sql: unknown = null
  try {
    const { data } = await supabase.rpc('reconcile_stale_transactions', {
      p_user_id: null,
      p_withdrawal_minutes: minMinutes,
      p_deposit_minutes: Number(process.env.DEPOSIT_RECONCILE_MINUTES) || 90,
    })
    sql = data
  } catch (e) {
    console.error('[reconcile-withdrawals] SQL reconcile failed:', e instanceof Error ? e.message : e)
  }

  console.info('[reconcile-withdrawals] result:', summary, sql)
  return NextResponse.json({ ok: true, onchain: summary, sql })
}