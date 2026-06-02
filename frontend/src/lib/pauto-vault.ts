import { ethers } from "ethers"
import type { Contract, Signer, TransactionResponse } from "ethers"
import { CONTRACTS } from "./contracts"

/**
 * P-AUTO Vault Frontend Integration Library
 * Handles interaction with PawasaveAutoVault smart contract
 */

const PAUTO_ABI = [
  // Deposit functions
  "function depositFlexible(uint256 assets, address receiver) external nonReentrant whenNotPaused returns (uint256 shares)",
  "function depositFixed(uint256 assets, address receiver, uint256 lockDays) external nonReentrant whenNotPaused returns (uint256 shares)",

  // Withdrawal functions
  "function withdraw(uint256 shares, address receiver, address owner) public override nonReentrant lockEnforcer returns (uint256 assets)",
  "function redeem(uint256 shares, address receiver, address owner) public override nonReentrant lockEnforcer returns (uint256 assets)",

  // View functions
  "function getUserDeposits(address user) external view returns (tuple(uint256 amount, uint256 depositTime, uint256 unlockTime, uint8 depositType, bool yieldClaimed)[])",
  "function hasActiveLock(address user) external view returns (bool)",
  "function getNextUnlockTime(address user) external view returns (uint256)",
  "function isValidLockPeriod(uint256 days) public pure returns (bool)",
  "function getTotalUserYield() external view returns (uint256)",
  "function getTotalFees() external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function totalAssets() public view override returns (uint256)",
  "function convertToShares(uint256 assets) public view override returns (uint256)",
  "function convertToAssets(uint256 shares) public view override returns (uint256)",

  // Harvest
  "function harvestYield() external onlyHarvester returns (uint256 totalYield)",

  // Admin
  "function updatePlatformFee(uint256 newFeeBps) external onlyOwner",
  "function updateFeeRecipient(address newRecipient) external onlyOwner",
  "function updatePrimaryStrategy(address newStrategy) external onlyOwner",
  "function updateFallbackStrategy(address newStrategy) external onlyOwner",
  "function pauseVault() external onlyOwner",
  "function unpauseVault() external onlyOwner",

  // Events
  "event Deposited(address indexed user, uint256 assets, uint256 shares, uint8 depositType, uint256 unlockTime)",
  "event Withdrawn(address indexed user, uint256 shares, uint256 assets, bool isEarlyWithdraw)",
  "event YieldHarvested(uint256 totalYield, uint256 platformFee, uint256 userYield, uint256 timestamp)",
]

export type DepositType = "FLEXIBLE" | "FIXED_30" | "FIXED_90" | "FIXED_180" | "FIXED_365"

export interface UserDeposit {
  amount: bigint
  depositTime: bigint
  unlockTime: bigint
  depositType: number
  yieldClaimed: boolean
}

export interface DepositOptions {
  type: DepositType
  amount: bigint
  receiver: string
}

export interface VaultStats {
  totalAssets: bigint
  userShares: bigint
  userYieldAccrued: bigint
  platformFeesAccrued: bigint
  userHasActiveLock: boolean
  nextUnlockTime: bigint | null
}

/**
 * P-AUTO Vault Manager
 * Main interface for smart contract interactions
 */
export class PAutoVaultManager {
  private contract: Contract
  private provider: ethers.Provider
  private signer?: Signer

  constructor(
    vaultAddress: string,
    provider: ethers.Provider,
    signer?: Signer
  ) {
    this.provider = provider
    this.signer = signer
    const contractWithSigner = signer || provider
    this.contract = new ethers.Contract(vaultAddress, PAUTO_ABI, contractWithSigner)
  }

  /**
   * Deposit flexible (no lock, withdraw anytime)
   */
  async depositFlexible(
    amountInMicro: bigint,
    receiverAddress: string
  ): Promise<{ txHash: string; shares: bigint }> {
    if (!this.signer) throw new Error("Signer required for deposit")

    const tx = (await this.contract.depositFlexible(
      amountInMicro,
      receiverAddress
    )) as TransactionResponse

    const receipt = await tx.wait()
    if (!receipt) throw new Error("Transaction failed")

    // Parse shares from event
    const event = receipt.logs
      .map((log: any) => {
        try {
          return this.contract.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((e: any) => e?.name === "Deposited")

    const shares = event?.args?.[2] || BigInt(0)

    return {
      txHash: tx.hash,
      shares,
    }
  }

  /**
   * Deposit fixed (with lock period)
   */
  async depositFixed(
    amountInMicro: bigint,
    receiverAddress: string,
    lockDays: 30 | 90 | 180 | 365
  ): Promise<{ txHash: string; shares: bigint; unlockTime: number }> {
    if (!this.signer) throw new Error("Signer required for deposit")

    // Validate lock period
    if (![30, 90, 180, 365].includes(lockDays)) {
      throw new Error(`Invalid lock period: ${lockDays}. Must be 30, 90, 180, or 365`)
    }

    const tx = (await this.contract.depositFixed(
      amountInMicro,
      receiverAddress,
      lockDays
    )) as TransactionResponse

    const receipt = await tx.wait()
    if (!receipt) throw new Error("Transaction failed")

    // Parse event
    const event = receipt.logs
      .map((log: any) => {
        try {
          return this.contract.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((e: any) => e?.name === "Deposited")

    const shares = event?.args?.[2] || BigInt(0)
    const unlockTime = Number(event?.args?.[4] || 0)

    return {
      txHash: tx.hash,
      shares,
      unlockTime,
    }
  }

  /**
   * Withdraw shares
   */
  async withdraw(
    sharesInMicro: bigint,
    receiverAddress: string,
    ownerAddress: string
  ): Promise<{ txHash: string; assets: bigint }> {
    if (!this.signer) throw new Error("Signer required for withdrawal")

    const tx = (await this.contract.withdraw(
      sharesInMicro,
      receiverAddress,
      ownerAddress
    )) as TransactionResponse

    const receipt = await tx.wait()
    if (!receipt) throw new Error("Transaction failed")

    const event = receipt.logs
      .map((log: any) => {
        try {
          return this.contract.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((e: any) => e?.name === "Withdrawn")

    const assets = event?.args?.[2] || BigInt(0)

    return {
      txHash: tx.hash,
      assets,
    }
  }

  /**
   * Get user's deposits
   */
  async getUserDeposits(userAddress: string): Promise<UserDeposit[]> {
    const deposits = await this.contract.getUserDeposits(userAddress)
    return deposits.map((d: any) => ({
      amount: BigInt(d.amount),
      depositTime: BigInt(d.depositTime),
      unlockTime: BigInt(d.unlockTime),
      depositType: d.depositType,
      yieldClaimed: d.yieldClaimed,
    }))
  }

  /**
   * Check if user has active locks
   */
  async hasActiveLock(userAddress: string): Promise<boolean> {
    return this.contract.hasActiveLock(userAddress)
  }

  /**
   * Get next unlock time for user
   */
  async getNextUnlockTime(userAddress: string): Promise<number | null> {
    const time = await this.contract.getNextUnlockTime(userAddress)
    return time === BigInt(0) ? null : Number(time)
  }

  /**
   * Get user's share balance
   */
  async getUserBalance(userAddress: string): Promise<bigint> {
    return BigInt(await this.contract.balanceOf(userAddress))
  }

  /**
   * Get total assets in vault
   */
  async getTotalAssets(): Promise<bigint> {
    return BigInt(await this.contract.totalAssets())
  }

  /**
   * Get total yield accrued (user's portion)
   */
  async getTotalUserYield(): Promise<bigint> {
    return BigInt(await this.contract.getTotalUserYield())
  }

  /**
   * Get total fees accrued (platform's portion)
   */
  async getTotalFees(): Promise<bigint> {
    return BigInt(await this.contract.getTotalFees())
  }

  /**
   * Convert assets to shares
   */
  async convertToShares(assetAmount: bigint): Promise<bigint> {
    return BigInt(await this.contract.convertToShares(assetAmount))
  }

  /**
   * Convert shares to assets
   */
  async convertToAssets(shareAmount: bigint): Promise<bigint> {
    return BigInt(await this.contract.convertToAssets(shareAmount))
  }

  /**
   * Get comprehensive vault stats for user
   */
  async getVaultStats(userAddress: string): Promise<VaultStats> {
    const [totalAssets, userShares, userYield, platformFees, hasLock, nextUnlock] =
      await Promise.all([
        this.getTotalAssets(),
        this.getUserBalance(userAddress),
        this.getTotalUserYield(),
        this.getTotalFees(),
        this.hasActiveLock(userAddress),
        this.getNextUnlockTime(userAddress),
      ])

    return {
      totalAssets,
      userShares,
      userYieldAccrued: userYield,
      platformFeesAccrued: platformFees,
      userHasActiveLock: hasLock,
      nextUnlockTime: nextUnlock ? BigInt(nextUnlock) : null,
    }
  }

  /**
   * Get human-readable deposit information
   */
  getDepositTypeLabel(depositType: number): DepositType {
    const types: DepositType[] = ["FLEXIBLE", "FIXED_30", "FIXED_90", "FIXED_180", "FIXED_365"]
    return types[depositType] || "FLEXIBLE"
  }

  /**
   * Get APY for deposit type
   */
  getAPYForType(depositType: DepositType): number {
    const apyMap: Record<DepositType, number> = {
      FLEXIBLE: 27.0,
      FIXED_30: 4.14,
      FIXED_90: 12.41,
      FIXED_180: 24.82,
      FIXED_365: 49.7,
    }
    return apyMap[depositType]
  }

  /**
   * Get days for deposit type
   */
  getDaysForType(depositType: DepositType): number {
    const daysMap: Record<DepositType, number> = {
      FLEXIBLE: 0,
      FIXED_30: 30,
      FIXED_90: 90,
      FIXED_180: 180,
      FIXED_365: 365,
    }
    return daysMap[depositType]
  }

  /**
   * Format big number to decimal string
   */
  static formatAmount(amount: bigint, decimals: number = 6): string {
    const divisor = BigInt(10 ** decimals)
    const whole = amount / divisor
    const remainder = amount % divisor
    const remainderStr = remainder.toString().padStart(decimals, "0")
    return `${whole}.${remainderStr}`.replace(/\.?0+$/, "")
  }

  /**
   * Parse decimal string to big number
   */
  static parseAmount(amount: string, decimals: number = 6): bigint {
    const [whole, fractional = "0"] = amount.split(".")
    const fractionalPadded = fractional.padEnd(decimals, "0").slice(0, decimals)
    return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fractionalPadded)
  }
}

/**
 * Initialize P-AUTO vault manager (browser-compatible)
 */
export async function initPAutoManager(
  vaultAddress: string = CONTRACTS.PAUTO_VAULT
): Promise<PAutoVaultManager> {
  const eth = (window as any).ethereum
  if (!eth) throw new Error("MetaMask not detected")

  const provider = new ethers.BrowserProvider(eth)
  const signer = await provider.getSigner()

  return new PAutoVaultManager(vaultAddress, provider, signer)
}

export default PAutoVaultManager
