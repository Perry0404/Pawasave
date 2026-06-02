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
  "function symbol() external view returns (string)",
] as const

/** ADDRESSES alias for protocol components (same values as CONTRACTS) */
export const ADDRESSES = {
  LEND:   (process.env.NEXT_PUBLIC_LEND_ADDRESS || "0x5ec3a2a7a273e8fb43fa9840c1382b7287c5f532") as `0x${string}`,
  CNGN:   CONTRACTS.CNGN,
  USDC:   CONTRACTS.USDC,
  ORACLE: (process.env.NEXT_PUBLIC_ORACLE_ADDRESS || "") as `0x${string}`,
}

/** PawasaveLend ABI */
export const LEND_ABI = [
  "function supply(uint256 cngnAmount) external returns (uint256 shares)",
  "function withdraw(uint256 shares) external returns (uint256 cngnAmount)",
  "function depositCollateral(address token, uint256 amount) external",
  "function withdrawCollateral(address token, uint256 amount) external",
  "function borrow(uint256 cngnAmount) external",
  "function repay(address borrower, uint256 cngnAmount) external",
  "function liquidate(address borrower, uint256 repayAmount, address collateralToken) external",
  "function totalBorrows() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function totalPoolAssets() view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
  "function borrowBalanceCurrent(address borrower) view returns (uint256)",
  "function totalCollateralValue(address borrower) view returns (uint256)",
  "function borrowLimit(address borrower) view returns (uint256)",
  "function collateralBalance(address borrower, address token) view returns (uint256)",
  "function isHealthy(address borrower) view returns (bool)",
  "function currentBorrowAPR() view returns (uint256)",
  "function currentSupplyAPY() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function reserveFactorMantissa() view returns (uint256)",
  "function collateralFactorMantissa() view returns (uint256)",
  "function originationFeeMantissa() view returns (uint256)",
  "function paused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
] as const

export const CHAIN_ID = CHAIN.id
