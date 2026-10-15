// SPDX-License-Identifier: UNLICENSED
// Copyright (c) 2026 CASEWINAI LIMITED (RC 9425438). All rights reserved. Proprietary and confidential.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Snapshot.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PawaEquityToken
 * @notice One token = one ordinary share of a single NGX-listed company, held for token holders
 *         by a regulated custodian in a dedicated CSCS pool account (PSS-1 / SEC response §5–7).
 *
 * Controls, in the order a regulator asks about them:
 *  - BACKING: tokens are minted only against an EIP-712 attestation signed by the CUSTODIAN's key,
 *    binding the settled trade reference, recipient and quantity. Each trade reference mints once.
 *    The minting service alone cannot mint: a compromised PawaSave key without the custodian's
 *    signature produces nothing.
 *  - RECONCILIATION: the reconciler posts the custodian's CSCS pool balance on-chain each business
 *    day. If the pool is ever below token supply, minting halts automatically until resolved.
 *  - LIMITS: per-transaction and per-day mint caps.
 *  - TRANSFERS: only between wallets on the issuer's verified (KYC'd) register.
 *  - REDEMPTION: lock first, burn only after settlement. A holder's tokens move into this contract
 *    when redemption starts. They are burned when the cash or share delivery completes, or returned
 *    in full if it fails, so the holder never loses both the token and the proceeds.
 *  - CORPORATE ACTIONS: a published multiplier (shares per token, 18 dp) records splits and bonus
 *    issues without moving balances.
 *  - DIVIDENDS: a record-date snapshot fixes every holder's balance on-chain. The dividend
 *    distributor (PawaDividendDistributor) pays cNGN pro-rata against that snapshot.
 *  - ADMIN: roles are separated. In production DEFAULT_ADMIN_ROLE is a 2-of-3 multisig (issuer,
 *    trustee, CaseWinAI) behind a timelock; this contract is not upgradeable.
 */
contract PawaEquityToken is ERC20Snapshot, AccessControl, Pausable, EIP712 {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");   // verified-wallet register
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");         // minting service
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");         // completes / cancels redemptions
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RECONCILER_ROLE = keccak256("RECONCILER_ROLE"); // posts custodian statements
    bytes32 public constant SNAPSHOT_ROLE = keccak256("SNAPSHOT_ROLE");     // takes record-date snapshots

    bytes32 private constant MINT_TYPEHASH =
        keccak256("MintAttestation(address to,uint256 amount,bytes32 tradeRef,uint256 deadline)");

    enum RedemptionKind { Cash, Delivery }
    enum RedemptionStatus { Pending, Completed, Cancelled }

    struct Redemption {
        address holder;
        uint256 amount;
        RedemptionKind kind;
        RedemptionStatus status;
        uint64 createdAt;
        uint64 closedAt;                // when it was completed or cancelled
    }

    string public ngxSymbol;            // e.g. "MTNN"
    string public isin;                 // e.g. "NGMTNN000002"
    address public custodianSigner;     // the custodian's attestation key

    mapping(address => bool) public verified;
    mapping(bytes32 => bool) public tradeRefUsed;

    uint256 public maxMintPerTx;
    uint256 public dailyMintCap;
    uint256 public mintedToday;
    uint256 public mintDay;

    bool public mintHalted;
    string public haltReason;

    uint256 public multiplier = 1e18;   // shares represented by one token, 18 dp

    uint256 public lastReserveShares;   // custodian-reported CSCS pool balance
    bytes32 public lastStatementHash;   // hash of the custodian statement it came from
    uint64 public lastReserveAt;

    bool private _forcing;              // set only inside forcedTransfer
    bool private _redeeming;            // set only while this contract moves redemption tokens

    mapping(uint256 => uint64) public snapshotAt; // record-date snapshot id => time taken

    Redemption[] public redemptions;
    uint256 public lockedSupply;        // tokens held in pending redemptions

    event Verified(address indexed account, bool status);
    event CustodianSignerChanged(address indexed signer);
    event MintedAgainstSettlement(address indexed to, uint256 amount, bytes32 indexed tradeRef);
    event MintHaltChanged(bool halted, string reason);
    event ReserveReported(uint256 reserveShares, uint256 supply, bytes32 statementHash, bool shortfall);
    event RedemptionRequested(uint256 indexed id, address indexed holder, uint256 amount, RedemptionKind kind);
    event RedemptionCompleted(uint256 indexed id, bytes32 settlementRef);
    event RedemptionCancelled(uint256 indexed id, string reason);
    event MultiplierChanged(uint256 multiplier, string corporateAction);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, string legalBasis);
    event MintCapsChanged(uint256 maxPerTx, uint256 dailyCap);
    event RecordDateSnapshot(uint256 indexed id, uint256 supply, string reason);

    constructor(
        string memory name_,
        string memory symbol_,
        string memory ngxSymbol_,
        string memory isin_,
        address admin,
        address custodianSigner_,
        uint256 maxMintPerTx_,
        uint256 dailyMintCap_
    ) ERC20(name_, symbol_) EIP712("PawaEquityToken", "1") {
        require(admin != address(0) && custodianSigner_ != address(0), "zero address");
        ngxSymbol = ngxSymbol_;
        isin = isin_;
        custodianSigner = custodianSigner_;
        maxMintPerTx = maxMintPerTx_;
        dailyMintCap = dailyMintCap_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit CustodianSignerChanged(custodianSigner_);
        emit MintCapsChanged(maxMintPerTx_, dailyMintCap_);
    }

    /// @dev One token is one whole share: no fractions in the pilot.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // ── register ────────────────────────────────────────────────────────────

    function setVerified(address account, bool status) external onlyRole(REGISTRAR_ROLE) {
        verified[account] = status;
        emit Verified(account, status);
    }

    function setVerifiedBatch(address[] calldata accounts, bool status) external onlyRole(REGISTRAR_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            verified[accounts[i]] = status;
            emit Verified(accounts[i], status);
        }
    }

    // ── minting against settled shares ───────────────────────────────────────

    function mintDigest(address to, uint256 amount, bytes32 tradeRef, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MINT_TYPEHASH, to, amount, tradeRef, deadline)));
    }

    function mintWithAttestation(
        address to,
        uint256 amount,
        bytes32 tradeRef,
        uint256 deadline,
        bytes calldata custodianSignature
    ) external onlyRole(MINTER_ROLE) whenNotPaused {
        require(!mintHalted, "minting halted");
        require(amount > 0, "zero amount");
        require(verified[to], "recipient not verified");
        require(block.timestamp <= deadline, "attestation expired");
        require(!tradeRefUsed[tradeRef], "trade already minted");
        require(amount <= maxMintPerTx, "over per-tx cap");

        uint256 today = block.timestamp / 1 days;
        if (today != mintDay) {
            mintDay = today;
            mintedToday = 0;
        }
        require(mintedToday + amount <= dailyMintCap, "over daily cap");

        address signer = ECDSA.recover(mintDigest(to, amount, tradeRef, deadline), custodianSignature);
        require(signer == custodianSigner, "not attested by custodian");

        tradeRefUsed[tradeRef] = true;
        mintedToday += amount;
        _mint(to, amount);
        emit MintedAgainstSettlement(to, amount, tradeRef);
    }

    // ── reconciliation ───────────────────────────────────────────────────────

    /// @notice Shares the pool must hold for the tokens in issue: supply x multiplier, rounded up.
    ///         After a 1-for-1 bonus, 100 tokens need 200 shares in the pool.
    function sharesRequired() public view returns (uint256) {
        return (totalSupply() * multiplier + 1e18 - 1) / 1e18;
    }

    /// @notice Post the custodian's CSCS pool balance. A shortfall halts minting automatically.
    function reportReserve(uint256 reserveShares, bytes32 statementHash) external onlyRole(RECONCILER_ROLE) {
        lastReserveShares = reserveShares;
        lastStatementHash = statementHash;
        lastReserveAt = uint64(block.timestamp);
        bool shortfall = reserveShares < sharesRequired();
        if (shortfall && !mintHalted) {
            mintHalted = true;
            haltReason = "reserve shortfall";
            emit MintHaltChanged(true, haltReason);
        }
        emit ReserveReported(reserveShares, totalSupply(), statementHash, shortfall);
    }

    /// @notice Reconciler can halt for any exception, and clears a halt once it is resolved.
    function setMintHalt(bool halted, string calldata reason) external onlyRole(RECONCILER_ROLE) {
        if (!halted) require(lastReserveShares >= sharesRequired(), "reserve still short");
        mintHalted = halted;
        haltReason = reason;
        emit MintHaltChanged(halted, reason);
    }

    // ── redemption: lock, then burn ──────────────────────────────────────────

    function requestRedemption(uint256 amount, RedemptionKind kind) external whenNotPaused returns (uint256 id) {
        require(verified[msg.sender], "holder not verified");
        require(amount > 0, "zero amount");
        _redeeming = true;
        _transfer(msg.sender, address(this), amount);
        _redeeming = false;
        lockedSupply += amount;
        id = redemptions.length;
        redemptions.push(Redemption(msg.sender, amount, kind, RedemptionStatus.Pending, uint64(block.timestamp), 0));
        emit RedemptionRequested(id, msg.sender, amount, kind);
    }

    /// @notice Called once the sale has settled and proceeds were paid, or the share was delivered.
    function completeRedemption(uint256 id, bytes32 settlementRef) external onlyRole(BURNER_ROLE) {
        Redemption storage r = redemptions[id];
        require(r.status == RedemptionStatus.Pending, "not pending");
        r.status = RedemptionStatus.Completed;
        r.closedAt = uint64(block.timestamp);
        lockedSupply -= r.amount;
        _burn(address(this), r.amount);
        emit RedemptionCompleted(id, settlementRef);
    }

    /// @notice Failed settlement: the holder gets the tokens back in full.
    function cancelRedemption(uint256 id, string calldata reason) external onlyRole(BURNER_ROLE) {
        Redemption storage r = redemptions[id];
        require(r.status == RedemptionStatus.Pending, "not pending");
        r.status = RedemptionStatus.Cancelled;
        r.closedAt = uint64(block.timestamp);
        lockedSupply -= r.amount;
        _redeeming = true;
        _transfer(address(this), r.holder, r.amount);
        _redeeming = false;
        emit RedemptionCancelled(id, reason);
    }

    function redemptionCount() external view returns (uint256) {
        return redemptions.length;
    }

    // ── corporate actions and admin ──────────────────────────────────────────

    /// @notice Fix every holder's balance as at now (a dividend or voting record date).
    function snapshot(string calldata reason) external onlyRole(SNAPSHOT_ROLE) returns (uint256 id) {
        id = _snapshot();
        snapshotAt[id] = uint64(block.timestamp);
        emit RecordDateSnapshot(id, totalSupply(), reason);
    }

    function setMultiplier(uint256 newMultiplier, string calldata corporateAction) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newMultiplier > 0, "zero multiplier");
        multiplier = newMultiplier;
        emit MultiplierChanged(newMultiplier, corporateAction);
        // A bonus or split raises sharesRequired the instant it is recorded, so this is the one
        // moment the contract creates its own shortfall. Halt here rather than waiting for the next
        // daily reserve report, or minting stays open against a pool the contract already knows is
        // short — a 1-for-1 bonus on 100 tokens needs 200 shares and the pool still holds 100.
        if (lastReserveAt != 0 && lastReserveShares < sharesRequired() && !mintHalted) {
            mintHalted = true;
            haltReason = "reserve shortfall after corporate action";
            emit MintHaltChanged(true, haltReason);
        }
    }

    function setCustodianSigner(address signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(signer != address(0), "zero address");
        custodianSigner = signer;
        emit CustodianSignerChanged(signer);
    }

    function setMintCaps(uint256 maxPerTx, uint256 dailyCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxMintPerTx = maxPerTx;
        dailyMintCap = dailyCap;
        emit MintCapsChanged(maxPerTx, dailyCap);
    }

    /// @notice Court order or regulatory direction only (e.g. lost keys, estates, sanctions).
    function forcedTransfer(address from, address to, uint256 amount, string calldata legalBasis)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(verified[to], "recipient not verified");
        require(bytes(legalBasis).length > 0, "legal basis required");
        _forcing = true;
        _transfer(from, to, amount);
        _forcing = false;
        emit ForcedTransfer(from, to, amount, legalBasis);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ── transfer rule ────────────────────────────────────────────────────────

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override(ERC20Snapshot) {
        super._beforeTokenTransfer(from, to, amount);
        // Mint and burn are gated by their own functions. Admin forced transfers bypass pause
        // (court orders).
        if (from == address(0) || to == address(0)) return;
        if (_forcing) return;
        // Moves into or out of this contract are redemption locks and releases, and may only happen
        // from inside requestRedemption / cancelRedemption.
        //
        // This was an unconditional exemption. A holder could therefore `transfer` straight to the
        // token address: the tokens left their wallet with no Redemption record, so nothing could
        // ever complete or cancel them, lockedSupply did not count them, and they stayed in
        // totalSupply so the custodian had to keep holding shares against them for good. Worse, at a
        // record date they sat in balanceOfAt(address(this)), where entitlement() returns zero and
        // no payLocked can reach them — so they quietly made a slice of every future dividend
        // unclaimable by anybody. Twenty tokens in a hundred cost the other holders nothing but put
        // 20% of the payment beyond reach until the trustee's twelve-month sweep.
        //
        // Recovery of anything already stranded is forcedTransfer, which exists for exactly this
        // kind of court-directed move.
        if (from == address(this) || to == address(this)) {
            require(_redeeming, "use requestRedemption");
            return;
        }
        require(!paused(), "paused");
        require(verified[from] && verified[to], "transfer between unverified wallets");
    }
}
