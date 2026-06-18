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
 * limit and repay over time.
 *
 * ── Accounting (audit v2 V2-HIGH-01 fix) ───────────────────────────────────
 * Drawn principal and accrued interest are tracked SEPARATELY:
 *   • `creditLimit` governs DRAWN PRINCIPAL only — accrued interest never
 *     consumes draw headroom, so a partner can't be locked out of their line
 *     just because interest piled up on a near-limit position.
 *   • Interest accrues as SIMPLE interest on outstanding principal and is
 *     booked into `interestAccrued`. (V2-SC-21: simple, not compound — for long
 *     idle gaps this slightly under-accrues vs. continuous compounding; the
 *     off-chain accrual cron is expected to call a state-changing function
 *     frequently to keep the gap negligible.)
 *   • Repayments and write-offs apply to interest FIRST, then principal.
 *
 * Uncollateralised by design — credit risk is managed off-chain via partner
 * agreements / KYB. On-chain controls: allowlist, per-partner principal limit,
 * suspend (freezes new draws, interest keeps accruing), explicit write-off
 * (auditable, with reason), and a Pausable kill-switch.
 *
 * Custody model: "managed" — the owner may `draw` to a partner's settlement
 * address on their behalf, so partners never need a key or gas.
 *
 * Liquidity note (V2-SC-22): drawn cNGN physically LEAVES the contract, so
 * `idleLiquidity()` = the contract's cNGN balance is exactly the un-lent amount
 * the owner can withdraw. Outstanding debt is owed back TO the contract and is
 * tracked separately in `totalPrincipal`; it is not sitting in the balance.
 */
contract PawasaveCreditLine is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 private constant BASE             = 1e18;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    /// @notice Sanity ceiling on the APR an owner can set (100% APR).
    uint256 public constant MAX_RATE_PER_YEAR = 1e18;
    /// @notice Minimum repayment (1 cNGN) to avoid dust no-op repays (V2-SC-19);
    ///         a full pay-off of a smaller residual debt is always allowed.
    uint256 public constant MIN_REPAY = 1e6;

    IERC20 public immutable cNGN;

    struct Partner {
        bool    active;          // allowlisted + not suspended (gates new draws)
        bool    exists;          // has ever been added
        uint256 creditLimit;     // max DRAWN PRINCIPAL, in cNGN (1e6); interest is separate
        uint256 ratePerYear;     // simple APR, 1e18 mantissa (e.g. 0.18e18 = 18%)
        uint256 principal;       // outstanding drawn principal (1e6)
        uint256 interestAccrued; // booked-but-unpaid interest (1e6)
        uint256 accrualTime;     // last timestamp interest was booked
    }

    mapping(address => Partner) public partners;
    address[] public partnerList;

    /// @notice Sum of all partners' outstanding drawn principal (exposure ex-interest).
    uint256 public totalPrincipal;
    /// @notice Lifetime total written off (for accounting/dashboards — V2-SC-20).
    uint256 public totalWrittenOff;

    // ── Events ────────────────────────────────────────────────────────────────
    event PartnerAdded(address indexed partner, uint256 creditLimit, uint256 ratePerYear);
    event CreditLimitUpdated(address indexed partner, uint256 oldLimit, uint256 newLimit);
    event PartnerRateUpdated(address indexed partner, uint256 oldRate, uint256 newRate);
    event PartnerSuspended(address indexed partner);
    event PartnerReactivated(address indexed partner);
    event InterestAccrued(address indexed partner, uint256 interest, uint256 interestAccrued);
    event Drawn(address indexed partner, address indexed to, uint256 amount, uint256 newPrincipal);
    event Repaid(address indexed partner, address indexed payer, uint256 amount, uint256 principalLeft, uint256 interestLeft);
    event WrittenOff(address indexed partner, uint256 amount, uint256 debtLeft, string reason);
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

    /// @notice Owner withdraws idle (un-lent) cNGN. Drawn funds have already left
    ///         the contract, so the whole balance is withdrawable (V2-SC-22).
    function withdrawLiquidity(uint256 amount, address to) external onlyOwner {
        require(to != address(0), "Bad recipient");
        require(amount > 0 && amount <= idleLiquidity(), "Exceeds idle liquidity");
        cNGN.safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }

    /// @notice cNGN physically held by the contract = un-lent, owner-withdrawable.
    function idleLiquidity() public view returns (uint256) {
        return cNGN.balanceOf(address(this));
    }

    // ── Partner management (owner) ────────────────────────────────────────────

    function addPartner(address partner, uint256 creditLimit, uint256 ratePerYear) external onlyOwner {
        require(partner != address(0), "Bad partner");
        require(!partners[partner].exists, "Already added");
        require(ratePerYear <= MAX_RATE_PER_YEAR, "Rate too high");
        partners[partner] = Partner({
            active:          true,
            exists:          true,
            creditLimit:     creditLimit,
            ratePerYear:     ratePerYear,
            principal:       0,
            interestAccrued: 0,
            accrualTime:     block.timestamp
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

    /// @notice Owner forgives uncollectible debt (interest first, then principal).
    /// @param reason Free-text reason recorded on-chain for compliance (V2-SC-20).
    function writeOff(address partner, uint256 amount, string calldata reason) external onlyOwner {
        _accrue(partner);
        Partner storage p = partners[partner];
        uint256 debt = p.principal + p.interestAccrued;
        require(amount > 0 && amount <= debt, "Bad amount");

        uint256 offInterest = amount > p.interestAccrued ? p.interestAccrued : amount;
        p.interestAccrued -= offInterest;
        uint256 offPrincipal = amount - offInterest;
        if (offPrincipal > 0) {
            p.principal -= offPrincipal;
            totalPrincipal -= offPrincipal;
        }
        totalWrittenOff += amount;
        emit WrittenOff(partner, amount, p.principal + p.interestAccrued, reason);
    }

    // ── Draw / repay ──────────────────────────────────────────────────────────

    /**
     * @notice Draw cNGN against a partner's credit line.
     * @dev Callable by the partner itself OR by the owner (managed custody).
     *      The limit is checked against DRAWN PRINCIPAL only — accrued interest
     *      does NOT consume headroom (V2-HIGH-01).
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
        require(amount <= idleLiquidity(), "Insufficient liquidity");

        p.principal += amount;
        totalPrincipal += amount;
        cNGN.safeTransfer(to, amount);
        emit Drawn(partner, to, amount, p.principal);
    }

    /**
     * @notice Repay a partner's debt (interest first, then principal). Anyone may
     *         pay on a partner's behalf.
     * @param amount cNGN to repay; clamped to the current debt (overpay refunded
     *        by being clamped). Must be >= MIN_REPAY unless it clears the debt.
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

        uint256 debt = p.principal + p.interestAccrued;
        require(debt > 0, "Nothing owed");
        uint256 pay = amount > debt ? debt : amount;
        require(pay >= MIN_REPAY || pay == debt, "Below min repay"); // V2-SC-19

        uint256 toInterest = pay > p.interestAccrued ? p.interestAccrued : pay;
        p.interestAccrued -= toInterest;
        uint256 toPrincipal = pay - toInterest;
        if (toPrincipal > 0) {
            p.principal -= toPrincipal;
            totalPrincipal -= toPrincipal;
        }

        cNGN.safeTransferFrom(msg.sender, address(this), pay);
        emit Repaid(partner, msg.sender, pay, p.principal, p.interestAccrued);
    }

    // ── Interest accrual ──────────────────────────────────────────────────────

    /// @dev Books simple interest accrued on principal since `accrualTime` into
    ///      `interestAccrued`. Principal (the draw-limit measure) is untouched.
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
            p.interestAccrued += interest;
            emit InterestAccrued(partner, interest, p.interestAccrued);
        }
        p.accrualTime = block.timestamp;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Total debt (principal + booked interest + interest pending to now).
    function currentDebt(address partner) public view returns (uint256) {
        Partner storage p = partners[partner];
        if (!p.exists) return 0;
        return p.principal + p.interestAccrued + _pendingInterest(p);
    }

    /// @notice Outstanding drawn principal only (the figure the credit limit caps).
    function outstandingPrincipal(address partner) external view returns (uint256) {
        return partners[partner].principal;
    }

    function _pendingInterest(Partner storage p) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - p.accrualTime;
        if (elapsed == 0 || p.principal == 0 || p.ratePerYear == 0) return 0;
        return (p.principal * p.ratePerYear * elapsed) / (BASE * SECONDS_PER_YEAR);
    }

    /// @notice Remaining headroom a partner can still draw (principal-based, V2-HIGH-01),
    ///         bounded by idle liquidity. 0 if at/over limit or inactive.
    function availableCredit(address partner) external view returns (uint256) {
        Partner storage p = partners[partner];
        if (!p.exists || !p.active || p.principal >= p.creditLimit) return 0;
        uint256 headroom = p.creditLimit - p.principal;
        uint256 liq = idleLiquidity();
        return headroom < liq ? headroom : liq;
    }

    function partnerCount() external view returns (uint256) {
        return partnerList.length;
    }

    // ── Admin / safety ────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}