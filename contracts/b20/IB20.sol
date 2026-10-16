// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Subset of the B20 Asset token and Policy Registry interfaces used by PawaSave's B20 modules.
 * Signatures follow base/base-std (MIT, Copyright (c) 2026 Base):
 *   src/interfaces/IB20.sol, IB20Asset.sol, IPolicyRegistry.sol, src/lib/B20Constants.sol.
 * On Base and Base Sepolia the factory and registry are precompiles:
 *   B20_FACTORY      0xB20f000000000000000000000000000000000000
 *   POLICY_REGISTRY  0x8453000000000000000000000000000000000002
 */
interface IB20AssetLite {
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function multiplier() external view returns (uint256);

    function transferWithMemo(address to, uint256 amount, bytes32 memo) external returns (bool);
    function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo) external returns (bool);
    function mintWithMemo(address to, uint256 amount, bytes32 memo) external;
    function burnWithMemo(uint256 amount, bytes32 memo) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

interface IPolicyRegistryLite {
    function isAuthorized(uint64 policyId, address account) external view returns (bool);
}

library B20Roles {
    uint256 internal constant WAD = 1e18;
    bytes32 internal constant MINT_ROLE = keccak256("MINT_ROLE");
    bytes32 internal constant BURN_ROLE = keccak256("BURN_ROLE");
    bytes32 internal constant SEIZE_ROLE = keccak256("SEIZE_ROLE");
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant UNPAUSE_ROLE = keccak256("UNPAUSE_ROLE");
    bytes32 internal constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 internal constant TRANSFER_SENDER_POLICY = keccak256("TRANSFER_SENDER_POLICY");
    bytes32 internal constant TRANSFER_RECEIVER_POLICY = keccak256("TRANSFER_RECEIVER_POLICY");
    bytes32 internal constant TRANSFER_EXECUTOR_POLICY = keccak256("TRANSFER_EXECUTOR_POLICY");
    bytes32 internal constant MINT_RECEIVER_POLICY = keccak256("MINT_RECEIVER_POLICY");
}
