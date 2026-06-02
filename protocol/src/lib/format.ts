const NGN_PER_CNGN = 1 // 1 cNGN = 1 NGN

export function fmt6(n: bigint, decimals = 2): string {
  const whole = n / 1_000_000n
  const frac  = n % 1_000_000n
  const fracStr = frac.toString().padStart(6, "0").slice(0, decimals)
  return `${whole.toLocaleString()}.${fracStr}`
}

export function fmtNgn(micro: bigint): string {
  return `₦${fmt6(micro)}`
}

export function fmtCngn(micro: bigint): string {
  return `${fmt6(micro)} cNGN`
}

export function fmtUsdc(micro: bigint): string {
  return `$${fmt6(micro)}`
}

export function fmtPct(mantissa: bigint): string {
  // mantissa is 1e18-scaled, annualised
  const pct = Number(mantissa) / 1e16 // → percentage
  return `${pct.toFixed(2)}%`
}

export function fmtUtil(cash: bigint, borrows: bigint): string {
  const total = cash + borrows
  if (total === 0n) return "0%"
  const pct = Number((borrows * 10000n) / total) / 100
  return `${pct.toFixed(1)}%`
}

export function parse6(value: string): bigint {
  const [whole, frac = ""] = value.split(".")
  const fracPadded = frac.padEnd(6, "0").slice(0, 6)
  return BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded || "0")
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
