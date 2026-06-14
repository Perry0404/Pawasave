// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title PawasaveCreditLine
 * @notice B2B (protocol-to-protocol) uncollateralised credit lines.
 *
 * PawaSave extends revolving cNGN credit to vetted partner fintechs. Each
 * partner is allowlisted by the owner with a credit limit and an APR. Partners
 * (or PawaSave operating managed custody on their behalf) draw cNGN up to their
 * limit and repay over time. Interest accrues as simple interest on the
 * outstanding principal and is folded into principal on every state change.
 *
 * This is intentionally NOT collateralised — credit risk is managed off-chain
 * via partner agreements / KYB. On-chain controls:
 *   • only allowlisted, active partners can draw
 *   • a hard per-partner credit limit (principal + accrued interest)
 *   • the owner can suspend a partner (freezes new draws, interest keeps accruing)
 *   • the owner can write off uncollectible debt explicitly (auditable event)
 *   • Pausable kill-switch halts all draws/repays
 *
 * Custody model: "managed" — PawaSave (owner) may `draw` to a partner's
 * settlement address on their behalf, so partners never need to hold gas or a
 * key. Partners may also self-serve `draw` if given their own operator address.
 *
 * Liquidity: the owner funds this contract with cNGN (`fund`) and may withdraw
 * idle (un-drawn) cNGN at any time (`withdrawLiquidity`).
 */
contract PawasaveCreditLine is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 private constant BASE             = 1e18;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    /// @notice Sanity ceiling on the APR an owner can set (100% APR).
    uint256 public constant MAX_RATE_PER_YEAR = 1e18;

    IERC20 public immutable cNGN;

    struct Partner {
        bool    active;        // allowlisted + not suspended (gates new draws)
        bool    exists;        // has ever been added (distinguishes "0-limit" from "unknown")
        uint256 creditLimit;   // max outstanding debt (principal + accrued), in cNGN (1e6)
        uint256 ratePerYear;   // simple APR, 1e18 mantissa (e.g. 0.18e18 = 18%)
        uint256 principal;     // current outstanding debt incl. folded-in interest (1e6)
        uint256 accrualTime;   // last timestamp interest was folded in
    }

    mapping(address => Partner) public partners;
    address[] public partnerList;

    /// @notice Sum of all partners' outstanding principal (for off-chain reconciliation).
    uint256 public totalOutstanding;

    // ── Events ────────────────────────────────────────────────────────────────
    event PartnerAdded(address indexed partner, uint256 creditLimit, uint256 ratePerYear);
    event CreditLimitUpdated(address indexed partner, uint256 oldLimit, uint256 newLimit);
    event PartnerRateUpdated(address indexed partner, uint256 oldRate, uint256 newRate);
    event PartnerSuspended(address indexed partner);
    event PartnerReactivated(address indexed partner);
    event InterestAccrued(address indexed partner, uint256 interest, uint256 newPrincipal);
    event Drawn(address indexed partner, address indexed to, uint256 amount, uint256 newPrincipal);
    event Repaid(address indexed partner, address indexed payer, uint256 amount, uint256 newPrincipal);
    event WrittenOff(address indexed partner, uint256 amount, uint256 newPrincipal);
    event Funded(address indexed from, uint256 amount);
    event LiquidityWithdrawn(address indexed to, uint256 amount);

    constructor(IERC20 _cngn) {
        require(address(_cngn) != address(0), "cNGN required");
        cNGN = _cngn;
    }

    // ── Liquidity management (owner) ──────────────────────────────────────────

    /// @notice Owner deposits cNGN liquidity that partners can draw against.
    function fund(uint256 amount) external onlyOwner {
        require(amount > 0, "Zero amount");
        cNGN.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Owner withdraws idle (un-drawn) cNGN. Cannot touch drawn principal.
    function withdrawLiquidity(uint256 amount, address to) external onlyOwner {
        require(to != address(0), "Bad recipient");
        require(amount > 0 && amount <= availableLiquidity(), "Exceeds idle liquidity");
        cNGN.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    /// @notice Idle cNGN held by the contract that is not lent out.
    function availableLiquidity() public view returns (uint256) {
        return cNGN.balanceOf(address(this));
    }

    // ── Partner management (owner) ────────────────────────────────────────────

    function addPartner(address partner, uint256 creditLimit, uint256 ratePerYear) external onlyOwner {
        require(partner != address(0), "Bad partner");
        require(!partners[partner].exists, "Already added");
        require(ratePerYear <= MAX_RATE_PER_YEAR, "Rate too high");
        partners[partner] = Partner({
            active:      true,
            exists:      true,
            creditLimit: creditLimit,
            ratePerYear: ratePerYear,
            principal:   0,
            accrualTime: block.timestamp
        });
        partnerList.push(partner);
        emit PartnerAdded(partner, creditLimit, ratePerYear);
    }

    function setCreditLimit(address partner, uint256 newLimit) external onlyOwner {
        Partner storage p = partners[partner];
        require(p.exists, "Unknown partner");
        emit CreditLimitUpdated(partner, p.creditLimit, newLimit);
        p.creditLimit = newLimit;
    }

    /// @notice Re-prices a partner. Accrues at the OLD rate up to now, then switches.
    function setPartnerRate(address partner, uint256 newRate) external onlyOwner {
        Partner storage p = partners[partner];
        require(p.exists, "Unknown partner");
        require(newRate <= MAX_RATE_PER_YEAR, "Rate too high");
        _accrue(partner);
        emit PartnerRateUpdated(partner, p.ratePerYear, newRate);
        p.ratePerYear = newRate;
    }

    /// @notice Freezes new draws. Interest keeps accruing; repayments still allowed.
    function suspendPartner(address partner) external onlyOwner {
        Partner storage p = partners[partner];
        require(p.exists, "Unknown partner");
        p.active = false;
        emit PartnerSuspended(partner);
    }

    function reactivatePartner(address partner) external onlyOwner {
        Partner storage p = partners[partner];
        require(p.exists, "Unknown partner");
        p.active = true;
        emit PartnerReactivated(partner);
    }

    /// @notice Owner forgives uncollectible debt (records the loss on-chain).
    function writeOff(address partner, uint256 amount) external onlyOwner {
        _accrue(partner);
        Partner storage p = partners[partner];
        require(amount > 0 && amount <= p.principal, "Bad amount");
        p.principal -= amount;
        totalOutstanding -= amount;
        emit WrittenOff(partner, amount, p.principal);
    }

    // ── Draw / repay ──────────────────────────────────────────────────────────

    /**
     * @notice Draw cNGN against a partner's credit line.
     * @dev Callable by the partner itself OR by the owner (managed custody).
     *      `to` is the settlement address the funds go to.
     */
    function draw(address partner, uint256 amount, address to)
        external
        nonReentrant
        whenNotPaused
    {
        require(msg.sender == partner || msg.sender == owner(), "Not authorised");
        require(to != address(0), "Bad recipient");
        require(amount > 0, "Zero amount");

        _accrue(partner);
        Partner storage p = partners[partner];
        require(p.active, "Partner inactive");
        require(p.principal + amount <= p.creditLimit, "Exceeds credit limit");
        require(amount <= availableLiquidity(), "Insufficient liquidity");

        p.principal += amount;
        totalOutstanding += amount;
        cNGN.safeTransfer(to, amount);
        emit Drawn(partner, to, amount, p.principal);
    }

    /**
     * @notice Repay a partner's debt. Anyone may pay on a partner's behalf.
     * @param amount cNGN to repay; capped at the current debt (overpay is clamped).
     */
    function repay(address partner, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "Zero amount");
        _accrue(partner);
        Partner storage p = partners[partner];
        require(p.exists, "Unknown partner");

        uint256 pay = amount > p.principal ? p.principal : amount;
        require(pay > 0, "Nothing owed");

        p.principal -= pay;
        totalOutstanding -= pay;
        cNGN.safeTransferFrom(msg.sender, address(this), pay);
        emit Repaid(partner, msg.sender, pay, p.principal);
    }

    // ── Interest accrual ──────────────────────────────────────────────────────

    /// @dev Folds simple interest accrued since `accrualTime` into principal.
    function _accrue(address partner) internal {
        Partner storage p = partners[partner];
        if (!p.exists) return;
        uint256 elapsed = block.timestamp - p.accrualTime;
        if (elapsed == 0 || p.principal == 0 || p.ratePerYear == 0) {
            p.accrualTime = block.timestamp;
            return;
        }
        uint256 interest = (p.principal * p.ratePerYear * elapsed) / (BASE * SECONDS_PER_YEAR);
        if (interest > 0) {
            p.principal += interest;
            totalOutstanding += interest;
            emit InterestAccrued(partner, interest, p.principal);
        }
        p.accrualTime = block.timestamp;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Outstanding debt incl. interest accrued up to now (no state change).
    function currentDebt(address partner) public view returns (uint256) {
        Partner storage p = partners[partner];
        if (!p.exists || p.principal == 0) return p.principal;
        uint256 elapsed = block.timestamp - p.accrualTime;
        if (elapsed == 0 || p.ratePerYear == 0) return p.principal;
        uint256 interest = (p.principal * p.ratePerYear * elapsed) / (BASE * SECONDS_PER_YEAR);
        return p.principal + interest;
    }

    /// @notice Remaining headroom a partner can still draw (0 if over/at limit or inactive).
    function availableCredit(address partner) external view returns (uint256) {
        Partner storage p = partners[partner];
        if (!p.exists || !p.active) return 0;
        uint256 debt = currentDebt(partner);
        if (debt >= p.creditLimit) return 0;
        uint256 headroom = p.creditLimit - debt;
        uint256 liq = availableLiquidity();
        return headroom < liq ? headroom : liq;
    }

    function partnerCount() external view returns (uint256) {
        return partnerList.length;
    }

    // ── Admin / safety ────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}