// SPDX-License-Identifier: UNLICENSED
// Copyright (c) 2026 CASEWINAI LIMITED (RC 9425438). All rights reserved. Proprietary and confidential.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./IB20.sol";

/**
 * @title PawaMintGate
 * @notice The only holder of MINT_ROLE on a B20 Asset token representing one NGX-listed share.
 *         Tokens are created only against an EIP-712 attestation signed by the CUSTODIAN's key for a
 *         settled CSCS credit to the pool account (a trade or a transfer in), in whole shares.
 *
 *  - Each settlement reference mints once; per-transaction and daily caps.
 *  - The custodian's CSCS pool statement is posted here. A mint is refused unless the last statement
 *    covers every share the token supply will represent after the mint, so minting can never run
 *    ahead of the pool, including after a bonus or split raises the token's multiplier.
 *  - A statement below what the supply requires halts minting until a covering statement is posted.
 *  - Recipient eligibility (KYC) is enforced by the token itself through MINT_RECEIVER_POLICY.
 *  - The settlement reference is written to the token as the mint memo, for the audit trail.
 */
contract PawaMintGate is AccessControl, EIP712 {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");         // PawaSave minting service
    bytes32 public constant RECONCILER_ROLE = keccak256("RECONCILER_ROLE"); // posts custodian statements

    bytes32 private constant MINT_TYPEHASH =
        keccak256("MintAttestation(address to,uint256 shares,bytes32 settlementRef,uint256 deadline)");

    IB20AssetLite public immutable token;
    uint256 public immutable unit; // raw token units per whole share (10 ** decimals)

    address public custodianSigner;
    mapping(bytes32 => bool) public settlementUsed;

    uint256 public maxSharesPerMint;
    uint256 public dailyShareCap;
    uint256 public sharesMintedToday;
    uint256 public mintDay;

    bool public mintHalted;
    string public haltReason;

    uint256 public lastReserveShares;
    bytes32 public lastStatementHash;
    uint64 public lastReserveAt;

    event CustodianSignerChanged(address indexed signer);
    event MintedAgainstSettlement(address indexed to, uint256 shares, bytes32 indexed settlementRef);
    event ReserveReported(uint256 reserveShares, uint256 sharesRequired, bytes32 statementHash, bool shortfall);
    event MintHaltChanged(bool halted, string reason);
    event MintCapsChanged(uint256 maxSharesPerMint, uint256 dailyShareCap);

    constructor(address token_, address admin, address custodianSigner_, uint256 maxSharesPerMint_, uint256 dailyShareCap_)
        EIP712("PawaMintGate", "1")
    {
        require(token_ != address(0) && admin != address(0) && custodianSigner_ != address(0), "zero address");
        token = IB20AssetLite(token_);
        unit = 10 ** uint256(IB20AssetLite(token_).decimals());
        custodianSigner = custodianSigner_;
        maxSharesPerMint = maxSharesPerMint_;
        dailyShareCap = dailyShareCap_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit CustodianSignerChanged(custodianSigner_);
        emit MintCapsChanged(maxSharesPerMint_, dailyShareCap_);
    }

    /// @notice Shares the pool must hold for `rawSupply` token units at the token's current multiplier.
    function sharesFor(uint256 rawSupply) public view returns (uint256) {
        uint256 scaled = (rawSupply * token.multiplier()) / B20Roles.WAD;
        return (scaled + unit - 1) / unit;
    }

    /// @notice Shares the pool must hold for the tokens in issue now.
    function sharesRequired() public view returns (uint256) {
        return sharesFor(token.totalSupply());
    }

    function mintDigest(address to, uint256 shares, bytes32 settlementRef, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, to, shares, settlementRef, deadline)));
    }

    function mintWithAttestation(
        address to,
        uint256 shares,
        bytes32 settlementRef,
        uint256 deadline,
        bytes calldata custodianSignature
    ) external onlyRole(MINTER_ROLE) {
        require(!mintHalted, "minting halted");
        require(shares > 0, "zero shares");
        require(block.timestamp <= deadline, "attestation expired");
        require(!settlementUsed[settlementRef], "settlement already minted");
        require(shares <= maxSharesPerMint, "over per-mint cap");

        uint256 today = block.timestamp / 1 days;
        if (today != mintDay) {
            mintDay = today;
            sharesMintedToday = 0;
        }
        require(sharesMintedToday + shares <= dailyShareCap, "over daily cap");

        address signer = ECDSA.recover(mintDigest(to, shares, settlementRef, deadline), custodianSignature);
        require(signer == custodianSigner, "not attested by custodian");

        uint256 amount = shares * unit;
        require(lastReserveShares >= sharesFor(token.totalSupply() + amount), "reserve does not cover");

        settlementUsed[settlementRef] = true;
        sharesMintedToday += shares;
        token.mintWithMemo(to, amount, settlementRef);
        emit MintedAgainstSettlement(to, shares, settlementRef);
    }

    /// @notice Post the custodian's CSCS pool balance (whole shares). A shortfall halts minting.
    function reportReserve(uint256 reserveShares, bytes32 statementHash) external onlyRole(RECONCILER_ROLE) {
        lastReserveShares = reserveShares;
        lastStatementHash = statementHash;
        lastReserveAt = uint64(block.timestamp);
        uint256 required = sharesRequired();
        bool shortfall = reserveShares < required;
        if (shortfall && !mintHalted) {
            mintHalted = true;
            haltReason = "reserve shortfall";
            emit MintHaltChanged(true, haltReason);
        }
        emit ReserveReported(reserveShares, required, statementHash, shortfall);
    }

    /// @notice Anyone can halt minting if the last statement no longer covers the supply (e.g. after
    ///         a multiplier change on the token). Mints are refused in that state regardless.
    function checkReserve() external {
        if (!mintHalted && lastReserveAt != 0 && lastReserveShares < sharesRequired()) {
            mintHalted = true;
            haltReason = "reserve shortfall";
            emit MintHaltChanged(true, haltReason);
        }
    }

    function setMintHalt(bool halted, string calldata reason) external onlyRole(RECONCILER_ROLE) {
        if (!halted) require(lastReserveShares >= sharesRequired(), "reserve still short");
        mintHalted = halted;
        haltReason = reason;
        emit MintHaltChanged(halted, reason);
    }

    function setCustodianSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(signer != address(0), "zero address");
        custodianSigner = signer;
        emit CustodianSignerChanged(signer);
    }

    function setMintCaps(uint256 maxSharesPerMint_, uint256 dailyShareCap_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxSharesPerMint = maxSharesPerMint_;
        dailyShareCap = dailyShareCap_;
        emit MintCapsChanged(maxSharesPerMint_, dailyShareCap_);
    }
}
