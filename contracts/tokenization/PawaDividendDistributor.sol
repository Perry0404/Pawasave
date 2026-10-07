// SPDX-License-Identifier: UNLICENSED
// Copyright (c) 2026 CASEWINAI LIMITED (RC 9425438). All rights reserved. Proprietary and confidential.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

interface IPawaEquityToken {
    function balanceOfAt(address account, uint256 snapshotId) external view returns (uint256);
    function totalSupplyAt(uint256 snapshotId) external view returns (uint256);
    function snapshotAt(uint256 snapshotId) external view returns (uint64);
    function verified(address account) external view returns (bool);
    function redemptions(uint256 id)
        external
        view
        returns (address holder, uint256 amount, uint8 kind, uint8 status, uint64 createdAt, uint64 closedAt);
}

/**
 * @title PawaDividendDistributor
 * @notice Pays a cash dividend on one PawaEquityToken, in cNGN, pro-rata to holders as at the
 *         token's record-date snapshot (SEC response §5; Annex F).
 *
 *  - The ISSUER declares a dividend against a snapshot: the net amount received from the registrar
 *    (after withholding tax) and the registrar's payment reference.
 *  - The TRUSTEE approves it. Approval succeeds only if this contract already holds the cNGN, so a
 *    dividend can never be approved unfunded.
 *  - Each holder's share is computed here from the snapshot, not supplied by anyone:
 *        amount = total x (holder's tokens at the snapshot) / (tokens in issue at the snapshot)
 *    Anyone may trigger payment to a holder; the money can only go to that holder. Each is paid once.
 *  - Tokens locked in a redemption at the record date still earn the dividend: it is paid to the
 *    holder who locked them (the shares were still in the pool).
 *  - A holder who is no longer on the verified register is not paid until that is resolved.
 *  - Rounding is always down; the few kobo left over stay here and the trustee can recover
 *    amounts unclaimed after twelve months.
 */
contract PawaDividendDistributor is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant TRUSTEE_ROLE = keccak256("TRUSTEE_ROLE");

    uint256 public constant UNCLAIMED_PERIOD = 365 days;

    struct Dividend {
        uint256 snapshotId;
        uint256 total;        // net cNGN to distribute
        uint256 supplyAt;     // tokens in issue at the snapshot
        uint256 paid;
        uint64 declaredAt;
        bool approved;
        bool closed;
        string paymentRef;    // registrar payment reference
    }

    IPawaEquityToken public immutable token;
    IERC20 public immutable cngn;

    Dividend[] public dividends;
    uint256 public committed; // approved and not yet paid, across all dividends

    mapping(uint256 => mapping(address => bool)) public paidTo;
    mapping(uint256 => mapping(uint256 => bool)) public paidRedemption;

    event DividendDeclared(uint256 indexed id, uint256 snapshotId, uint256 total, uint256 supplyAt, string paymentRef);
    event DividendApproved(uint256 indexed id, address indexed trustee);
    event DividendPaid(uint256 indexed id, address indexed holder, uint256 amount);
    event DividendClosed(uint256 indexed id, address indexed to, uint256 unclaimed);

    constructor(address token_, address cngn_, address admin) {
        require(token_ != address(0) && cngn_ != address(0) && admin != address(0), "zero address");
        token = IPawaEquityToken(token_);
        cngn = IERC20(cngn_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function dividendCount() external view returns (uint256) {
        return dividends.length;
    }

    function declare(uint256 snapshotId, uint256 total, string calldata paymentRef)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 id)
    {
        require(total > 0, "zero amount");
        require(token.snapshotAt(snapshotId) != 0, "no such record date");
        uint256 supplyAt = token.totalSupplyAt(snapshotId);
        require(supplyAt > 0, "no tokens at record date");
        id = dividends.length;
        dividends.push(Dividend(snapshotId, total, supplyAt, 0, uint64(block.timestamp), false, false, paymentRef));
        emit DividendDeclared(id, snapshotId, total, supplyAt, paymentRef);
    }

    /// @notice The trustee's check: the money must already be here.
    function approve(uint256 id) external onlyRole(TRUSTEE_ROLE) {
        Dividend storage d = dividends[id];
        require(!d.approved, "already approved");
        require(cngn.balanceOf(address(this)) >= committed + d.total, "not funded");
        d.approved = true;
        committed += d.total;
        emit DividendApproved(id, msg.sender);
    }

    /// @notice A holder's dividend on the tokens in their wallet at the record date.
    function entitlement(uint256 id, address account) public view returns (uint256) {
        Dividend storage d = dividends[id];
        if (account == address(token)) return 0; // locked tokens are paid through payLocked
        return (d.total * token.balanceOfAt(account, d.snapshotId)) / d.supplyAt;
    }

    function pay(uint256 id, address account) public {
        Dividend storage d = dividends[id];
        require(d.approved && !d.closed, "not payable");
        require(!paidTo[id][account], "already paid");
        uint256 amount = entitlement(id, account);
        require(amount > 0, "nothing due");
        paidTo[id][account] = true;
        _send(d, id, account, amount);
    }

    function payMany(uint256 id, address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            if (!paidTo[id][accounts[i]] && entitlement(id, accounts[i]) > 0 && token.verified(accounts[i])) {
                pay(id, accounts[i]);
            }
        }
    }

    /// @notice Dividend on tokens that were locked in a redemption at the record date.
    ///         The comparisons are strict so that a redemption opened or closed in the same second
    ///         as the snapshot is never paid twice.
    function payLocked(uint256 id, uint256 redemptionId) external {
        Dividend storage d = dividends[id];
        require(d.approved && !d.closed, "not payable");
        require(!paidRedemption[id][redemptionId], "already paid");
        (address holder, uint256 amount, , uint8 status, uint64 createdAt, uint64 closedAt) = token.redemptions(redemptionId);
        uint64 at = token.snapshotAt(d.snapshotId);
        require(createdAt < at && (status == 0 || closedAt > at), "not locked at record date");
        paidRedemption[id][redemptionId] = true;
        _send(d, id, holder, (d.total * amount) / d.supplyAt);
    }

    /// @notice After twelve months the trustee recovers what was never claimed, to hold for holders.
    function close(uint256 id, address to) external onlyRole(TRUSTEE_ROLE) {
        Dividend storage d = dividends[id];
        require(d.approved && !d.closed, "not open");
        require(block.timestamp >= d.declaredAt + UNCLAIMED_PERIOD, "too early");
        require(to != address(0), "zero address");
        d.closed = true;
        uint256 unclaimed = d.total - d.paid;
        committed -= unclaimed;
        if (unclaimed > 0) cngn.safeTransfer(to, unclaimed);
        emit DividendClosed(id, to, unclaimed);
    }

    function _send(Dividend storage d, uint256 id, address holder, uint256 amount) private {
        require(token.verified(holder), "holder not verified");
        d.paid += amount;
        committed -= amount;
        cngn.safeTransfer(holder, amount);
        emit DividendPaid(id, holder, amount);
    }
}
