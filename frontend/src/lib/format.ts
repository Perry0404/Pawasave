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

export function formatUsdc(micro: number): string {
  return '$' + (micro / 1_000_000).toFixed(2)
}

export function koboToMicroUsdc(kobo: number, rate = RATE): number {
  return Math.floor((kobo / 100 / rate) * 1_000_000)
}

export function microUsdcToKobo(micro: number, rate = RATE): number {
  return Math.floor((micro / 1_000_000) * rate * 100)
}

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
