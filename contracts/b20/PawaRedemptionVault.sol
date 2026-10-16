// SPDX-License-Identifier: UNLICENSED
// Copyright (c) 2026 CASEWINAI LIMITED (RC 9425438). All rights reserved. Proprietary and confidential.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./IB20.sol";

/**
 * @title PawaRedemptionVault
 * @notice Lock, then burn. A holder redeems whole shares for cash (the broker sells) or for delivery to
 *         their own CSCS account. The tokens move into this vault when redemption starts, are burned
 *         only once the sale or delivery has settled, and are returned in full if it fails, so the
 *         holder is never without both the token and the proceeds.
 *
 *  Token configuration: this vault holds BURN_ROLE, is on the TRANSFER_EXECUTOR_POLICY allowlist (it
 *  pulls the holder's tokens) and on the verified sender/receiver allowlist (it holds and returns them).
 *  Holder eligibility is enforced by the token's transfer policies.
 */
contract PawaRedemptionVault is AccessControl {
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE"); // completes or cancels redemptions

    enum Kind { Cash, Delivery }
    enum Status { Pending, Completed, Cancelled }

    struct Redemption {
        address holder;
        uint256 shares;
        Kind kind;
        Status status;
        uint64 createdAt;
        uint64 closedAt;
    }

    IB20AssetLite public immutable token;
    uint256 public immutable unit;

    Redemption[] public redemptions;
    uint256 public lockedShares;

    event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 shares, Kind kind);
    event RedemptionCompleted(uint256 indexed id, bytes32 settlementRef);
    event RedemptionCancelled(uint256 indexed id, string reason);

    constructor(address token_, address admin) {
        require(token_ != address(0) && admin != address(0), "zero address");
        token = IB20AssetLite(token_);
        unit = 10 ** uint256(IB20AssetLite(token_).decimals());
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function redemptionCount() external view returns (uint256) {
        return redemptions.length;
    }

    function requestRedemption(uint256 shares, Kind kind) public returns (uint256 id) {
        require(shares > 0, "zero shares");
        id = redemptions.length;
        token.transferFromWithMemo(msg.sender, address(this), shares * unit, bytes32(id));
        lockedShares += shares;
        redemptions.push(Redemption(msg.sender, shares, kind, Status.Pending, uint64(block.timestamp), 0));
        emit RedemptionRequested(id, msg.sender, shares, kind);
    }

    function requestRedemptionWithPermit(uint256 shares, Kind kind, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        returns (uint256)
    {
        try token.permit(msg.sender, address(this), shares * unit, deadline, v, r, s) {} catch {}
        return requestRedemption(shares, kind);
    }

    /// @notice The sale has settled and the proceeds were paid, or the share was delivered: burn.
    function completeRedemption(uint256 id, bytes32 settlementRef) external onlyRole(SETTLER_ROLE) {
        Redemption storage r = redemptions[id];
        require(r.status == Status.Pending, "not pending");
        r.status = Status.Completed;
        r.closedAt = uint64(block.timestamp);
        lockedShares -= r.shares;
        token.burnWithMemo(r.shares * unit, settlementRef);
        emit RedemptionCompleted(id, settlementRef);
    }

    /// @notice Settlement failed: the holder gets the tokens back in full.
    function cancelRedemption(uint256 id, string calldata reason) external onlyRole(SETTLER_ROLE) {
        Redemption storage r = redemptions[id];
        require(r.status == Status.Pending, "not pending");
        r.status = Status.Cancelled;
        r.closedAt = uint64(block.timestamp);
        lockedShares -= r.shares;
        token.transferWithMemo(r.holder, r.shares * unit, bytes32(id));
        emit RedemptionCancelled(id, reason);
    }
}
