// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset, IMorphoVault} from "../MorphoAdapter.sol";

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

/// @notice TESTNET ONLY. Minimal share vault standing in for a Morpho vault (none exists on testnet).
/// Share price rises only when someone calls `accrue`, which transfers real test assets in.
contract TestYieldVault is IMorphoVault {
    address public immutable asset;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event Accrued(address indexed from, uint256 assets);

    constructor(address token) {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
        asset = token;
    }

    function totalAssets() public view returns (uint256) {
        return IERC20Asset(asset).balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return totalSupply == 0 ? assets * 1e12 : assets * totalSupply / totalAssets();
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return totalSupply == 0 ? shares / 1e12 : shares * totalAssets() / totalSupply;
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        if (totalSupply == 0) return assets * 1e12;
        uint256 available = totalAssets();
        return (assets * totalSupply + available - 1) / available;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = previewDeposit(assets);
        require(shares > 0, "ZERO_SHARES");
        require(IERC20Asset(asset).transferFrom(msg.sender, address(this), assets), "TRANSFER");
        totalSupply += shares;
        balanceOf[receiver] += shares;
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(msg.sender == owner, "OWNER");
        shares = previewWithdraw(assets);
        _burn(owner, shares);
        require(IERC20Asset(asset).transfer(receiver, assets), "TRANSFER");
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(msg.sender == owner, "OWNER");
        assets = previewRedeem(shares);
        _burn(owner, shares);
        require(IERC20Asset(asset).transfer(receiver, assets), "TRANSFER");
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /// @notice Test yield: moves real test assets into the vault, raising every share's value.
    function accrue(uint256 assets) external {
        require(IERC20Asset(asset).transferFrom(msg.sender, address(this), assets), "TRANSFER");
        emit Accrued(msg.sender, assets);
    }

    function _burn(address owner, uint256 shares) private {
        balanceOf[owner] -= shares;
        totalSupply -= shares;
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
