/**
 * Strails' own on-ramp fee (NGN → cNGN), which Strails deducts before the deposit reaches us.
 * Schedule from Strails' October 2026 notice: 0.75%, minimum ₦500, capped at ₦10,000 per
 * transaction on the standard tier. Client-safe: used to show users what they will receive.
 * PawaSave's own deposit fee is separate (lib/deposit-fee.ts).
 */
export const STRAILS_ONRAMP_PERCENT = 0.75
export const STRAILS_ONRAMP_MIN_NGN = 500
export const STRAILS_ONRAMP_CAP_NGN = 10_000

export function strailsOnrampFeeNgn(grossNgn: number): number {
  if (!(grossNgn > 0)) return 0
  const pct = Math.round((grossNgn * STRAILS_ONRAMP_PERCENT) / 100)
  return Math.min(STRAILS_ONRAMP_CAP_NGN, Math.max(STRAILS_ONRAMP_MIN_NGN, pct))
}
