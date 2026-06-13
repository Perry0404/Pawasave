// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./InterestRateModel.sol";
import "./PriceOracle.sol";

/**
 * @title PawasaveLend
 * @notice First cNGN lending pool on Base.
 *
 * Suppliers deposit cNGN → receive psNGN shares (yield-bearing).
 * Borrowers deposit USDC/ETH as collateral → borrow cNGN at market rates.
 *
 * Revenue streams for PawaSave:
 *   1. Reserve factor   — % of all borrower interest → treasury
 *   2. Origination fee  — flat % on every new loan → treasury
 *   3. Liquidation fee  — protocol cut on every liquidation → treasury
 *
 * Interest model: jump-rate (kink at 80% utilization).
 * Target: ~65% borrow APR at 85% utilization → ~49.7% supply APY after fees.
 */
contract PawasaveLend is ERC20, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────────
    uint256 private constant BASE          = 1e18;
    uint256 private constant CNGN_DECIMALS = 1e6;

    // ── Immutables ───────────────────────────────────────────────────────────
    IERC20 public immutable cNGN;
    InterestRateModel public irm;                 // updatable (FIND-SC-25)
    PriceOracle       public immutable oracle;

    // ── Protocol parameters (owner-adjustable) ───────────────────────────────
    uint256 public maxBorrowPerUser;                         // 0 = no cap (FIND-SC-17)
    uint256 public reserveFactorMantissa = 0.10e18;          // 10% of interest → reserves
    uint256 public insuranceShareMantissa = 0.20e18;         // 20% of reserves → insurance fund
    uint256 public originationFeeMantissa = 0.005e18;        // 0.5% flat on every new loan
    uint256 public liquidationBonusMantissa = 0.10e18;       // 10% bonus to liquidator
    uint256 public liquidationProtocolFeeMantissa = 0.02e18; // 2% of liquidation bonus → protocol
    uint256 public closeFactor = 0.50e18;                    // max 50% of debt per liquidation

    address public treasury;
    address public insuranceFund;          // separate address for bad-debt insurance pool
    uint256 public totalInsuranceAccrued;  // total cNGN in insurance fund

    // ── Pool state ───────────────────────────────────────────────────────────
    uint256 public totalBorrows;       // total cNGN borrowed (principal + accrued)
    uint256 public totalReserves;      // cNGN owed to protocol treasury
    uint256 public borrowIndex;        // cumulative borrow interest index (starts at 1e18)
    uint256 public accrualBlockTime;   // last time interest was accrued

    // ── Collateral registry ──────────────────────────────────────────────────
    struct CollateralInfo {
        bool    accepted;
        uint8   decimals;
        uint256 collateralFactor; // per-token LTV (e.g. 0.75e18 = 75% for USDC, 0.60e18 = 60% for cNGN)
    }
    mapping(address => CollateralInfo) public collaterals;
    address[] public collateralList;

    // ── Borrower positions ───────────────────────────────────────────────────
    struct BorrowSnapshot {
        uint256 principal;   // cNGN borrowed (scaled 1e6)
        uint256 interestIndex; // borrowIndex at time of last update
    }

    struct Position {
        mapping(address => uint256) collateralBalances; // token → amount
        BorrowSnapshot borrow;
    }

    mapping(address => Position) private positions;

    // ── Events ───────────────────────────────────────────────────────────────
    event Supplied(address indexed supplier, uint256 cngnAmount, uint256 shares);
    event Withdrawn(address indexed supplier, uint256 cngnAmount, uint256 shares);
    event CollateralDeposited(address indexed borrower, address indexed token, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, address indexed token, uint256 amount);
    event Borrowed(address indexed borrower, uint256 cngnAmount, uint256 fee);
    event Repaid(address indexed borrower, address indexed payer, uint256 cngnAmount);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        uint256 repaidCngn,
        address collateralToken,
        uint256 collateralSeized
    );
    event ReservesCollected(uint256 treasuryAmount, uint256 insuranceAmount);
    event InterestAccrued(uint256 borrowIndex, uint256 totalBorrows, uint256 totalReserves);
    event CollateralAdded(address indexed token, uint8 decimals, uint256 collateralFactor);
    event CollateralRemoved(address indexed token);
    event CollateralFactorUpdated(address indexed token, uint256 newFactor);
    event InterestRateModelUpdated(address indexed newIrm);
    event MaxBorrowPerUserUpdated(uint256 newMax);

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(
        address _cNGN,
        address _irm,
        address _oracle,
        address _treasury,
        address _insuranceFund
    ) ERC20("PawaSave Lending cNGN", "psNGN") Ownable() {
        cNGN          = IERC20(_cNGN);
        irm           = InterestRateModel(_irm);
        oracle        = PriceOracle(_oracle);
        treasury      = _treasury;
        insuranceFund = _insuranceFund != address(0) ? _insuranceFund : _treasury;
        borrowIndex      = BASE;
        accrualBlockTime = block.timestamp;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  INTEREST ACCRUAL
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Accrue interest since last accrual. Must be called before any
     *         state-changing operation.
     */
    function accrueInterest() public {
        uint256 currentTime = block.timestamp;
        uint256 deltaTime   = currentTime - accrualBlockTime;
        if (deltaTime == 0) return;

        uint256 cashPrior     = getCash();
        uint256 borrowsPrior  = totalBorrows;
        uint256 reservesPrior = totalReserves;
        uint256 indexPrior    = borrowIndex;

        uint256 borrowRatePerSecond = irm.getBorrowRate(cashPrior, borrowsPrior, reservesPrior);
        // Linear (simple) interest per accrual period. The accrual/harvest cron
        // calls accrueInterest() frequently (sub-daily), so the inter-accrual gap
        // is small and the divergence from continuous compounding is negligible
        // (FIND-SC-15). Any state-changing op also accrues first.
        uint256 interestFactor   = borrowRatePerSecond * deltaTime;
        uint256 interestAccrued  = (interestFactor * borrowsPrior) / BASE;
        uint256 reservesDelta    = (interestAccrued * reserveFactorMantissa) / BASE;

        totalBorrows   = borrowsPrior  + interestAccrued;
        totalReserves  = reservesPrior + reservesDelta;
        borrowIndex    = indexPrior    + (interestFactor * indexPrior) / BASE;
        accrualBlockTime = currentTime;

        emit InterestAccrued(borrowIndex, totalBorrows, totalReserves);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  SUPPLY / WITHDRAW (depositor side)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit cNGN to earn yield. Receive psNGN shares.
     * @param cngnAmount Amount of cNGN to supply (6 decimals)
     */
    function supply(uint256 cngnAmount) external nonReentrant whenNotPaused returns (uint256 shares) {
        require(cngnAmount > 0, "Zero amount");
        accrueInterest();

        uint256 totalSupplyBefore = totalPoolAssets();
        uint256 sharesToMint = totalSupply() == 0
            ? cngnAmount
            : (cngnAmount * totalSupply()) / totalSupplyBefore;

        cNGN.safeTransferFrom(msg.sender, address(this), cngnAmount);
        _mint(msg.sender, sharesToMint);

        emit Supplied(msg.sender, cngnAmount, sharesToMint);
        return sharesToMint;
    }

    /**
     * @notice Redeem psNGN shares for cNGN.
     * @param shares Number of psNGN shares to redeem
     * @dev Intentionally NOT `whenNotPaused` (FIND-SC-16): suppliers must always be
     *      able to exit, even while the pool is paused (pausing blocks new
     *      supply/borrow/collateral, not redemptions). Liquidity is still bounded
     *      by getCash(), so a paused pool cannot be drained beyond available cash.
     */
    function withdraw(uint256 shares) external nonReentrant returns (uint256 cngnAmount) {
        require(shares > 0, "Zero shares");
        require(balanceOf(msg.sender) >= shares, "Insufficient shares");
        accrueInterest();

        cngnAmount = (shares * totalPoolAssets()) / totalSupply();
        require(getCash() >= cngnAmount, "Insufficient liquidity");

        _burn(msg.sender, shares);
        cNGN.safeTransfer(msg.sender, cngnAmount);

        emit Withdrawn(msg.sender, cngnAmount, shares);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  COLLATERAL MANAGEMENT (borrower side)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit collateral token to back a cNGN borrow.
     */
    function depositCollateral(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(collaterals[token].accepted, "Collateral not accepted");
        require(amount > 0, "Zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        positions[msg.sender].collateralBalances[token] += amount;
        emit CollateralDeposited(msg.sender, token, amount);
    }

    /**
     * @notice Withdraw collateral, subject to remaining borrow health.
     */
    function withdrawCollateral(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(positions[msg.sender].collateralBalances[token] >= amount, "Insufficient collateral");

        positions[msg.sender].collateralBalances[token] -= amount;

        require(_isHealthy(msg.sender), "Would breach collateral factor");

        IERC20(token).safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, token, amount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  BORROW / REPAY
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Borrow cNGN against deposited collateral.
     * @param cngnAmount Amount of cNGN to borrow (6 decimals)
     */
    function borrow(uint256 cngnAmount) external nonReentrant whenNotPaused {
        require(cngnAmount > 0, "Zero amount");
        accrueInterest();
        require(getCash() >= cngnAmount, "Insufficient liquidity");

        // Origination fee is added to the borrower's debt (they repay the gross
        // cngnAmount) and booked to reserves. This is NOT a double-count: the
        // borrower's snapshot and totalBorrows both move by the same gross amount
        // (individual vs global accounting), and totalPoolAssets stays invariant
        // across a borrow -> full-repay cycle. (FIND-SC-11)
        uint256 originationFee = (cngnAmount * originationFeeMantissa) / BASE;
        uint256 proceeds       = cngnAmount - originationFee;

        // Update borrow position
        _updateBorrowBalance(msg.sender, cngnAmount, true);
        totalBorrows += cngnAmount;
        totalReserves += originationFee;

        require(_isHealthy(msg.sender), "Insufficient collateral");
        // Optional per-user borrow cap to limit single-borrower concentration (FIND-SC-17)
        if (maxBorrowPerUser > 0) {
            require(borrowBalanceCurrent(msg.sender) <= maxBorrowPerUser, "Exceeds per-user borrow cap");
        }

        cNGN.safeTransfer(msg.sender, proceeds);
        emit Borrowed(msg.sender, cngnAmount, originationFee);
    }

    /**
     * @notice Repay cNGN debt (caller pays for themselves or on behalf of borrower).
     * @param borrower    Address of the borrower
     * @param cngnAmount  Amount to repay; type(uint256).max = full repayment
     */
    function repay(address borrower, uint256 cngnAmount) external nonReentrant {
        accrueInterest();

        uint256 currentDebt = borrowBalanceCurrent(borrower);
        require(currentDebt > 0, "No debt");

        uint256 actualRepay = cngnAmount == type(uint256).max ? currentDebt : cngnAmount;
        require(actualRepay <= currentDebt, "Repay exceeds debt");

        cNGN.safeTransferFrom(msg.sender, address(this), actualRepay);
        _updateBorrowBalance(borrower, actualRepay, false);
        totalBorrows = totalBorrows > actualRepay ? totalBorrows - actualRepay : 0;

        emit Repaid(borrower, msg.sender, actualRepay);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  LIQUIDATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Liquidate an unhealthy position.
     * @param borrower        Address of underwater borrower
     * @param repayAmount     cNGN to repay (max = closeFactor * debt)
     * @param collateralToken Token to seize as payment
     */
    function liquidate(
        address borrower,
        uint256 repayAmount,
        address collateralToken
    ) external nonReentrant {
        require(borrower != msg.sender, "Cannot self-liquidate");
        accrueInterest();

        require(!_isHealthy(borrower), "Position is healthy");

        uint256 currentDebt = borrowBalanceCurrent(borrower);
        uint256 maxRepay    = (currentDebt * closeFactor) / BASE;
        require(repayAmount <= maxRepay, "Exceeds close factor");
        require(repayAmount > 0, "Zero repay");

        // Seize collateral worth repayAmount * (1 + liquidationBonus)
        uint256 seizeValue   = (repayAmount * (BASE + liquidationBonusMantissa)) / BASE;
        uint256 seizeAmount  = _cngnToCollateral(collateralToken, seizeValue);
        require(
            positions[borrower].collateralBalances[collateralToken] >= seizeAmount,
            "Insufficient collateral to seize"
        );

        // Protocol takes cut of the bonus
        uint256 protocolCut = (seizeAmount * liquidationProtocolFeeMantissa) / BASE;
        uint256 liquidatorSeize = seizeAmount - protocolCut;

        // Execute repayment
        cNGN.safeTransferFrom(msg.sender, address(this), repayAmount);
        _updateBorrowBalance(borrower, repayAmount, false);
        totalBorrows = totalBorrows > repayAmount ? totalBorrows - repayAmount : 0;

        // Transfer collateral
        positions[borrower].collateralBalances[collateralToken] -= seizeAmount;
        IERC20(collateralToken).safeTransfer(msg.sender, liquidatorSeize);
        IERC20(collateralToken).safeTransfer(treasury, protocolCut);

        emit Liquidated(msg.sender, borrower, repayAmount, collateralToken, seizeAmount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════════════

    /** @notice cNGN held in contract (cash) */
    function getCash() public view returns (uint256) {
        return cNGN.balanceOf(address(this)) - _availableReserves();
    }

    /** @notice Total cNGN owed to suppliers (cash + borrows - reserves) */
    function totalPoolAssets() public view returns (uint256) {
        // Underflow-safe: in a partial bad-debt scenario reserves could momentarily
        // exceed cash+borrows; clamp at 0 rather than reverting (FIND-SC-14).
        uint256 assets = cNGN.balanceOf(address(this)) + totalBorrows;
        return assets > totalReserves ? assets - totalReserves : 0;
    }

    /** @notice cNGN value of one psNGN share */
    function exchangeRate() public view returns (uint256) {
        uint256 totalShares = totalSupply();
        if (totalShares == 0) return CNGN_DECIMALS; // 1:1
        return (totalPoolAssets() * BASE) / totalShares;
    }

    /** @notice Current borrow balance for a borrower (with accrued interest) */
    function borrowBalanceCurrent(address borrower) public view returns (uint256) {
        BorrowSnapshot storage snap = positions[borrower].borrow;
        if (snap.principal == 0) return 0;
        return (snap.principal * borrowIndex) / snap.interestIndex;
    }

    /** @notice Collateral balance for a borrower */
    function collateralBalance(address borrower, address token) external view returns (uint256) {
        return positions[borrower].collateralBalances[token];
    }

    /** @notice Raw cNGN value of all collateral (no LTV applied) */
    function totalCollateralValue(address borrower) public view returns (uint256 totalValue) {
        for (uint256 i = 0; i < collateralList.length; i++) {
            address token = collateralList[i];
            uint256 bal   = positions[borrower].collateralBalances[token];
            if (bal == 0) continue;
            totalValue += oracle.collateralToCngn(token, bal, collaterals[token].decimals);
        }
    }

    /**
     * @notice Max cNGN a borrower can borrow — applies per-token collateral factor.
     * Each collateral token has its own LTV: USDC=75%, cNGN=60%, T-bills=70% etc.
     */
    function borrowLimit(address borrower) public view returns (uint256 limit) {
        for (uint256 i = 0; i < collateralList.length; i++) {
            address token = collateralList[i];
            uint256 bal   = positions[borrower].collateralBalances[token];
            if (bal == 0) continue;
            uint256 tokenValue = oracle.collateralToCngn(token, bal, collaterals[token].decimals);
            limit += (tokenValue * collaterals[token].collateralFactor) / BASE;
        }
    }

    /** @notice True if position health factor >= 1 */
    function _isHealthy(address borrower) internal view returns (bool) {
        uint256 debt = borrowBalanceCurrent(borrower);
        if (debt == 0) return true;
        return borrowLimit(borrower) >= debt;
    }

    function isHealthy(address borrower) external view returns (bool) {
        return _isHealthy(borrower);
    }

    /** @notice Current borrow APR (annualised, 1e18 = 100%) */
    function currentBorrowAPR() external view returns (uint256) {
        return irm.getBorrowAPR(getCash(), totalBorrows, totalReserves);
    }

    /** @notice Current supply APY (annualised, 1e18 = 100%) */
    function currentSupplyAPY() external view returns (uint256) {
        return irm.getSupplyAPY(getCash(), totalBorrows, totalReserves, reserveFactorMantissa);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  ADMIN
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Add a collateral token with its own LTV.
     * @param token            ERC-20 collateral address
     * @param decimals_        Token decimals
     * @param collateralFactor LTV mantissa (e.g. 0.75e18 = 75%, 0.60e18 = 60%)
     */
    function addCollateral(address token, uint8 decimals_, uint256 collateralFactor) external onlyOwner {
        require(!collaterals[token].accepted, "Already added");
        require(collateralFactor <= 0.85e18, "Max CF 85%");
        collaterals[token] = CollateralInfo({ accepted: true, decimals: decimals_, collateralFactor: collateralFactor });
        collateralList.push(token);
        emit CollateralAdded(token, decimals_, collateralFactor);
    }

    function removeCollateral(address token) external onlyOwner {
        require(collaterals[token].accepted, "Not accepted");
        collaterals[token].accepted = false;
        // Trim from collateralList so the value loops don't iterate dead tokens
        // forever (FIND-SC-19).
        uint256 len = collateralList.length;
        for (uint256 i = 0; i < len; i++) {
            if (collateralList[i] == token) {
                collateralList[i] = collateralList[len - 1];
                collateralList.pop();
                break;
            }
        }
        emit CollateralRemoved(token);
    }

    /** @notice Update the LTV for an existing collateral token */
    function setCollateralFactor(address token, uint256 newFactor) external onlyOwner {
        require(collaterals[token].accepted, "Not accepted");
        require(newFactor <= 0.85e18, "Max 85%");
        collaterals[token].collateralFactor = newFactor;
        emit CollateralFactorUpdated(token, newFactor);
    }

    function setReserveFactor(uint256 newFactor) external onlyOwner {
        require(newFactor <= 0.30e18, "Max 30%");
        reserveFactorMantissa = newFactor;
    }

    function setInsuranceShare(uint256 newShare) external onlyOwner {
        require(newShare <= 0.50e18, "Max 50% of reserves");
        insuranceShareMantissa = newShare;
    }

    function setOriginationFee(uint256 newFee) external onlyOwner {
        require(newFee <= 0.02e18, "Max 2%");
        originationFeeMantissa = newFee;
    }

    /** @notice Swap the interest-rate model (e.g. as Nigeria's MPR changes). FIND-SC-25 */
    function setInterestRateModel(address newIrm) external onlyOwner {
        require(newIrm != address(0), "Zero address");
        accrueInterest(); // settle interest under the old model first
        irm = InterestRateModel(newIrm);
        emit InterestRateModelUpdated(newIrm);
    }

    /** @notice Set the max total debt a single borrower may hold (0 = no cap). FIND-SC-17 */
    function setMaxBorrowPerUser(uint256 newMax) external onlyOwner {
        maxBorrowPerUser = newMax;
        emit MaxBorrowPerUserUpdated(newMax);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Zero address");
        treasury = newTreasury;
    }

    function setInsuranceFund(address newFund) external onlyOwner {
        require(newFund != address(0), "Zero address");
        insuranceFund = newFund;
    }

    /**
     * @notice Collect accrued reserves — splits between treasury and insurance fund.
     * Default: 80% treasury, 20% insurance fund.
     */
    function collectReserves() external onlyOwner {
        accrueInterest();
        uint256 amount = _availableReserves();
        require(amount > 0, "No reserves");
        totalReserves -= amount;

        uint256 insuranceCut = (amount * insuranceShareMantissa) / BASE;
        uint256 treasuryCut  = amount - insuranceCut;

        if (insuranceCut > 0) {
            totalInsuranceAccrued += insuranceCut;
            cNGN.safeTransfer(insuranceFund, insuranceCut);
        }
        cNGN.safeTransfer(treasury, treasuryCut);
        emit ReservesCollected(treasuryCut, insuranceCut);
    }

    function pausePool() external onlyOwner { _pause(); }
    function unpausePool() external onlyOwner { _unpause(); }

    // ══════════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    function _updateBorrowBalance(address borrower, uint256 amount, bool isBorrow) internal {
        BorrowSnapshot storage snap = positions[borrower].borrow;
        uint256 current = snap.principal == 0
            ? 0
            : (snap.principal * borrowIndex) / snap.interestIndex;

        if (isBorrow) {
            snap.principal     = current + amount;
        } else {
            snap.principal     = current > amount ? current - amount : 0;
        }
        snap.interestIndex = borrowIndex;
    }

    /** @notice Reserves held in contract but not yet transferred to treasury */
    function _availableReserves() internal view returns (uint256) {
        uint256 cash = cNGN.balanceOf(address(this));
        return totalReserves < cash ? totalReserves : cash;
    }

    /** @notice Convert cNGN amount to collateral token amount */
    function _cngnToCollateral(address token, uint256 cngnAmt) internal view returns (uint256) {
        // Use getPrice (staleness-enforced) instead of the raw prices mapping, so a
        // stale oracle can't be used to over-seize collateral in liquidation (FIND-SC-13).
        uint256 price = oracle.getPrice(token); // cNGN per 1e18 collateral
        uint8 dec = collaterals[token].decimals;
        // cngnAmt (1e6) → collateral units
        // price = cNGN (1e6) per 1e18 normalised collateral
        uint256 normalised = (cngnAmt * 1e18) / price;
        return dec <= 18
            ? normalised / (10 ** (18 - dec))
            : normalised * (10 ** (dec - 18));
    }
}
