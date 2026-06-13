// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./IStrategy.sol";

/**
 * @title Pawasave P-AUTO Vault
 * @notice ERC4626 multi-strategy yield aggregator for cNGN with flexible and
 *         fixed (30/90/180/365-day) savings.
 *
 * Security redesign (audit Batch 7b):
 *  - O(1) lock accounting (FIND-SC-01): a per-user `lockedShares` counter is
 *    checked on withdrawal instead of iterating an unbounded deposit array.
 *  - Locks only restrict the locked portion (FIND-SC-02): flexible/matured
 *    shares are always withdrawable. Fixed deposits must name the caller as
 *    receiver, removing the deposit-to-victim griefing vector.
 *  - Donation-proof accounting (FIND-SC-03/08): totalAssets() uses an internal
 *    `deployedAssets` counter, never a strategy's raw token balance.
 *  - Strategy safety (FIND-SC-05/07): strategies implement IStrategy, are
 *    interface-sanity-checked, and can only change through a 48h timelock.
 *  - Real emergency withdraw (FIND-SC-06) and surfaced harvest errors (FIND-SC-04).
 *  - ERC4626 inflation resistance via a decimals offset.
 */
contract PawasaveAutoVault is ERC4626, Ownable2Step, ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant HARVESTER_ROLE = keccak256("HARVESTER_ROLE");

    enum DepositType { FLEXIBLE, FIXED_30, FIXED_90, FIXED_180, FIXED_365 }

    struct Lock {
        uint256 shares;
        uint256 unlockTime;
    }

    // ── State ────────────────────────────────────────────────────────────────
    IERC20 public immutable assetToken;

    address public primaryStrategy;
    address public fallbackStrategy;

    // Internal principal accounting — donation-proof totalAssets (FIND-SC-03).
    uint256 public deployedAssets;

    // Fees
    uint256 public platformFeeBps = 600; // 6%
    address public feeRecipient;
    uint256 public totalFeesAccrued;

    // O(1) lock accounting (FIND-SC-01/02)
    mapping(address => Lock[])   public userLocks;
    mapping(address => uint256)  public lockedShares;

    // Yield metrics
    uint256 public totalYieldHarvested;

    // Rebalance
    uint256 public lastRebalanceTime;
    uint256 public rebalanceInterval = 7 days;

    // Strategy-change timelock (FIND-SC-07)
    uint256 public constant STRATEGY_TIMELOCK = 48 hours;
    address public pendingPrimary;
    uint256 public pendingPrimaryEta;
    address public pendingFallback;
    uint256 public pendingFallbackEta;

    // ── Events ─────────────────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 assets, uint256 shares, DepositType depositType, uint256 unlockTime);
    event LocksReleased(address indexed user, uint256 freedShares);
    event YieldHarvested(uint256 totalYield, uint256 platformFee, uint256 userYield, uint256 timestamp);
    event Rebalanced(uint256 amount, uint256 timestamp);
    event StrategyProposed(string strategyType, address newStrategy, uint256 eta);
    event StrategyUpdated(string strategyType, address newAddress, address oldAddress);
    event HarvestFailed(address indexed strategy);
    event EmergencyWithdrawFailed(address indexed strategy);

    modifier onlyHarvester() {
        require(hasRole(HARVESTER_ROLE, msg.sender), "Not harvester");
        _;
    }

    constructor(
        IERC20 _asset,
        address _primaryStrategy,
        address _fallbackStrategy,
        address _feeRecipient
    ) ERC4626(_asset) ERC20("Pawasave Auto", "pAUTO") Ownable() {
        require(_feeRecipient != address(0), "Invalid fee recipient");
        assetToken = _asset;
        _validateStrategy(_primaryStrategy);
        if (_fallbackStrategy != address(0)) _validateStrategy(_fallbackStrategy);
        primaryStrategy = _primaryStrategy;
        fallbackStrategy = _fallbackStrategy;
        feeRecipient = _feeRecipient;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(HARVESTER_ROLE, msg.sender);
    }

    // ── ERC4626 inflation resistance ───────────────────────────────────────────
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ── Deposits ───────────────────────────────────────────────────────────────
    /// @notice Flexible deposit (no lock). Any receiver allowed.
    function depositFlexible(uint256 assets, address receiver)
        external nonReentrant whenNotPaused returns (uint256 shares)
    {
        require(assets > 0, "Zero deposit");
        require(receiver != address(0), "Invalid receiver");
        shares = previewDeposit(assets);
        _deposit(_msgSender(), receiver, assets, shares);
        emit Deposited(receiver, assets, shares, DepositType.FLEXIBLE, 0);
    }

    /// @notice Fixed deposit with a lock. Receiver MUST be the caller so nobody
    /// can lock another account's funds (FIND-SC-02 griefing).
    function depositFixed(uint256 assets, address receiver, uint256 lockDays)
        external nonReentrant whenNotPaused returns (uint256 shares)
    {
        require(assets > 0, "Zero deposit");
        require(receiver == _msgSender(), "Fixed: receiver must be caller");
        require(isValidLockPeriod(lockDays), "Invalid lock period");

        shares = previewDeposit(assets);
        _deposit(_msgSender(), receiver, assets, shares);

        uint256 unlockTime = block.timestamp + (lockDays * 1 days);
        userLocks[receiver].push(Lock({ shares: shares, unlockTime: unlockTime }));
        lockedShares[receiver] += shares;

        emit Deposited(receiver, assets, shares, _depositTypeFor(lockDays), unlockTime);
    }

    /// @dev Route every mint of assets into the strategy.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares); // pulls assets, mints shares
        _depositToStrategy(assets);
    }

    function deposit(uint256 assets, address receiver) public override whenNotPaused nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override whenNotPaused nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    // ── Withdrawals (lock-aware, O(1)) ─────────────────────────────────────────
    function withdraw(uint256 assets, address receiver, address owner)
        public override nonReentrant returns (uint256 shares)
    {
        shares = previewWithdraw(assets);
        _enforceUnlocked(owner, shares);
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public override nonReentrant returns (uint256)
    {
        _enforceUnlocked(owner, shares);
        return super.redeem(shares, receiver, owner);
    }

    /// @dev O(1): a withdrawal must leave at least `lockedShares[owner]` behind.
    function _enforceUnlocked(address owner, uint256 shares) internal view {
        require(balanceOf(owner) >= shares, "Insufficient shares");
        require(balanceOf(owner) - shares >= lockedShares[owner], "Funds still locked");
    }

    /// @notice Free shares from matured locks. Caller pays gas for their own
    /// array; withdrawals stay O(1) regardless of how many locks exist.
    function releaseMatured() external {
        Lock[] storage ls = userLocks[msg.sender];
        uint256 freed;
        uint256 i;
        while (i < ls.length) {
            if (block.timestamp >= ls[i].unlockTime) {
                freed += ls[i].shares;
                ls[i] = ls[ls.length - 1];
                ls.pop();
            } else {
                i++;
            }
        }
        if (freed > 0) {
            lockedShares[msg.sender] -= freed;
            emit LocksReleased(msg.sender, freed);
        }
    }

    /// @dev Pull funds back from the primary strategy on the way out if needed.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal override
    {
        uint256 bal = assetToken.balanceOf(address(this));
        if (bal < assets) {
            _withdrawFromStrategy(primaryStrategy, assets - bal);
        }
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ── Strategy plumbing ──────────────────────────────────────────────────────
    function _depositToStrategy(uint256 assets) internal {
        address strat = primaryStrategy;
        require(strat != address(0), "No strategy");
        assetToken.forceApprove(strat, assets);
        IStrategy(strat).deposit(assets);
        deployedAssets += assets;
    }

    function _withdrawFromStrategy(address strat, uint256 amount) internal returns (uint256 got) {
        require(strat != address(0), "No strategy");
        got = IStrategy(strat).withdraw(amount);
        deployedAssets = deployedAssets > got ? deployedAssets - got : 0;
    }

    /// @notice totalAssets = idle cash + deployed principal (donation-proof).
    function totalAssets() public view override returns (uint256) {
        return assetToken.balanceOf(address(this)) + deployedAssets;
    }

    // ── Yield harvest ──────────────────────────────────────────────────────────
    function harvestYield() external onlyHarvester nonReentrant returns (uint256 totalYield) {
        uint256 before = assetToken.balanceOf(address(this));

        // Best-effort; a strategy without harvest() is tolerated but surfaced.
        try IStrategy(primaryStrategy).harvest() {} catch { emit HarvestFailed(primaryStrategy); }

        uint256 received = assetToken.balanceOf(address(this)) - before;
        if (received == 0) return 0; // clean no-op (FIND-SC-09)
        totalYield = received;

        uint256 platformFee = (totalYield * platformFeeBps) / 10_000;
        uint256 userYield = totalYield - platformFee;

        totalFeesAccrued += platformFee;
        totalYieldHarvested += totalYield;

        if (platformFee > 0) assetToken.safeTransfer(feeRecipient, platformFee);
        // userYield stays as idle cash → totalAssets up → share price up for all.

        emit YieldHarvested(totalYield, platformFee, userYield, block.timestamp);
    }

    // ── Rebalance ──────────────────────────────────────────────────────────────
    function rebalance() external onlyOwner {
        require(block.timestamp >= lastRebalanceTime + rebalanceInterval, "Rebalance interval not met");
        if (fallbackStrategy == address(0)) return;

        uint256 fallbackBal = IStrategy(fallbackStrategy).totalAssets();
        if (fallbackBal > 0 && IStrategy(primaryStrategy).totalAssets() < totalAssets() / 3) {
            uint256 amount = fallbackBal / 2;
            uint256 got = IStrategy(fallbackStrategy).withdraw(amount);
            assetToken.forceApprove(primaryStrategy, got);
            IStrategy(primaryStrategy).deposit(got);
            lastRebalanceTime = block.timestamp;
            emit Rebalanced(got, block.timestamp);
        }
    }

    // ── Views ──────────────────────────────────────────────────────────────────
    function getUserLocks(address user) external view returns (Lock[] memory) {
        return userLocks[user];
    }

    function maxWithdrawableShares(address user) external view returns (uint256) {
        uint256 bal = balanceOf(user);
        uint256 locked = lockedShares[user];
        return bal > locked ? bal - locked : 0;
    }

    function hasActiveLock(address user) external view returns (bool) {
        Lock[] storage ls = userLocks[user];
        for (uint256 i = 0; i < ls.length; i++) {
            if (block.timestamp < ls[i].unlockTime) return true;
        }
        return false;
    }

    function getNextUnlockTime(address user) external view returns (uint256) {
        Lock[] storage ls = userLocks[user];
        uint256 next = type(uint256).max;
        for (uint256 i = 0; i < ls.length; i++) {
            if (ls[i].unlockTime > block.timestamp && ls[i].unlockTime < next) next = ls[i].unlockTime;
        }
        return next == type(uint256).max ? 0 : next;
    }

    function isValidLockPeriod(uint256 lockDays) public pure returns (bool) {
        return lockDays == 30 || lockDays == 90 || lockDays == 180 || lockDays == 365;
    }

    function _depositTypeFor(uint256 lockDays) internal pure returns (DepositType) {
        if (lockDays == 30) return DepositType.FIXED_30;
        if (lockDays == 90) return DepositType.FIXED_90;
        if (lockDays == 180) return DepositType.FIXED_180;
        return DepositType.FIXED_365;
    }

    // ── Admin: strategy changes via timelock (FIND-SC-05/07) ───────────────────
    function _validateStrategy(address strategy) internal view {
        require(strategy != address(0), "Invalid strategy");
        require(IStrategy(strategy).asset() == address(assetToken), "Strategy asset mismatch");
    }

    function proposePrimaryStrategy(address newStrategy) external onlyOwner {
        _validateStrategy(newStrategy);
        pendingPrimary = newStrategy;
        pendingPrimaryEta = block.timestamp + STRATEGY_TIMELOCK;
        emit StrategyProposed("PRIMARY", newStrategy, pendingPrimaryEta);
    }

    function executePrimaryStrategy() external onlyOwner {
        require(pendingPrimary != address(0), "No pending");
        require(block.timestamp >= pendingPrimaryEta, "Timelock active");
        address old = primaryStrategy;
        primaryStrategy = pendingPrimary;
        pendingPrimary = address(0);
        emit StrategyUpdated("PRIMARY", primaryStrategy, old);
    }

    function proposeFallbackStrategy(address newStrategy) external onlyOwner {
        _validateStrategy(newStrategy);
        pendingFallback = newStrategy;
        pendingFallbackEta = block.timestamp + STRATEGY_TIMELOCK;
        emit StrategyProposed("FALLBACK", newStrategy, pendingFallbackEta);
    }

    function executeFallbackStrategy() external onlyOwner {
        require(pendingFallback != address(0), "No pending");
        require(block.timestamp >= pendingFallbackEta, "Timelock active");
        address old = fallbackStrategy;
        fallbackStrategy = pendingFallback;
        pendingFallback = address(0);
        emit StrategyUpdated("FALLBACK", fallbackStrategy, old);
    }

    function updatePlatformFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 1500, "Fee cannot exceed 15%");
        platformFeeBps = newFeeBps;
    }

    function updateFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid recipient");
        feeRecipient = newRecipient;
    }

    function grantHarvesterRole(address account) external onlyOwner { _grantRole(HARVESTER_ROLE, account); }
    function revokeHarvesterRole(address account) external onlyOwner { _revokeRole(HARVESTER_ROLE, account); }

    function pauseVault() external onlyOwner { _pause(); }
    function unpauseVault() external onlyOwner { _unpause(); }

    /// @notice Pull everything back from strategies into the vault, then pause
    /// (FIND-SC-06). Best-effort; failures are surfaced, not reverted.
    function emergencyWithdraw() external onlyOwner {
        _pause();
        _emergencyPull(primaryStrategy);
        if (fallbackStrategy != address(0)) _emergencyPull(fallbackStrategy);
    }

    function _emergencyPull(address strat) internal {
        uint256 amt = IStrategy(strat).totalAssets();
        if (amt == 0) return;
        try IStrategy(strat).withdraw(amt) returns (uint256 got) {
            deployedAssets = deployedAssets > got ? deployedAssets - got : 0;
        } catch {
            emit EmergencyWithdrawFailed(strat);
        }
    }
}