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

/** Ordered write endpoints, primary first. Public ones are last-resort, same as reads. */
export function writeRpcUrls(): string[] {
  const urls = [
    process.env.BASE_WRITE_RPC_URL,
    process.env.BASE_MAINNET_RPC_URL,
    process.env.NEXT_PUBLIC_BASE_RPC_URL,
    ...(process.env.BASE_RPC_FALLBACKS?.split(',') ?? []),
    ...PUBLIC_FALLBACKS,
  ]
  return [...new Set(urls.map((u) => u?.trim()).filter((u): u is string => Boolean(u)))]
}

/**
 * Endpoint-level failures worth trying the next RPC for. Deliberately narrow: a revert,
 * a bad nonce or "already known" means the chain answered, and re-sending those risks
 * double-broadcasting or masking a real failure.
 */
function isEndpointFailure(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (/nonce|revert|insufficient funds|already known|replacement|underpriced/.test(m)) return false
  return /429|capacity|rate.?limit|quota|failed to detect network|timeout|socket|econnreset|fetch failed|502|503|504|server_error|network_error/.test(m)
}

// Which endpoint we settled on. Sticky for the life of the process so sequential custody
// txs keep getting a monotonic nonce from one source.
let activeWriteIdx = 0

/**
 * A SINGLE reliable Base RPC for SIGNING transactions, with failover.
 *
 * FallbackProvider is great for resilient reads but races nonces across endpoints on
 * SEQUENTIAL writes: a lagging RPC reports a stale transaction count, so the 2nd of two
 * back-to-back txs reuses the 1st's nonce and silently fails, leaving funds stranded in
 * custody. So this stays on ONE endpoint and only moves when that endpoint is hard-down,
 * then sticks to the new one.
 *
 * Added after the configured Alchemy key hit its monthly cap and returned 429 to every
 * call. Reads degraded fine via the public fallbacks, writes had no fallback at all, so
 * every withdrawal failed for four days while the app looked healthy.
 */
const WRITE_TIMEOUT_MS = Number(process.env.BASE_WRITE_TIMEOUT_MS) || 12_000

/**
 * A dead endpoint does not always return an error. An exhausted Alchemy key left ethers
 * looping on "failed to detect network, retry in 1s" forever, which is how the outage stayed
 * invisible: nothing threw, calls just never came back. So every attempt is bounded.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms on ${label}`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Pinning the network stops ethers probing eth_chainId, which is what stalls on a dead RPC. */
function staticProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url, BASE_CHAIN_ID, {
    staticNetwork: ethers.Network.from(BASE_CHAIN_ID),
  })
}

class FailoverWriteProvider extends ethers.JsonRpcProvider {
  private children: ethers.JsonRpcProvider[]

  constructor(private urls: string[]) {
    super(urls[activeWriteIdx] ?? urls[0], BASE_CHAIN_ID, {
      staticNetwork: ethers.Network.from(BASE_CHAIN_ID),
    })
    this.children = urls.map(staticProvider)
  }

  async send(method: string, params: Array<unknown>): Promise<unknown> {
    let lastErr: unknown
    for (let i = 0; i < this.children.length; i++) {
      const idx = (activeWriteIdx + i) % this.children.length
      const name = redactRpc(this.urls[idx])
      try {
        const out = await withTimeout(this.children[idx].send(method, params), WRITE_TIMEOUT_MS, name)
        if (idx !== activeWriteIdx) {
          console.warn(`[rpc] write endpoint failed over to ${name}`)
          activeWriteIdx = idx
        }
        return out
      } catch (err) {
        lastErr = err
        if (!isEndpointFailure(err)) throw err
        console.error(`[rpc] write endpoint ${name} unusable:`, err instanceof Error ? err.message : err)
      }
    }
    throw lastErr ?? new Error('All Base write RPC endpoints failed')
  }
}

/** Strip the API key path segment so endpoints can be named in logs safely. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname.replace(/\/[A-Za-z0-9_-]{12,}\/?$/, '/<key>')}`
  } catch {
    return 'unparseable-rpc-url'
  }
}

export function getWriteProvider(): ethers.JsonRpcProvider {
  return new FailoverWriteProvider(writeRpcUrls())
}

/**
 * Run a Base read, trying each configured RPC in turn with its OWN single-endpoint
 * provider, returning the first success.
 *
 * Why not just use getBaseProvider() (FallbackProvider)? When every configured
 * endpoint is a public one (mainnet.base.org, publicnode, llamarpc, …) they all
 * rate-limit at the same time, and ethers' FallbackProvider can't reconcile the
 * simultaneous errors — it throws an opaque "could not coalesce error" (UNKNOWN_ERROR)
 * that stranded the off-ramp mid-flow. Trying one clean provider at a time instead
 * (a) never coalesces, so a genuine revert surfaces as a real "execution reverted"
 * message, and (b) is gentler on rate limits than hammering all endpoints at once.
 * Two passes cover a transient 429 on the first sweep.
 */
export async function withBaseRead<T>(
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
  passes = 2,
): Promise<T> {
  const urls = baseRpcUrls()
  let lastErr: unknown
  for (let pass = 0; pass < passes; pass++) {
    for (const url of urls) {
      try {
        return await fn(new ethers.JsonRpcProvider(url, BASE_CHAIN_ID))
      } catch (err) {
        lastErr = err
      }
    }
  }
  throw lastErr ?? new Error('All Base RPC endpoints failed')
}

/**
 * The first configured Base RPC that is an Alchemy endpoint, or null. Alchemy's
 * enhanced APIs (alchemy_getAssetTransfers) only work against its own endpoints,
 * so callers that use them must be able to find one — and fall back otherwise.
 */
export function alchemyRpcUrl(): string | null {
  const candidates = [
    process.env.BASE_WRITE_RPC_URL,
    process.env.BASE_MAINNET_RPC_URL,
    process.env.NEXT_PUBLIC_BASE_RPC_URL,
    ...(process.env.BASE_RPC_FALLBACKS?.split(',') ?? []),
  ]
  for (const u of candidates) {
    const url = u?.trim()
    if (url && /g\.alchemy\.com/i.test(url)) return url
  }
  return null
}

/**
 * Raw `alchemy_getAssetTransfers`. Unlike `eth_getLogs` — which Alchemy's FREE tier
 * caps at a 10-block range (a chunked scan there 400s: "up to a 10 block range") —
 * this has NO range cap, so full transfer history is queryable in one call even
 * without a paid RPC. That cap is exactly why the withdrawal reconciler's on-chain
 * verification was silently failing in production.
 *
 * Throws if no Alchemy endpoint is configured; callers should fall back to a
 * chunked getLogs scan (which works on a paid/uncapped RPC).
 */
export async function alchemyAssetTransfers(
  params: Record<string, unknown>,
): Promise<Array<{ hash: string; to: string; from: string; value: number; rawContract?: { value?: string } }>> {
  const url = alchemyRpcUrl()
  if (!url) throw new Error('no Alchemy RPC configured for alchemy_getAssetTransfers')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`alchemy_getAssetTransfers HTTP ${res.status}`)
  const j = await res.json()
  if (j.error) throw new Error(`alchemy_getAssetTransfers: ${JSON.stringify(j.error)}`)
  return j.result?.transfers ?? []
}