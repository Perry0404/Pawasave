// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PriceOracle
 * @notice Price oracle for the PawaSave cNGN lending pool.
 *
 * Prices are expressed as: how many cNGN (6 decimals) per 1 unit of collateral.
 * e.g. if 1 USDC = 1,650 NGN, price = 1650 * 1e6 (in cNGN units).
 *
 * In production these prices are updated by an authorised keeper that reads
 * from a Chainlink NGN/USD feed + USDC/USD feed, or from the CBN official rate.
 * An on-chain Chainlink integration can replace the keeper once a NGN/USD
 * feed is live on Base.
 */
contract PriceOracle is Ownable {
    // collateral token address => price in cNGN per 1e18 of collateral
    mapping(address => uint256) public prices;

    // Maximum age of a price before it is considered stale
    mapping(address => uint256) public lastUpdated;
    uint256 public constant MAX_PRICE_AGE = 1 hours;

    // Circuit breaker (FIND-SC-20): reject keeper updates that move a price by
    // more than `maxDeviationBps` from the last value. Catches fat-finger / buggy
    // feeds (e.g. a 10x or 40% error) that would enable under-collateralised
    // borrowing or unfair liquidations. Owner can override for genuine large
    // moves via forceSetPrice(), and tune the threshold via setMaxDeviation().
    uint256 public maxDeviationBps = 2500; // 25%
    uint256 private constant BPS = 10_000;

    // Per-token sanity floor (V2-SC oracle price floor). On the FIRST price set
    // there is no previous value for the deviation breaker to check against, so a
    // glitchy feed returning a near-zero price could value collateral at ~0 and
    // enable bad-debt borrows. When set (>0), no update may push a token's price
    // below this floor — including forceSetPrice. Owner tunes it per token.
    mapping(address => uint256) public minPrice;

    event PriceUpdated(address indexed token, uint256 price, uint256 timestamp);
    event MaxDeviationUpdated(uint256 newMaxDeviationBps);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event MinPriceUpdated(address indexed token, uint256 minPrice);

    // Authorised price keeper (separate from owner for operational security)
    address public keeper;

    modifier onlyKeeperOrOwner() {
        require(msg.sender == keeper || msg.sender == owner(), "Not authorised");
        _;
    }

    constructor(address _keeper) Ownable() {
        keeper = _keeper;
    }

    /**
     * @notice Set price for a collateral token (keeper or owner).
     * @dev Enforces the deviation circuit breaker against the previous price.
     * @param token   Collateral token address
     * @param price   cNGN per 1e18 of collateral (scaled 1e6 for cNGN decimals)
     */
    function setPrice(address token, uint256 price) external onlyKeeperOrOwner {
        _setPrice(token, price, true);
    }

    /**
     * @notice Batch update prices (keeper or owner), with deviation checks.
     */
    function setPrices(
        address[] calldata tokens,
        uint256[] calldata _prices
    ) external onlyKeeperOrOwner {
        require(tokens.length == _prices.length, "Length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            _setPrice(tokens[i], _prices[i], true);
        }
    }

    /**
     * @notice Owner-only escape hatch to set a price WITHOUT the deviation check,
     * for genuine large moves (e.g. a cNGN de-peg or a sharp NGN devaluation).
     */
    function forceSetPrice(address token, uint256 price) external onlyOwner {
        _setPrice(token, price, false);
    }

    function _setPrice(address token, uint256 price, bool enforceDeviation) internal {
        require(token != address(0), "Zero address");
        require(price > 0, "Zero price");

        // Sanity floor (V2-SC). Applies on every path, including forceSetPrice,
        // so a near-zero glitch can never be written even on the first update.
        uint256 floor = minPrice[token];
        if (floor > 0) require(price >= floor, "Price below floor");

        uint256 prev = prices[token];
        if (enforceDeviation && prev > 0) {
            uint256 diff = price > prev ? price - prev : prev - price;
            require((diff * BPS) / prev <= maxDeviationBps, "Price deviation too large");
        }

        prices[token] = price;
        lastUpdated[token] = block.timestamp;
        emit PriceUpdated(token, price, block.timestamp);
    }

    /// @notice Max single-update price deviation. Capped at 50% (V2-SC-09) so the
    ///         circuit breaker can never be effectively disabled; genuine larger
    ///         moves must go through forceSetPrice().
    uint256 public constant MAX_DEVIATION_CEILING_BPS = 5000; // 50%

    function setMaxDeviation(uint256 newMaxDeviationBps) external onlyOwner {
        require(newMaxDeviationBps > 0 && newMaxDeviationBps <= MAX_DEVIATION_CEILING_BPS, "Max 50%");
        maxDeviationBps = newMaxDeviationBps;
        emit MaxDeviationUpdated(newMaxDeviationBps);
    }

    /**
     * @notice Get price, reverting if stale.
     * @param token Collateral token address
     * @return price cNGN per 1e18 collateral units
     */
    function getPrice(address token) external view returns (uint256 price) {
        price = prices[token];
        require(price > 0, "Price not set");
        require(block.timestamp - lastUpdated[token] <= MAX_PRICE_AGE, "Price stale");
    }

    /**
     * @notice Convert collateral amount to cNGN value (staleness-enforced).
     * @param token          Collateral token
     * @param collateralAmt  Amount in collateral token's native decimals
     * @param collateralDec  Decimals of the collateral token
     * @return cNGN value (6 decimals)
     */
    function collateralToCngn(
        address token,
        uint256 collateralAmt,
        uint8 collateralDec
    ) external view returns (uint256) {
        uint256 price = prices[token];
        require(price > 0, "Price not set");
        require(block.timestamp - lastUpdated[token] <= MAX_PRICE_AGE, "Price stale");
        // price = cNGN (1e6) per 1e18 of collateral normalised to 18 dec
        // normalise collateral to 18 dec first
        uint256 normalised = collateralDec <= 18
            ? collateralAmt * (10 ** (18 - collateralDec))
            : collateralAmt / (10 ** (collateralDec - 18));
        return (normalised * price) / 1e18;
    }

    function setKeeper(address _keeper) external onlyOwner {
        emit KeeperUpdated(keeper, _keeper); // V2-SC-10: observable keeper rotation
        keeper = _keeper;
    }

    /// @notice Set the per-token sanity floor (0 = disabled). New floor must not
    ///         exceed the current price (if one is set) so it can't brick updates.
    function setMinPrice(address token, uint256 floor) external onlyOwner {
        require(token != address(0), "Zero address");
        uint256 current = prices[token];
        if (floor > 0 && current > 0) require(floor <= current, "Floor above price");
        minPrice[token] = floor;
        emit MinPriceUpdated(token, floor);
    }
}