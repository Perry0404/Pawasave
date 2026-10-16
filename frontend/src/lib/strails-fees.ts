/**
 * Estimate of Strails' own on-ramp fee (NGN → cNGN), which Strails deducts before a deposit
 * reaches us. Only a fallback: the deposit screen asks Strails for the exact, tier-aware fee via
 * /api/strails/fee-preview. 1.7% is the rate in Strails' virtual-account docs and what a live
 * ₦1,000 deposit paid (₦17). Client-safe. PawaSave's own deposit fee is lib/deposit-fee.ts.
 */
export const STRAILS_ONRAMP_ESTIMATE_PERCENT = 1.7

export function estimateStrailsOnrampFeeNgn(grossNgn: number): number {
  if (!(grossNgn > 0)) return 0
  return Math.round((grossNgn * STRAILS_ONRAMP_ESTIMATE_PERCENT) / 100 * 100) / 100
}
