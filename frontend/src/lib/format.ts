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
