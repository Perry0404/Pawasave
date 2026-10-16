// SPDX-License-Identifier: UNLICENSED
// Copyright (c) 2026 CASEWINAI LIMITED (RC 9425438). All rights reserved. Proprietary and confidential.
pragma solidity ^0.8.20;

import "./IB20.sol";

/**
 * @title WholeShareRouter
 * @notice The token's TRANSFER_EXECUTOR_POLICY allows only this router and the redemption vault to
 *         initiate transfers, so a holder cannot call `transfer` directly. Every holder-to-holder move
 *         goes through here, and the router only ever moves whole shares. Together with whole-share
 *         minting and redemption, no fraction of a share can be created, sent or redeemed.
 *
 *  - The router only moves the caller's own tokens: `from` is always `msg.sender`, so an approval to
 *    the router cannot be used by anyone else.
 *  - Sender and receiver eligibility (KYC) are enforced by the token's transfer policies.
 *  - `transferWithPermit` lets the app authorise and send in one step, with no separate approval.
 */
contract WholeShareRouter {
    IB20AssetLite public immutable token;
    uint256 public immutable unit;

    event WholeShareTransfer(address indexed from, address indexed to, uint256 shares, bytes32 memo);

    constructor(address token_) {
        require(token_ != address(0), "zero address");
        token = IB20AssetLite(token_);
        unit = 10 ** uint256(IB20AssetLite(token_).decimals());
    }

    function transfer(address to, uint256 shares, bytes32 memo) public {
        require(shares > 0, "zero shares");
        token.transferFromWithMemo(msg.sender, to, shares * unit, memo);
        emit WholeShareTransfer(msg.sender, to, shares, memo);
    }

    /// @notice Approve and send in one transaction. A permit that was already used (front-run) is
    ///         ignored as long as the allowance is in place.
    function transferWithPermit(address to, uint256 shares, bytes32 memo, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try token.permit(msg.sender, address(this), shares * unit, deadline, v, r, s) {} catch {}
        transfer(to, shares, memo);
    }
}
