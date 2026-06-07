const RATE = 1550 // Fallback rate — UI fetches live rate from /api/ramp/rate on mount

export function formatNaira(kobo: number): string {
  const n = kobo / 100
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export function formatNairaDecimal(kobo: number): string {
  const n = kobo / 100
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatCompact(kobo: number): string {
  const n = kobo / 100
  if (n >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return '₦' + (n / 1_000).toFixed(0) + 'k'
  return '₦' + n.toLocaleString('en-NG')
}

/** Format cNGN micro-units (6 decimals) as naira. 1 cNGN = ₦1. */
export function formatCngn(micro: number): string {
  return formatNaira(microCngnToKobo(micro))
}

// Legacy alias — consumer balances are cNGN now, so this also renders ₦.
export const formatUsdc = formatCngn

// Savings are denominated in cNGN (1 cNGN = ₦1). Balances are stored as cNGN
// micro-units (6 decimals), so converting to/from kobo is a fixed peg — never a
// rate. The optional `rate` arg is ignored (kept so existing call sites compile).
// 1 NGN = 100 kobo = 1_000_000 cNGN micro  →  1 kobo = 10_000 cNGN micro.
export function koboToMicroCngn(kobo: number): number {
  return Math.floor(kobo) * 10_000
}

export function microCngnToKobo(micro: number): number {
  return Math.floor(micro / 10_000)
}

// Backwards-compatible aliases (now cNGN, not USD — the rate arg is ignored).
export const koboToMicroUsdc = (kobo: number, _rate?: number): number => koboToMicroCngn(kobo)
export const microUsdcToKobo = (micro: number, _rate?: number): number => microCngnToKobo(micro)

// Live NGN/USD rate is fetched from /api/ramp/rate (Flipeet). This fallback is
// only ever used for fiat on/off-ramp pricing if that API is unreachable — never
// to value a saved balance.
export function getRate(): number {
  return RATE
}

// ── Protocol (bigint) formatters ──────────────────────────────────────────────

export function fmt6(n: bigint, decimals = 2): string {
  const whole = n / 1_000_000n
  const frac  = n % 1_000_000n
  return `${whole.toLocaleString()}.${frac.toString().padStart(6, "0").slice(0, decimals)}`
}

export function fmtCngn(micro: bigint): string {
  return `${fmt6(micro)} cNGN`
}

export function fmtUsdc(micro: bigint): string {
  return `$${fmt6(micro)}`
}

export function fmtPct(mantissa: bigint): string {
  return `${(Number(mantissa) / 1e16).toFixed(2)}%`
}

export function parse6(value: string): bigint {
  const [whole, frac = ""] = value.split(".")
  return BigInt(whole || "0") * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6) || "0")
}

/** Format a bigint amount with arbitrary token decimals */
export function fmtUnits(amount: bigint, decimals: number, displayDec = 2): string {
  const base  = 10n ** BigInt(decimals)
  const whole = amount / base
  const frac  = amount % base
  return `${whole.toLocaleString()}.${frac.toString().padStart(decimals, "0").slice(0, displayDec)}`
}

/** Format a token amount with its symbol, e.g. "12.50 USDT" */
export function fmtToken(amount: bigint, decimals: number, symbol: string): string {
  return `${fmtUnits(amount, decimals)} ${symbol}`
}

/** Parse a decimal string into a bigint with arbitrary token decimals */
export function parseUnits(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".")
  return BigInt(whole || "0") * (10n ** BigInt(decimals)) +
    BigInt(frac.padEnd(decimals, "0").slice(0, decimals) || "0")
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ── Time ───────────────────────────────────────────────────────────────────────
export function timeAgo(ts: string | number): string {
  const date = typeof ts === 'string' ? new Date(ts).getTime() : ts
  const diff = Date.now() - date
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}
