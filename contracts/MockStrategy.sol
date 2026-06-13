// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IStrategy.sol";

/**
 * @title MockStrategy
 * @notice Test-only IStrategy implementation for PawasaveAutoVault tests.
 */
contract MockStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    uint256 public pendingYield;

    constructor(address _asset) {
        token = IERC20(_asset);
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function deposit(uint256 assets) external {
        token.safeTransferFrom(msg.sender, address(this), assets);
    }

    function withdraw(uint256 assets) external returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        uint256 amt = assets > bal ? bal : assets;
        token.safeTransfer(msg.sender, amt);
        return amt;
    }

    function harvest() external returns (uint256) {
        uint256 y = pendingYield;
        pendingYield = 0;
        if (y > 0) token.safeTransfer(msg.sender, y);
        return y;
    }

    function totalAssets() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @dev test helper — fund pending yield from caller
    function addYield(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        pendingYield += amount;
    }
}