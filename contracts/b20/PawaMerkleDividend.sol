// SPDX-License-Identifier: UNLICENSED
// Copyright (c) 2026 CASEWINAI LIMITED (RC 9425438). All rights reserved. Proprietary and confidential.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./IB20.sol";

/**
 * @title PawaMerkleDividend
 * @notice Pays a cash dividend on a B20 equity token in cNGN, pro-rata to holders as at a record block.
 *
 * B20 has no on-chain snapshot, so the record date works like this:
 *  - The issuer computes every holder's entitlement from balances at `recordBlock` (public chain
 *    state anyone can recompute), with tokens locked in the redemption vault attributed to the holder
 *    who locked them, and publishes the list as a Merkle root together with the total.
 *  - The TRUSTEE approves the dividend after checking the list; approval fails unless the contract
 *    already holds the full amount, and money held for one dividend cannot fund another.
 *  - Anyone can then trigger payment to a listed holder with a proof; the money can only go to that
 *    holder, once, and only while the holder is on the verified register. Payments can never exceed
 *    the declared total.
 *  - Unclaimed amounts can be recovered by the trustee after twelve months, to hold for holders.
 */
contract PawaMerkleDividend is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant TRUSTEE_ROLE = keccak256("TRUSTEE_ROLE");
    uint256 public constant UNCLAIMED_PERIOD = 365 days;

    struct Dividend {
        bytes32 merkleRoot;
        uint256 total;
        uint256 paid;
        uint64 recordBlock;
        uint64 declaredAt;
        bool approved;
        bool closed;
        string paymentRef;
    }

    address public immutable token; // the equity token the dividend is paid on (for reference)
    IERC20 public immutable cngn;
    IPolicyRegistryLite public immutable registry;
    uint64 public verifiedPolicyId;

    Dividend[] public dividends;
    uint256 public committed;
    mapping(uint256 => mapping(address => bool)) public paidTo;

    event DividendDeclared(uint256 indexed id, bytes32 merkleRoot, uint256 total, uint64 recordBlock, string paymentRef);
    event DividendApproved(uint256 indexed id, address indexed trustee);
    event DividendPaid(uint256 indexed id, address indexed holder, uint256 amount);
    event DividendClosed(uint256 indexed id, address indexed to, uint256 unclaimed);
    event VerifiedPolicyChanged(uint64 policyId);

    constructor(address token_, address cngn_, address registry_, uint64 verifiedPolicyId_, address admin) {
        require(token_ != address(0) && cngn_ != address(0) && registry_ != address(0) && admin != address(0), "zero address");
        token = token_;
        cngn = IERC20(cngn_);
        registry = IPolicyRegistryLite(registry_);
        verifiedPolicyId = verifiedPolicyId_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit VerifiedPolicyChanged(verifiedPolicyId_);
    }

    function dividendCount() external view returns (uint256) {
        return dividends.length;
    }

    /// @notice The leaf for one holder's entitlement in a dividend's Merkle tree.
    function leaf(address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function setVerifiedPolicy(uint64 policyId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        verifiedPolicyId = policyId;
        emit VerifiedPolicyChanged(policyId);
    }

    function declare(bytes32 merkleRoot, uint256 total, uint64 recordBlock, string calldata paymentRef)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 id)
    {
        require(merkleRoot != bytes32(0) && total > 0, "empty dividend");
        require(recordBlock < block.number, "record block must be in the past");
        id = dividends.length;
        dividends.push(Dividend(merkleRoot, total, 0, recordBlock, uint64(block.timestamp), false, false, paymentRef));
        emit DividendDeclared(id, merkleRoot, total, recordBlock, paymentRef);
    }

    function approve(uint256 id) external onlyRole(TRUSTEE_ROLE) {
        Dividend storage d = dividends[id];
        require(!d.approved, "already approved");
        require(cngn.balanceOf(address(this)) >= committed + d.total, "not funded");
        d.approved = true;
        committed += d.total;
        emit DividendApproved(id, msg.sender);
    }

    function pay(uint256 id, address account, uint256 amount, bytes32[] calldata proof) public {
        Dividend storage d = dividends[id];
        require(d.approved && !d.closed, "not payable");
        require(!paidTo[id][account], "already paid");
        require(amount > 0, "nothing due");
        require(MerkleProof.verifyCalldata(proof, d.merkleRoot, leaf(account, amount)), "not in record");
        require(registry.isAuthorized(verifiedPolicyId, account), "holder not verified");
        require(d.paid + amount <= d.total, "exceeds declared total");
        paidTo[id][account] = true;
        d.paid += amount;
        committed -= amount;
        cngn.safeTransfer(account, amount);
        emit DividendPaid(id, account, amount);
    }

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
}
