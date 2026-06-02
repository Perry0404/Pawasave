// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockStrategy
 * @notice Test-only mock strategy for PawasaveAutoVault testing
 */
contract MockStrategy {
    using SafeERC20 for IERC20;

    IERC20 public asset;
    uint256 public pendingYield;

    constructor(address _asset) {
        asset = IERC20(_asset);
    }

    function deposit(uint256 assets, address) external returns (uint256) {
        asset.safeTransferFrom(msg.sender, address(this), assets);
        return assets;
    }

    function addYield(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        pendingYield += amount;
    }

    function harvest() external {
        uint256 yieldToSend = pendingYield;
        pendingYield = 0;
        if (yieldToSend > 0) {
            asset.safeTransfer(msg.sender, yieldToSend);
        }
    }

    function withdraw(uint256 amount, address receiver, address) external returns (uint256) {
        asset.safeTransfer(receiver, amount);
        return amount;
    }

    function balanceOf(address) external view returns (uint256) {
        return asset.balanceOf(address(this));
    }
}
