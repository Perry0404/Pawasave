// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../IStrategy.sol";
import "../lending/PawasaveLend.sol";

/**
 * @title PawasaveLendStrategy
 * @notice IStrategy adapter that deploys the vault's cNGN into PawasaveLend's
 * supply side and holds the resulting psNGN shares. Fixes the vault↔lend
 * interface mismatch flagged in the audit (the vault speaks IStrategy; the lend
 * pool speaks supply()/withdraw(shares)).
 *
 * Yield accrues as psNGN appreciates against cNGN; harvest() realises the value
 * above tracked principal and forwards it to the vault.
 */
contract PawasaveLendStrategy is IStrategy, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    IERC20 public immutable cngn;
    PawasaveLend public immutable lend;
    address public vault;
    uint256 public principal; // cNGN principal supplied (excludes accrued yield)

    event VaultSet(address vault);
    event Harvested(uint256 yield);

    constructor(address _cngn, address _lend) Ownable() {
        require(_cngn != address(0) && _lend != address(0), "Zero address");
        cngn = IERC20(_cngn);
        lend = PawasaveLend(_lend);
    }

    /// @notice One-time binding to the vault that may push/pull funds.
    function setVault(address _vault) external onlyOwner {
        require(vault == address(0), "Vault already set");
        require(_vault != address(0), "Zero address");
        vault = _vault;
        emit VaultSet(_vault);
    }

    modifier onlyVault() {
        require(msg.sender == vault, "Only vault");
        _;
    }

    function asset() external view returns (address) {
        return address(cngn);
    }

    function deposit(uint256 assets) external onlyVault {
        require(assets > 0, "Zero");
        cngn.safeTransferFrom(msg.sender, address(this), assets);
        cngn.forceApprove(address(lend), assets);
        lend.supply(assets);
        principal += assets;
    }

    function withdraw(uint256 assets) external onlyVault returns (uint256 withdrawn) {
        if (assets == 0) return 0;
        uint256 shares = _sharesForAssets(assets);
        uint256 held = lend.balanceOf(address(this));
        if (shares > held) shares = held;
        withdrawn = lend.withdraw(shares); // lend sends cNGN to this contract
        principal = principal > withdrawn ? principal - withdrawn : 0;
        cngn.safeTransfer(msg.sender, withdrawn);
    }

    function harvest() external onlyVault returns (uint256 harvested) {
        uint256 value = _currentValue();
        if (value <= principal) return 0;
        uint256 yield = value - principal;
        uint256 shares = _sharesForAssets(yield);
        uint256 held = lend.balanceOf(address(this));
        if (shares > held) shares = held;
        if (shares == 0) return 0;
        harvested = lend.withdraw(shares);
        cngn.safeTransfer(msg.sender, harvested);
        emit Harvested(harvested);
    }

    function totalAssets() external view returns (uint256) {
        return _currentValue();
    }

    function _currentValue() internal view returns (uint256) {
        uint256 shares = lend.balanceOf(address(this));
        if (shares == 0) return 0;
        return (shares * lend.exchangeRate()) / WAD;
    }

    function _sharesForAssets(uint256 assets) internal view returns (uint256) {
        uint256 rate = lend.exchangeRate();
        return (assets * WAD + rate - 1) / rate; // round up so we redeem ≥ assets
    }
}