// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStrategy
 * @notice Minimal interface every PawasaveAutoVault strategy must implement.
 *
 * The vault pushes/pulls the underlying `asset()` and never reads a strategy's
 * raw token balance (which is donation-manipulable, FIND-SC-03). Strategies are
 * trusted, whitelisted, and changed only through the vault's timelock
 * (FIND-SC-05/07).
 */
interface IStrategy {
    /// @notice The underlying asset this strategy accepts (must match the vault's asset).
    function asset() external view returns (address);

    /// @notice Pull `assets` from the caller (the vault) and deploy them.
    function deposit(uint256 assets) external;

    /// @notice Return up to `assets` of underlying to the caller (the vault).
    /// @return withdrawn The amount actually returned.
    function withdraw(uint256 assets) external returns (uint256 withdrawn);

    /// @notice Realise yield and transfer it to the caller (the vault).
    /// @return harvested The amount of yield transferred.
    function harvest() external returns (uint256 harvested);

    /// @notice Current value (in underlying) the strategy holds for the vault.
    function totalAssets() external view returns (uint256);
}