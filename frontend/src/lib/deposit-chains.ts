/**
 * deposit-chains.ts — registry of source chains for the cross-chain stablecoin deposit
 * (USDC/USDT on any chain → cNGN on Base via HyperFX). SERVER ONLY.
 *
 * A user's HD deposit address (m/44'/60'/0'/0/{index}) is the SAME EVM address on every
 * chain here, so one address receives USDC/USDT on all of them. The scanner watches each
 * ENABLED chain for inbound USDC/USDT to those addresses; the settler places a HyperFX
 * cross-chain intent (source USDC/USDT → Base cNGN) and credits the user.
 *
 * Enablement is per-chain via env, so a chain only goes live once its read RPC + custody
 * gas/bundler are provisioned:
 *   CROSSCHAIN_DEPOSIT_ENABLED=true                 master switch
 *   CROSSCHAIN_DEPOSIT_CHAINS=arbitrum,optimism,... comma list of chain keys to enable
 *   <CHAIN>_RPC_URL   e.g. ARBITRUM_RPC_URL         read RPC (Alchemy preferred: no getLogs cap)
 *   <CHAIN>_BUNDLER_URL (optional)                  ERC-4337 bundler for placing intents
 * cNGN is always delivered on Base (the destination); Base itself is a source too (a plain
 * USDC/USDT→cNGN swap that never leaves Base).
 *
 * Token ADDRESSES + DECIMALS are resolved from the HyperFX SDK's ChainConfigService at
 * runtime (see resolveChainAssets) rather than hardcoded — critical because BSC USDC/USDT
 * are 18-decimal, not 6, and the SDK is the source of truth the intent gateway agrees with.
 */

export interface SourceChain {
  key: string            // stable slug used in env + DB
  name: string           // display name
  chainId: number        // EVM chain id
  stateMachineId: string // HyperFX id, "EVM-<chainId>"
  rpcEnvVars: string[]   // env var names to try for the read/write RPC, in order
  bundlerEnvVar: string  // env var for the ERC-4337 bundler (per-chain)
}

/** All chains we can source stablecoins from. Base is included (same-chain path). */
export const SOURCE_CHAINS: Record<string, SourceChain> = {
  base: {
    key: 'base', name: 'Base', chainId: 8453, stateMachineId: 'EVM-8453',
    rpcEnvVars: ['BASE_WRITE_RPC_URL', 'BASE_MAINNET_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL'],
    bundlerEnvVar: 'HYPERFX_BUNDLER_URL',
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum', chainId: 42161, stateMachineId: 'EVM-42161',
    rpcEnvVars: ['ARBITRUM_RPC_URL'], bundlerEnvVar: 'ARBITRUM_BUNDLER_URL',
  },
  optimism: {
    key: 'optimism', name: 'Optimism', chainId: 10, stateMachineId: 'EVM-10',
    rpcEnvVars: ['OPTIMISM_RPC_URL'], bundlerEnvVar: 'OPTIMISM_BUNDLER_URL',
  },
  polygon: {
    key: 'polygon', name: 'Polygon', chainId: 137, stateMachineId: 'EVM-137',
    rpcEnvVars: ['POLYGON_RPC_URL'], bundlerEnvVar: 'POLYGON_BUNDLER_URL',
  },
  ethereum: {
    key: 'ethereum', name: 'Ethereum', chainId: 1, stateMachineId: 'EVM-1',
    rpcEnvVars: ['ETHEREUM_RPC_URL', 'MAINNET_RPC_URL'], bundlerEnvVar: 'ETHEREUM_BUNDLER_URL',
  },
  bsc: {
    key: 'bsc', name: 'BNB Chain', chainId: 56, stateMachineId: 'EVM-56',
    rpcEnvVars: ['BSC_RPC_URL', 'BNB_RPC_URL'], bundlerEnvVar: 'BSC_BUNDLER_URL',
  },
}

export const CROSSCHAIN_DEPOSIT_ENABLED = process.env.CROSSCHAIN_DEPOSIT_ENABLED === 'true'

/** Chain keys the operator has turned on (must also have a resolvable RPC). */
export function enabledChainKeys(): string[] {
  if (!CROSSCHAIN_DEPOSIT_ENABLED) return []
  const raw = (process.env.CROSSCHAIN_DEPOSIT_CHAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return raw.filter((k) => SOURCE_CHAINS[k] && !!rpcUrlFor(SOURCE_CHAINS[k]))
}

export function enabledChains(): SourceChain[] {
  return enabledChainKeys().map((k) => SOURCE_CHAINS[k])
}

export function chainByKey(key: string): SourceChain | undefined {
  return SOURCE_CHAINS[String(key || '').toLowerCase()]
}

/** First resolvable RPC URL for a chain, or '' when none configured. */
export function rpcUrlFor(chain: SourceChain): string {
  for (const name of chain.rpcEnvVars) {
    const v = process.env[name]
    if (v && /^https?:\/\//.test(v)) return v
  }
  return ''
}

/** Per-chain bundler URL (falls back to the chain's RPC, which some bundlers accept). */
export function bundlerUrlFor(chain: SourceChain): string {
  return process.env[chain.bundlerEnvVar] || rpcUrlFor(chain)
}

export interface ChainAsset { symbol: 'USDC' | 'USDT'; address: string; decimals: number }

/**
 * Resolve the USDC + USDT asset (address + decimals) for a chain from the HyperFX SDK's
 * ChainConfigService — the authoritative source the intent gateway uses. Returns only the
 * assets the SDK knows on that chain. Async because the SDK is dynamically imported.
 */
export async function resolveChainAssets(chain: SourceChain): Promise<ChainAsset[]> {
  // @ts-ignore optional dependency, resolved at runtime once installed
  const sdk: any = await import('@hyperbridge/sdk')
  const svc = new sdk.ChainConfigService()
  const out: ChainAsset[] = []
  for (const symbol of ['USDC', 'USDT'] as const) {
    try {
      const address = symbol === 'USDC'
        ? svc.getUsdcAsset(chain.stateMachineId)
        : svc.getUsdtAsset(chain.stateMachineId)
      if (!address) continue
      const decimals = symbol === 'USDC'
        ? Number(svc.getUsdcDecimals(chain.stateMachineId))
        : Number(svc.getUsdtDecimals(chain.stateMachineId))
      out.push({ symbol, address: String(address), decimals: decimals > 0 ? decimals : 6 })
    } catch { /* asset not configured on this chain */ }
  }
  return out
}
