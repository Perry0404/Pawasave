/**
 * deposit-fee.ts — PawaSave's deposit fee policy, in ONE place so the webhook and
 * the reconcile cron can never drift apart (they previously duplicated a % calc,
 * which is how a stale PAWA_DEPOSIT_FEE_PERCENT=5 charged ~5% on every deposit).
 *
 * Policy (2026-09-02):
 *   - Deposits UNDER ₦50,000 are FREE (₦0 PawaSave fee).
 *   - Deposits of ₦50,000 or more pay a FLAT ₦30 fee — NOT a percentage.
 * Strails' own fee is separate (theirs, deducted upstream) and is not part of this.
 * The threshold is measured on the GROSS amount the user sent.
 *
 * Optional env overrides (defaults are the policy above; 0 is allowed):
 *   PAWA_DEPOSIT_FEE_FLAT_NGN        (default 30)
 *   PAWA_DEPOSIT_FEE_FREE_UNDER_NGN  (default 50000)
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** PawaSave deposit fee in whole naira for a given gross deposit (naira). */
export function depositFeeNgn(grossNgn: number): number {
  const freeUnder = envNum('PAWA_DEPOSIT_FEE_FREE_UNDER_NGN', 50_000)
  const flat = envNum('PAWA_DEPOSIT_FEE_FLAT_NGN', 30)
  if (!(grossNgn >= freeUnder)) return 0 // under threshold (and NaN/0) → free
  return Math.max(0, Math.round(flat))
}
