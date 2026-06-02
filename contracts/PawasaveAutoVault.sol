// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title Pawasave P-AUTO Vault
 * @notice Multi-strategy yield aggregator for cNGN/USDC with lock periods, consent tracking, and platform fees
 * @dev Implements ERC4626 standard vault with fixed/flexible deposits and automated rebalancing
 * 
 * Features:
 * - Fixed deposits (30/90/180/365 days) with lock enforcement
 * - Flexible deposits with immediate withdrawal
 * - Automatic yield harvesting and rebalancing
 * - 6% platform fee on harvested yield
 * - Multi-strategy support (Xend Money Market, Lend markets, etc.)
 * - Admin controls and emergency pause
 */
contract PawasaveAutoVault is ERC4626, Ownable2Step, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    // ====================== CONSTANTS & TYPES ======================
    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");
    
    enum DepositType { FLEXIBLE, FIXED_30, FIXED_90, FIXED_180, FIXED_365 }
    
    struct UserDeposit {
        uint256 amount;
        uint256 depositTime;
        uint256 unlockTime;
        DepositType depositType;
        bool yieldClaimed;
    }

    // ====================== STATE VARIABLES ======================
    IERC20 public immutable assetToken;
    
    // Strategy addresses
    address public primaryStrategy;      // High-yield strategy (Xend Money Market, etc.)
    address public fallbackStrategy;     // Stable strategy
    
    // Fee configuration
    uint256 public platformFeeBps = 600; // 6% (in basis points)
    address public feeRecipient;
    uint256 public totalFeesAccrued;
    
    // Lock tracking
    mapping(address => UserDeposit[]) public userDeposits;
    
    // Yield tracking
    uint256 public totalYieldAccrued;
    uint256 public totalYieldHarvested;
    mapping(address => uint256) public userYieldClaimed;
    
    // Strategy metrics
    uint256 public lastRebalanceTime;
    uint256 public rebalanceInterval = 7 days;
    
    // ====================== EVENTS ======================
    event Deposited(
        address indexed user,
        uint256 assets,
        uint256 shares,
        DepositType depositType,
        uint256 unlockTime
    );
    
    event Withdrawn(
        address indexed user,
        uint256 shares,
        uint256 assets,
        bool isEarlyWithdraw
    );
    
    event YieldHarvested(
        uint256 totalYield,
        uint256 platformFee,
        uint256 userYield,
        uint256 timestamp
    );
    
    event Rebalanced(
        uint256 amountFromFallback,
        uint256 amountToPrimary,
        uint256 timestamp
    );
    
    event StrategyUpdated(
        string strategyType,
        address newAddress,
        address oldAddress
    );
    
    event LockEnforced(address indexed user, uint256 depositIndex);
    
    // ====================== MODIFIERS ======================
    modifier onlyHarvester() {
        require(hasRole(HARVESTER_ROLE, msg.sender), "Not harvester");
        _;
    }
    
    modifier lockEnforcer(address user) {
        _checkLocks(user);
        _;
    }

    // ====================== CONSTRUCTOR ======================
    constructor(
        IERC20 _asset,
        address _primaryStrategy,
        address _fallbackStrategy,
        address _feeRecipient
    ) ERC4626(_asset) ERC20("Pawasave Auto", "pAUTO") Ownable(msg.sender) {
        assetToken = _asset;
        primaryStrategy = _primaryStrategy;
        fallbackStrategy = _fallbackStrategy;
        feeRecipient = _feeRecipient;
        
        // Grant harvester role to owner initially
        _grantRole(HARVESTER_ROLE, msg.sender);
    }

    // ====================== DEPOSIT FUNCTIONS ======================
    /**
     * @notice Deposit assets for flexible savings (no lock)
     * @param assets Amount of cNGN/USDC to deposit
     * @param receiver Address to receive shares
     * @return shares Amount of pAUTO shares minted
     */
    function depositFlexible(uint256 assets, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        require(assets > 0, "Zero deposit");
        require(receiver != address(0), "Invalid receiver");

        // Transfer assets from user to vault
        assetToken.safeTransferFrom(msg.sender, address(this), assets);

        // Route to strategy
        _depositToStrategy(assets, primaryStrategy);

        // Mint shares
        shares = previewDeposit(assets);
        _mint(receiver, shares);

        // Track deposit
        userDeposits[receiver].push(UserDeposit({
            amount: assets,
            depositTime: block.timestamp,
            unlockTime: 0,
            depositType: DepositType.FLEXIBLE,
            yieldClaimed: false
        }));

        emit Deposited(receiver, assets, shares, DepositType.FLEXIBLE, 0);
        return shares;
    }

    /**
     * @notice Deposit assets for fixed savings with lock period
     * @param assets Amount of cNGN/USDC to deposit
     * @param receiver Address to receive shares
     * @param lockDays Lock period in days (30, 90, 180, or 365)
     * @return shares Amount of pAUTO shares minted
     */
    function depositFixed(
        uint256 assets,
        address receiver,
        uint256 lockDays
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        require(assets > 0, "Zero deposit");
        require(receiver != address(0), "Invalid receiver");
        require(isValidLockPeriod(lockDays), "Invalid lock period");

        // Transfer assets
        assetToken.safeTransferFrom(msg.sender, address(this), assets);

        // Route to high-yield strategy
        _depositToStrategy(assets, primaryStrategy);

        // Mint shares
        shares = previewDeposit(assets);
        _mint(receiver, shares);

        // Determine deposit type and unlock time
        DepositType depositType;
        uint256 unlockTime = block.timestamp + (lockDays * 1 days);

        if (lockDays == 30) depositType = DepositType.FIXED_30;
        else if (lockDays == 90) depositType = DepositType.FIXED_90;
        else if (lockDays == 180) depositType = DepositType.FIXED_180;
        else depositType = DepositType.FIXED_365;

        // Track deposit with lock
        userDeposits[receiver].push(UserDeposit({
            amount: assets,
            depositTime: block.timestamp,
            unlockTime: unlockTime,
            depositType: depositType,
            yieldClaimed: false
        }));

        emit Deposited(receiver, assets, shares, depositType, unlockTime);
        return shares;
    }

    /**
     * @notice Internal function to deposit to strategy
     * @param assets Amount to deposit
     * @param strategy Strategy address
     */
    function _depositToStrategy(uint256 assets, address strategy) internal {
        require(strategy != address(0), "Invalid strategy");
        
        // Approve strategy to pull funds
        assetToken.forceApprove(strategy, assets);
        
        // Generic ERC4626 deposit call
        (bool success, bytes memory data) = strategy.call(
            abi.encodeWithSignature("deposit(uint256,address)", assets, address(this))
        );
        
        require(success, "Deposit to strategy failed");
    }

    // ====================== WITHDRAWAL FUNCTIONS ======================
    /**
     * @notice Withdraw shares, respecting lock periods
     * @param shares Shares to burn
     * @param receiver Address to receive assets
     * @param owner Address owning the shares
     * @return assets Amount of cNGN/USDC withdrawn
     */
    function withdraw(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        lockEnforcer(owner)
        returns (uint256 assets)
    {
        return super.withdraw(shares, receiver, owner);
    }

    /**
     * @notice Redeem shares, respecting lock periods
     * @param shares Shares to burn
     * @param receiver Address to receive assets
     * @param owner Address owning the shares
     * @return assets Amount of cNGN/USDC redeemed
     */
    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        lockEnforcer(owner)
        returns (uint256 assets)
    {
        return super.redeem(shares, receiver, owner);
    }

    /**
     * @notice Check and enforce locks on user's deposits
     * @param user User address
     */
    function _checkLocks(address user) internal view {
        UserDeposit[] storage deposits = userDeposits[user];
        
        for (uint256 i = 0; i < deposits.length; i++) {
            if (deposits[i].unlockTime > 0 && block.timestamp < deposits[i].unlockTime) {
                revert("Funds still locked");
            }
        }
    }

    // ====================== YIELD HARVESTING ======================
    /**
     * @notice Harvest yield from strategies and distribute
     * @dev Called by keeper/harvester roles
     * @return totalYield Total yield harvested
     */
    function harvestYield() external onlyHarvester returns (uint256 totalYield) {
        // Get current balance of assets in strategy
        uint256 previousBalance = assetToken.balanceOf(address(this));
        
        // Call harvest on primary strategy
        _harvestFromStrategy(primaryStrategy);
        
        // Get new balance
        uint256 currentBalance = assetToken.balanceOf(address(this));
        totalYield = currentBalance - previousBalance;
        
        require(totalYield > 0, "No yield harvested");
        
        // Calculate platform fee
        uint256 platformFee = (totalYield * platformFeeBps) / 10000;
        uint256 userYield = totalYield - platformFee;
        
        // Track accrual
        totalYieldAccrued += userYield;
        totalFeesAccrued += platformFee;
        totalYieldHarvested += totalYield;
        
        // Transfer fee to recipient
        if (platformFee > 0) {
            assetToken.safeTransfer(feeRecipient, platformFee);
        }
        
        emit YieldHarvested(totalYield, platformFee, userYield, block.timestamp);
        return totalYield;
    }

    /**
     * @notice Internal harvest from strategy (flexible based on strategy interface)
     * @param strategy Strategy address
     */
    function _harvestFromStrategy(address strategy) internal {
        // Call harvest on strategy (customize based on actual strategy interface)
        (bool success, ) = strategy.call(
            abi.encodeWithSignature("harvest()")
        );
        
        // Silently continue if harvest not supported
        // This allows flexibility for different strategy types
    }

    // ====================== REBALANCING ======================
    /**
     * @notice Rebalance between strategies if needed
     * @dev Moves funds from fallback to primary if primary needs capital
     */
    function rebalance() external onlyOwner {
        require(
            block.timestamp >= lastRebalanceTime + rebalanceInterval,
            "Rebalance interval not met"
        );
        
        // Get balances in each strategy
        uint256 primaryBalance = _getStrategyBalance(primaryStrategy);
        uint256 fallbackBalance = _getStrategyBalance(fallbackStrategy);
        
        // If fallback has funds and primary is below threshold, rebalance
        if (fallbackBalance > 0 && primaryBalance < totalAssets() / 3) {
            uint256 amountToMove = fallbackBalance / 2; // Move 50% of fallback
            
            // Withdraw from fallback
            _withdrawFromStrategy(fallbackStrategy, amountToMove);
            
            // Deposit to primary
            _depositToStrategy(amountToMove, primaryStrategy);
            
            lastRebalanceTime = block.timestamp;
            emit Rebalanced(amountToMove, amountToMove, block.timestamp);
        }
    }

    /**
     * @notice Get balance in a strategy (simplified)
     * @param strategy Strategy address
     * @return balance Balance of assets
     */
    function _getStrategyBalance(address strategy) internal view returns (uint256) {
        // This should be customized based on actual strategy
        // For ERC4626, it's the balance of this vault's shares
        return IERC20(strategy).balanceOf(address(this));
    }

    /**
     * @notice Withdraw from strategy
     * @param strategy Strategy address
     * @param amount Amount to withdraw
     */
    function _withdrawFromStrategy(address strategy, uint256 amount) internal {
        (bool success, ) = strategy.call(
            abi.encodeWithSignature("withdraw(uint256,address,address)", amount, address(this), address(this))
        );
        require(success, "Withdraw from strategy failed");
    }

    // ====================== VIEW FUNCTIONS ======================
    /**
     * @notice Get user's deposits
     * @param user User address
     * @return User's deposit array
     */
    function getUserDeposits(address user) external view returns (UserDeposit[] memory) {
        return userDeposits[user];
    }

    /**
     * @notice Check if user has active locks
     * @param user User address
     * @return hasActiveLock True if any deposit is still locked
     */
    function hasActiveLock(address user) external view returns (bool) {
        UserDeposit[] storage deposits = userDeposits[user];
        
        for (uint256 i = 0; i < deposits.length; i++) {
            if (deposits[i].unlockTime > 0 && block.timestamp < deposits[i].unlockTime) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Get next unlock time for user
     * @param user User address
     * @return nextUnlock Unix timestamp of next unlock
     */
    function getNextUnlockTime(address user) external view returns (uint256) {
        UserDeposit[] storage deposits = userDeposits[user];
        uint256 nextUnlock = type(uint256).max;
        
        for (uint256 i = 0; i < deposits.length; i++) {
            if (deposits[i].unlockTime > block.timestamp && deposits[i].unlockTime < nextUnlock) {
                nextUnlock = deposits[i].unlockTime;
            }
        }
        
        return nextUnlock == type(uint256).max ? 0 : nextUnlock;
    }

    /**
     * @notice Validate lock period
     * @param days Lock period in days
     * @return isValid True if valid lock period
     */
    function isValidLockPeriod(uint256 days) public pure returns (bool) {
        return days == 30 || days == 90 || days == 180 || days == 365;
    }

    /**
     * @notice Get total yield accrued (user's portion)
     * @return Accrued yield in assets
     */
    function getTotalUserYield() external view returns (uint256) {
        return totalYieldAccrued;
    }

    /**
     * @notice Get total fees accrued (platform's portion)
     * @return Accrued fees in assets
     */
    function getTotalFees() external view returns (uint256) {
        return totalFeesAccrued;
    }

    // ====================== ADMIN FUNCTIONS ======================
    /**
     * @notice Update primary strategy
     * @param newStrategy New strategy address
     */
    function updatePrimaryStrategy(address newStrategy) external onlyOwner {
        require(newStrategy != address(0), "Invalid strategy");
        address oldStrategy = primaryStrategy;
        primaryStrategy = newStrategy;
        emit StrategyUpdated("PRIMARY", newStrategy, oldStrategy);
    }

    /**
     * @notice Update fallback strategy
     * @param newStrategy New strategy address
     */
    function updateFallbackStrategy(address newStrategy) external onlyOwner {
        require(newStrategy != address(0), "Invalid strategy");
        address oldStrategy = fallbackStrategy;
        fallbackStrategy = newStrategy;
        emit StrategyUpdated("FALLBACK", newStrategy, oldStrategy);
    }

    /**
     * @notice Update platform fee (max 15%)
     * @param newFeeBps New fee in basis points
     */
    function updatePlatformFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 1500, "Fee cannot exceed 15%");
        platformFeeBps = newFeeBps;
    }

    /**
     * @notice Update fee recipient
     * @param newRecipient New recipient address
     */
    function updateFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid recipient");
        feeRecipient = newRecipient;
    }

    /**
     * @notice Grant harvester role
     * @param account Account to grant role
     */
    function grantHarvesterRole(address account) external onlyOwner {
        _grantRole(HARVESTER_ROLE, account);
    }

    /**
     * @notice Revoke harvester role
     * @param account Account to revoke role
     */
    function revokeHarvesterRole(address account) external onlyOwner {
        _revokeRole(HARVESTER_ROLE, account);
    }

    /**
     * @notice Pause vault
     */
    function pauseVault() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause vault
     */
    function unpauseVault() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency withdraw all assets from strategies
     * @dev Use only in emergency
     */
    function emergencyWithdraw() external onlyOwner {
        // Implement based on strategy interfaces
        _pause();
    }

    // ====================== INTERNAL VAULT FUNCTIONS ======================
    /**
     * @notice Total assets in vault and strategies
     * @return Total assets
     */
    function totalAssets() public view override returns (uint256) {
        // Sum of vault balance + balances in strategies
        uint256 vaultBalance = assetToken.balanceOf(address(this));
        return vaultBalance; // Customize to add strategy balances
    }

    /**
     * @notice Convert assets to shares
     * @param assets Amount of assets
     * @return Shares amount
     */
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return super.convertToShares(assets);
    }

    /**
     * @notice Convert shares to assets
     * @param shares Amount of shares
     * @return Assets amount
     */
    function convertToAssets(uint256 shares) public view override returns (uint256) {
        return super.convertToAssets(shares);
    }
}
