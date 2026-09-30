// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset} from "../MorphoAdapter.sol";

/// @notice TESTNET ONLY. Freely mintable stand-in for USDG; it has no value.
contract TestUSDG is IERC20Asset {
    string public constant name = "Test USDG (no value)";
    string public constant symbol = "tUSDG";
    uint8 public constant decimals = 6;
    uint256 public constant MAX_MINT = 10_000e6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error MintTooLarge();

    constructor() {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

interface IStockToken {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice TESTNET ONLY. Fixed-price desk selling test Stock Tokens from operator inventory.
/// `price` is test-USD atomic units (6 decimals) per whole token (1e18 raw units).
contract TestStockDesk {
    address public immutable owner;
    IERC20Asset public immutable usd;
    IStockToken public immutable stock;
    uint256 public price;

    event PriceSet(uint256 price);
    event Bought(address indexed buyer, uint256 usdIn, uint256 stockOut);
    event Sold(address indexed seller, uint256 stockIn, uint256 usdOut);

    error NotOwner();
    error Slippage();

    constructor(address usdToken, address stockToken, uint256 initialPrice) {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
        owner = msg.sender;
        usd = IERC20Asset(usdToken);
        stock = IStockToken(stockToken);
        _setPrice(initialPrice);
    }

    function setPrice(uint256 newPrice) external {
        if (msg.sender != owner) revert NotOwner();
        _setPrice(newPrice);
    }

    function quoteBuy(uint256 usdIn) public view returns (uint256) {
        return usdIn * 1e18 / price;
    }

    function quoteSell(uint256 stockIn) public view returns (uint256) {
        return stockIn * price / 1e18;
    }

    function buy(uint256 usdIn, uint256 minStockOut) external returns (uint256 stockOut) {
        stockOut = quoteBuy(usdIn);
        if (stockOut == 0 || stockOut < minStockOut) revert Slippage();
        require(usd.transferFrom(msg.sender, address(this), usdIn), "USD");
        require(stock.transfer(msg.sender, stockOut), "STOCK");
        emit Bought(msg.sender, usdIn, stockOut);
    }

    function sell(uint256 stockIn, uint256 minUsdOut) external returns (uint256 usdOut) {
        usdOut = quoteSell(stockIn);
        if (usdOut == 0 || usdOut < minUsdOut) revert Slippage();
        require(stock.transferFrom(msg.sender, address(this), stockIn), "STOCK");
        require(usd.transfer(msg.sender, usdOut), "USD");
        emit Sold(msg.sender, stockIn, usdOut);
    }

    function _setPrice(uint256 newPrice) private {
        require(newPrice > 0, "PRICE");
        price = newPrice;
        emit PriceSet(newPrice);
    }
}

/// @notice TESTNET ONLY. Operator-set price feed (USD, 6 decimals per whole token) mirroring the
/// desk price. Stands in for a Chainlink feed; it is not a market price source.
contract TestPriceOracle {
    address public immutable owner;
    uint256 public price;
    uint256 public updatedAt;

    event PriceUpdated(uint256 price);

    constructor(uint256 initialPrice) {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
        owner = msg.sender;
        setPrice(initialPrice);
    }

    function setPrice(uint256 newPrice) public {
        require(msg.sender == owner, "OWNER");
        require(newPrice > 0, "PRICE");
        price = newPrice;
        updatedAt = block.timestamp;
        emit PriceUpdated(newPrice);
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (price, updatedAt);
    }
}
