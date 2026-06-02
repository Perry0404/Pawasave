// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title InterestRateModel
 * @notice Jump-rate (kink) interest rate model for PawaSave cNGN lending pool.
 *
 * Rates are expressed as per-second values scaled by 1e18.
 *
 * Below the kink utilization:
 *   borrowRate = baseRatePerSecond + utilization * multiplierPerSecond
 *
 * Above the kink:
 *   borrowRate = baseRatePerSecond
 *               + kink * multiplierPerSecond
 *               + (utilization - kink) * jumpMultiplierPerSecond
 *
 * Target behaviour (annualised, at 85% utilization ≈ 65% APR borrow rate):
 *   baseRate        =  5%
 *   multiplier      = 40%  (below kink of 80%)
 *   jumpMultiplier  = 300% (above kink — steep to restore liquidity)
 */
contract InterestRateModel {
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant BASE = 1e18;

    uint256 public immutable baseRatePerSecond;
    uint256 public immutable multiplierPerSecond;
    uint256 public immutable jumpMultiplierPerSecond;
    uint256 public immutable kink; // scaled 1e18, e.g. 0.80e18 = 80%

    constructor(
        uint256 baseRatePerYear,   // e.g. 0.05e18 = 5%
        uint256 multiplierPerYear, // e.g. 0.40e18 = 40%
        uint256 jumpMultiplierPerYear, // e.g. 3.00e18 = 300%
        uint256 kink_              // e.g. 0.80e18 = 80%
    ) {
        baseRatePerSecond      = baseRatePerYear      / SECONDS_PER_YEAR;
        multiplierPerSecond    = multiplierPerYear    / SECONDS_PER_YEAR;
        jumpMultiplierPerSecond = jumpMultiplierPerYear / SECONDS_PER_YEAR;
        kink = kink_;
    }

    /**
     * @notice Utilization rate: borrows / (cash + borrows - reserves)
     */
    function utilizationRate(
        uint256 cash,
        uint256 borrows,
        uint256 reserves
    ) public pure returns (uint256) {
        if (borrows == 0) return 0;
        uint256 denominator = cash + borrows - reserves;
        if (denominator == 0) return BASE;
        return (borrows * BASE) / denominator;
    }

    /**
     * @notice Borrow rate per second at the given pool state.
     */
    function getBorrowRate(
        uint256 cash,
        uint256 borrows,
        uint256 reserves
    ) public view returns (uint256) {
        uint256 util = utilizationRate(cash, borrows, reserves);

        if (util <= kink) {
            return baseRatePerSecond + (util * multiplierPerSecond) / BASE;
        }

        uint256 normalRate = baseRatePerSecond + (kink * multiplierPerSecond) / BASE;
        uint256 excessUtil  = util - kink;
        return normalRate + (excessUtil * jumpMultiplierPerSecond) / BASE;
    }

    /**
     * @notice Supply rate per second (what depositors earn).
     * supplyRate = borrowRate * utilization * (1 - reserveFactor)
     */
    function getSupplyRate(
        uint256 cash,
        uint256 borrows,
        uint256 reserves,
        uint256 reserveFactorMantissa // scaled 1e18
    ) public view returns (uint256) {
        uint256 oneMinusReserveFactor = BASE - reserveFactorMantissa;
        uint256 borrowRate = getBorrowRate(cash, borrows, reserves);
        uint256 rateToPool = (borrowRate * oneMinusReserveFactor) / BASE;
        uint256 util = utilizationRate(cash, borrows, reserves);
        return (util * rateToPool) / BASE;
    }

    /**
     * @notice Annualised borrow APR for display purposes.
     */
    function getBorrowAPR(
        uint256 cash,
        uint256 borrows,
        uint256 reserves
    ) external view returns (uint256) {
        return getBorrowRate(cash, borrows, reserves) * SECONDS_PER_YEAR;
    }

    /**
     * @notice Annualised supply APY for display purposes.
     */
    function getSupplyAPY(
        uint256 cash,
        uint256 borrows,
        uint256 reserves,
        uint256 reserveFactorMantissa
    ) external view returns (uint256) {
        return getSupplyRate(cash, borrows, reserves, reserveFactorMantissa) * SECONDS_PER_YEAR;
    }
}
