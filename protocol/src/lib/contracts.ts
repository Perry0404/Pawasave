export const CHAIN_ID = 8453 // Base mainnet

export const ADDRESSES = {
  LEND:   (process.env.NEXT_PUBLIC_LEND_ADDRESS   || "") as `0x${string}`,
  CNGN:   (process.env.NEXT_PUBLIC_CNGN_ADDRESS   || "0x46C85152bFe9f96829aA94755D9f915F9B10EF5F") as `0x${string}`,
  USDC:   (process.env.NEXT_PUBLIC_USDC_ADDRESS   || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`,
  ORACLE: (process.env.NEXT_PUBLIC_ORACLE_ADDRESS || "") as `0x${string}`,
}

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
] as const

export const LEND_ABI = [
  // Supply / withdraw
  "function supply(uint256 cngnAmount) external returns (uint256 shares)",
  "function withdraw(uint256 shares) external returns (uint256 cngnAmount)",
  // Collateral
  "function depositCollateral(address token, uint256 amount) external",
  "function withdrawCollateral(address token, uint256 amount) external",
  // Borrow / repay
  "function borrow(uint256 cngnAmount) external",
  "function repay(address borrower, uint256 cngnAmount) external",
  // Liquidation
  "function liquidate(address borrower, uint256 repayAmount, address collateralToken) external",
  // Views
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
  // psNGN (ERC20 share token)
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  // Events
  "event Supplied(address indexed supplier, uint256 cngnAmount, uint256 shares)",
  "event Withdrawn(address indexed supplier, uint256 cngnAmount, uint256 shares)",
  "event CollateralDeposited(address indexed borrower, address indexed token, uint256 amount)",
  "event CollateralWithdrawn(address indexed borrower, address indexed token, uint256 amount)",
  "event Borrowed(address indexed borrower, uint256 cngnAmount, uint256 fee)",
  "event Repaid(address indexed borrower, address indexed payer, uint256 cngnAmount)",
  "event Liquidated(address indexed liquidator, address indexed borrower, uint256 repaidCngn, address collateralToken, uint256 collateralSeized)",
] as const
