/**
 * On-chain contract addresses and chain config for PawaSave.
 * All Base mainnet.
 */

export const CHAIN = {
  id:   8453,
  name: "Base",
  rpc:  process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org",
} as const

export const CONTRACTS = {
  /** PawasaveAutoVault — P-AUTO fixed savings vault */
  PAUTO_VAULT: (
    process.env.NEXT_PUBLIC_PAUTO_VAULT_ADDRESS ||
    "0xcff66ad14754f31c1e7c43696be85d6ecca912ff"
  ) as `0x${string}`,

  /** cNGN stablecoin on Base (6 decimals) */
  CNGN: (
    process.env.NEXT_PUBLIC_CNGN_TOKEN_ADDRESS ||
    "0x46C85152bFe9f96829aA94755D9f915F9B10EF5F"
  ) as `0x${string}`,

  /** USDC on Base (6 decimals) */
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
} as const

/** Minimal ERC-20 ABI for approvals and balance checks */
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
] as const
