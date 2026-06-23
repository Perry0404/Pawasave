/**
 * rpc-provider.ts — resilient Base mainnet RPC provider (V2-INFRA-04).
 *
 * A single hard-coded RPC URL is a single point of failure: when that endpoint
 * is down, rate-limiting, or (as we've hit in practice) returning corrupt
 * receipts, every keeper that depends on it (oracle push, liquidation, vault
 * harvest, deposit scan + sweep) fails at once. ethers' FallbackProvider queries
 * several endpoints and returns the first healthy response, so one bad RPC no
 * longer takes the keepers offline.
 *
 * Precedence for the primary endpoint: BASE_MAINNET_RPC_URL, then
 * NEXT_PUBLIC_BASE_RPC_URL. Extra comma-separated endpoints can be supplied in
 * BASE_RPC_FALLBACKS. A few public Base RPCs are always appended as a last
 * resort so the provider degrades gracefully even with no env configured.
 *
 * quorum = 1: these are Base reads/sends, not a trust-sensitive multi-source
 * price feed, so the fastest healthy endpoint should win.
 */
import { ethers } from 'ethers'

const BASE_CHAIN_ID = 8453

// Public last-resort endpoints. Kept short; the operator should configure a
// paid primary via BASE_MAINNET_RPC_URL for real throughput.
const PUBLIC_FALLBACKS = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://base.llamarpc.com',
]

/** Ordered, de-duplicated list of Base RPC URLs (primary first). */
export function baseRpcUrls(): string[] {
  const urls: string[] = []
  const primary = process.env.BASE_MAINNET_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  if (primary) urls.push(primary)

  const extra = process.env.BASE_RPC_FALLBACKS
  if (extra) urls.push(...extra.split(',').map((s) => s.trim()).filter(Boolean))

  for (const u of PUBLIC_FALLBACKS) urls.push(u)
  return [...new Set(urls)]
}

/**
 * Build a Base provider. Returns a FallbackProvider when more than one endpoint
 * is available, else a plain JsonRpcProvider. Pin the network so ethers skips
 * the per-endpoint eth_chainId round-trip (and so a wrong-chain RPC is rejected).
 */
export function getBaseProvider(): ethers.AbstractProvider {
  const urls = baseRpcUrls()
  if (urls.length <= 1) {
    return new ethers.JsonRpcProvider(urls[0] || PUBLIC_FALLBACKS[0], BASE_CHAIN_ID)
  }
  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, BASE_CHAIN_ID),
    priority: i + 1, // primary first
    stallTimeout: 2000, // ms before trying the next endpoint
    weight: 1,
  }))
  return new ethers.FallbackProvider(configs, BASE_CHAIN_ID, { quorum: 1 })
}