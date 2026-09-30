// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset, IMorphoVault, MorphoAdapter} from "../MorphoAdapter.sol";
import {IPriceOracle} from "../CollateralEscrow.sol";

/// @notice TESTNET ONLY. Lender-funded loans; test dollars have no value and anyone can mint them.
/// @dev No administrator. Cash ignores donations. Debt shares round in the pool's favour.
contract SharedLendingPool is IMorphoVault {
    using MorphoAdapter for IERC20Asset;
    IERC20Asset public immutable usd;
    IERC20Asset public immutable stock;
    IPriceOracle public immutable oracle;
    uint256 public constant MAX_LTV_BPS = 5_000;
    uint256 public constant LIQUIDATION_LTV_BPS = 8_000;
    uint256 public constant LIQUIDATION_BONUS_BPS = 1_000;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_UTILIZATION_BPS = 9_000;
    uint256 public constant BORROW_APR_BPS = 500;
    uint256 public constant BORROW_APY_BPS = 513; // e^0.05 - 1, rounded to basis points.
    uint256 public constant MIN_BORROW = 1e6;
    uint256 public constant MAX_BORROWER_PAGE = 100;
    uint256 public constant NORMAL_MAX_PRICE_AGE = 26 hours;
    uint256 public constant WEEKEND_MAX_PRICE_AGE = 74 hours;
    uint256 private constant RAY = 1e27;
    uint256 private constant YEAR_BPS = 365 days * 10_000;
    uint256 public constant SHARE_VIRTUAL_OFFSET = 1e12;
    uint8 public constant decimals = 18;
    string public constant name = "Shared test dollar lending shares";
    string public constant symbol = "s-tUSDG";
    uint256 public cash;
    uint256 public totalSupply;
    uint256 public totalBorrowAssets;
    uint256 public totalBorrowShares;
    uint256 public totalCollateral;
    uint256 public lastAccrual;
    uint256 public interestRemainder;
    mapping(address => uint256) public balanceOf;
    mapping(address => int256) public netContributed;
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public borrowSharesOf;
    mapping(address => bool) private listed;
    address[] private borrowers;
    uint256 private entered = 1;
    error Unauthorized(); error InvalidAmount(); error InsufficientLiquidity();
    error Undercollateralized(); error NotLiquidatable(); error StaleOracle();
    error UtilizationExceeded(); error Reentrancy();
    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event Transfer(address indexed from, address indexed to, uint256 shares);
    event CollateralDeposited(address indexed borrower, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, uint256 amount);
    event Borrowed(address indexed borrower, uint256 assets, uint256 shares);
    event Repaid(address indexed borrower, uint256 assets, uint256 shares);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 repaid, uint256 seized);
    event BadDebtRealized(address indexed borrower, uint256 assets);

    constructor(address usd_, address stock_, address oracle_) {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
        require(usd_ != address(0) && stock_ != address(0) && oracle_ != address(0), "ZERO_PARAMETER");
        usd = IERC20Asset(usd_); stock = IERC20Asset(stock_); oracle = IPriceOracle(oracle_);
        lastAccrual = block.timestamp;
    }
    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2; _; entered = 1;
    }
    function asset() external view returns (address) { return address(usd); }
    function _pending() private view returns (uint256 assets, uint256 remainder) {
        uint256 elapsed = block.timestamp - lastAccrual;
        // Continuous compounding at a fixed 5% nominal rate. RAY fractions
        // survive permissionless accrual calls, eliminating frequency effects.
        if (totalBorrowAssets == 0) return (0, 0);
        if (elapsed == 0) return (totalBorrowAssets, interestRemainder);
        uint256 growth = _compounded(elapsed);
        uint256 interest = PoolMath.mulDiv(totalBorrowAssets, growth, RAY);
        uint256 fraction = mulmod(totalBorrowAssets, growth, RAY)
            + PoolMath.mulDiv(interestRemainder, RAY + growth, RAY);
        return (totalBorrowAssets + interest + fraction / RAY, fraction % RAY);
    }
    function _compounded(uint256 elapsed) private pure returns (uint256) {
        uint256 exponent = PoolMath.mulDiv(elapsed, BORROW_APR_BPS * RAY, YEAR_BPS);
        uint256 squares;
        // Range reduction bounds Taylor error even across long idle periods.
        while (exponent > RAY / 2) { exponent /= 2; ++squares; }
        uint256 term = RAY;
        uint256 sum = RAY;
        for (uint256 i = 1; i <= 28; ++i) {
            term = PoolMath.mulDiv(term, exponent, RAY * i);
            if (term == 0) break;
            sum += term;
        }
        for (uint256 i; i < squares; ++i) sum = PoolMath.mulDiv(sum, sum, RAY);
        return sum - RAY;
    }
    function _accrue() private {
        (totalBorrowAssets, interestRemainder) = _pending();
        lastAccrual = block.timestamp;
    }
    function totalAssets() public view returns (uint256) { (uint256 debt,) = _pending(); return cash + debt; }
    function previewDeposit(uint256 assets) public view returns (uint256) { return PoolMath.mulDiv(assets, totalSupply + SHARE_VIRTUAL_OFFSET, totalAssets() + 1); }
    function previewRedeem(uint256 shares) public view returns (uint256) { return PoolMath.mulDiv(shares, totalAssets() + 1, totalSupply + SHARE_VIRTUAL_OFFSET); }
    function previewWithdraw(uint256 assets) public view returns (uint256) { return PoolMath.up(assets, totalSupply + SHARE_VIRTUAL_OFFSET, totalAssets() + 1); }
    function maxWithdraw(address owner) external view returns (uint256) { return _min(cash, previewRedeem(balanceOf[owner])); }
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0 || receiver == address(0)) revert InvalidAmount();
        _accrue(); shares = previewDeposit(assets); if (shares == 0) revert InvalidAmount();
        usd.safeTransferFrom(msg.sender, assets);
        cash += assets; totalSupply += shares; balanceOf[receiver] += shares;
        netContributed[receiver] += _signed(assets);
        emit Transfer(address(0), receiver, shares); emit Deposit(msg.sender, receiver, assets, shares);
    }
    function withdraw(uint256 assets, address receiver, address owner) external nonReentrant returns (uint256 shares) {
        if (msg.sender != owner) revert Unauthorized();
        _accrue(); shares = previewWithdraw(assets); _withdraw(assets, shares, receiver, owner);
    }
    function redeem(uint256 shares, address receiver, address owner) external nonReentrant returns (uint256 assets) {
        if (msg.sender != owner) revert Unauthorized();
        _accrue(); assets = previewRedeem(shares); _withdraw(assets, shares, receiver, owner);
    }
    function _withdraw(uint256 assets, uint256 shares, address receiver, address owner) private {
        if (assets == 0 || shares == 0 || receiver == address(0)) revert InvalidAmount();
        if (assets > cash) revert InsufficientLiquidity();
        balanceOf[owner] -= shares; totalSupply -= shares; cash -= assets;
        netContributed[owner] -= _signed(assets);
        usd.safeTransfer(receiver, assets);
        emit Transfer(owner, address(0), shares); emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }
    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        stock.safeTransferFrom(msg.sender, amount);
        collateralOf[msg.sender] += amount; totalCollateral += amount;
        emit CollateralDeposited(msg.sender, amount);
    }
    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _accrue(); uint256 remaining = collateralOf[msg.sender] - amount;
        if (borrowSharesOf[msg.sender] != 0) {
            (uint256 price,) = _freshPrice();
            if (_debt(msg.sender, totalBorrowAssets) > PoolMath.mulDiv(_value(remaining, price), MAX_LTV_BPS, 10_000)) revert Undercollateralized();
        }
        collateralOf[msg.sender] = remaining; totalCollateral -= amount;
        stock.safeTransfer(msg.sender, amount); emit CollateralWithdrawn(msg.sender, amount);
    }
    function borrow(uint256 amount) external nonReentrant {
        if (amount < MIN_BORROW) revert InvalidAmount();
        _accrue(); (uint256 price,) = _freshPrice();
        if (amount > cash) revert InsufficientLiquidity();
        uint256 shares = totalBorrowShares == 0 ? amount * SHARE_VIRTUAL_OFFSET : PoolMath.up(amount, totalBorrowShares, totalBorrowAssets);
        uint256 nextAssets = totalBorrowAssets + amount;
        uint256 nextShares = totalBorrowShares + shares;
        uint256 debt = PoolMath.up(borrowSharesOf[msg.sender] + shares, nextAssets, nextShares);
        if (debt > PoolMath.mulDiv(_value(collateralOf[msg.sender], price), MAX_LTV_BPS, 10_000)) revert Undercollateralized();
        if (nextAssets > PoolMath.mulDiv(cash + totalBorrowAssets, MAX_UTILIZATION_BPS, 10_000)) revert UtilizationExceeded();
        totalBorrowAssets = nextAssets; totalBorrowShares = nextShares; borrowSharesOf[msg.sender] += shares; cash -= amount;
        if (!listed[msg.sender]) { listed[msg.sender] = true; borrowers.push(msg.sender); }
        usd.safeTransfer(msg.sender, amount); emit Borrowed(msg.sender, amount, shares);
    }
    function repay(uint256 maxAmount) external nonReentrant returns (uint256 assets) {
        _accrue(); (assets,) = _repay(msg.sender, maxAmount); 
    }
    function _repay(address borrower, uint256 cap) private returns (uint256 assets, uint256 shares) {
        uint256 owned = borrowSharesOf[borrower];
        if (owned == 0 || cap == 0) revert InvalidAmount();
        uint256 debt = _debt(borrower, totalBorrowAssets);
        shares = cap >= debt ? owned : PoolMath.mulDiv(cap, totalBorrowShares, totalBorrowAssets);
        if (shares == 0) revert InvalidAmount();
        assets = PoolMath.up(shares, totalBorrowAssets, totalBorrowShares);
        // The payer rounds up; remove only the floor claim. The atomic rounding
        // surplus stays with lenders and cannot erase another borrower's debt.
        uint256 removed = PoolMath.mulDiv(shares, totalBorrowAssets, totalBorrowShares);
        usd.safeTransferFrom(msg.sender, assets);
        borrowSharesOf[borrower] -= shares; totalBorrowShares -= shares; totalBorrowAssets -= removed; cash += assets;
        if (totalBorrowShares == 0) { totalBorrowAssets = 0; interestRemainder = 0; }
        emit Repaid(borrower, assets, shares);
    }
    function liquidate(address borrower, uint256 maxRepay) external nonReentrant returns (uint256 repaid, uint256 seized) {
        if (maxRepay == 0) revert InvalidAmount();
        _accrue(); (uint256 price,) = _freshPrice();
        uint256 debt = _debt(borrower, totalBorrowAssets);
        uint256 collateral = collateralOf[borrower]; uint256 value = _value(collateral, price);
        if (debt == 0 || debt < PoolMath.up(value, LIQUIDATION_LTV_BPS, 10_000)) revert NotLiquidatable();
        uint256 collateralCap = PoolMath.mulDiv(value, 10_000, 10_000 + LIQUIDATION_BONUS_BPS);
        uint256 cap = _min(maxRepay, _min(debt / 2, collateralCap));
        if (collateralCap != 0) {
            (repaid,) = _repay(borrower, cap);
            seized = _min(collateral, PoolMath.up(repaid, (10_000 + LIQUIDATION_BONUS_BPS) * 1e18, price * 10_000));
        }
        // The cap already rounds dollar repayment down. At that cap only
        // sub-atomic collateral dust is left; seize it and realize all bad debt.
        if (cap == collateralCap && maxRepay >= collateralCap && debt / 2 >= collateralCap) seized = collateral;
        collateralOf[borrower] -= seized; totalCollateral -= seized;
        stock.safeTransfer(msg.sender, seized);
        emit Liquidated(borrower, msg.sender, repaid, seized);
        if (collateralOf[borrower] == 0) _writeOff(borrower);
    }
    function realizeBadDebt(address borrower) external nonReentrant {
        _accrue();
        if (collateralOf[borrower] != 0) {
            (uint256 price,) = _freshPrice();
            uint256 realizable = PoolMath.mulDiv(_value(collateralOf[borrower], price), 10_000, 10_000 + LIQUIDATION_BONUS_BPS);
            if (realizable != 0) revert Undercollateralized();
        }
        _writeOff(borrower);
    }
    function _writeOff(address borrower) private {
        uint256 shares = borrowSharesOf[borrower]; if (shares == 0) return;
        // Realize the floor share claim; at most one atomic dollar of rounding
        // remains with the pool, rather than erasing another borrower's debt.
        uint256 loss = PoolMath.mulDiv(shares, totalBorrowAssets, totalBorrowShares);
        borrowSharesOf[borrower] = 0; totalBorrowShares -= shares; totalBorrowAssets -= loss;
        if (totalBorrowShares == 0) { totalBorrowAssets = 0; interestRemainder = 0; }
        emit BadDebtRealized(borrower, loss);
    }
    function _debt(address borrower, uint256 assets) private view returns (uint256) {
        uint256 shares = borrowSharesOf[borrower];
        return shares == 0 ? 0 : PoolMath.up(shares, assets, totalBorrowShares);
    }
    function priceMaxAge() public view returns (uint256) {
        uint256 weekday = (block.timestamp / 1 days + 4) % 7; // Epoch Thursday; Sunday = 0.
        return weekday == 6 || weekday == 0 || (weekday == 1 && block.timestamp % 1 days < 12 hours) ? WEEKEND_MAX_PRICE_AGE : NORMAL_MAX_PRICE_AGE;
    }
    function _price() private view returns (uint256 price, uint256 updatedAt, bool fresh) {
        try oracle.latestPrice() returns (uint256 p, uint256 t) { price = p; updatedAt = t; } catch { return (0, 0, false); }
        fresh = price != 0 && updatedAt != 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= priceMaxAge();
    }
    function _freshPrice() private view returns (uint256 price, uint256 updatedAt) {
        bool fresh; (price, updatedAt, fresh) = _price(); if (!fresh) revert StaleOracle();
    }
    function position(address borrower) external view returns (uint256 collateral, uint256 debt, uint256 value, uint256 ltvBps, uint256 borrowable, bool priceFresh) {
        (uint256 price,, bool fresh) = _price(); (uint256 assets,) = _pending();
        collateral = collateralOf[borrower]; debt = _debt(borrower, assets); value = _value(collateral, price); priceFresh = fresh;
        ltvBps = value == 0 ? (debt == 0 ? 0 : type(uint256).max) : PoolMath.up(debt, 10_000, value);
        uint256 limit = PoolMath.mulDiv(value, MAX_LTV_BPS, 10_000);
        if (fresh && limit > debt) {
            uint256 utilizationLimit = PoolMath.mulDiv(cash + assets, MAX_UTILIZATION_BPS, 10_000);
            borrowable = utilizationLimit > assets ? _min(limit - debt, _min(cash, utilizationLimit - assets)) : 0;
        }
    }
    function market() external view returns (uint256 cash_, uint256 assets, uint256 borrowed, uint256 utilizationBps, uint256 borrowAprBps, uint256 supplyAprBps, uint256 price, uint256 priceUpdatedAt, bool priceFresh, uint256 effectiveBorrowApyBps) {
        cash_ = cash; (borrowed,) = _pending(); assets = cash + borrowed;
        utilizationBps = assets == 0 ? 0 : PoolMath.mulDiv(borrowed, 10_000, assets);
        borrowAprBps = BORROW_APR_BPS; supplyAprBps = assets == 0 ? 0 : PoolMath.mulDiv(BORROW_APR_BPS, borrowed, assets);
        (price, priceUpdatedAt, priceFresh) = _price();
        effectiveBorrowApyBps = BORROW_APY_BPS;
    }
    function borrowerCount() external view returns (uint256) { return borrowers.length; }
    function borrowerAt(uint256 i) external view returns (address) { return borrowers[i]; }
    function borrowersPage(uint256 start, uint256 count) external view returns (address[] memory page) {
        if (count > MAX_BORROWER_PAGE) revert InvalidAmount();
        uint256 length = borrowers.length;
        if (start >= length) return new address[](0);
        count = _min(count, length - start);
        page = new address[](count);
        for (uint256 i; i < count; ++i) page[i] = borrowers[start + i];
    }
    function collateralShortfall() external view returns (bool) {
        return stock.balanceOf(address(this)) < totalCollateral;
    }
    function _value(uint256 amount, uint256 price) private pure returns (uint256) { return PoolMath.mulDiv(amount, price, 1e18); }
    function _min(uint256 a, uint256 b) private pure returns (uint256) { return a < b ? a : b; }
    function _signed(uint256 a) private pure returns (int256) { require(a <= uint256(type(int256).max), "AMOUNT_OVERFLOW"); return int256(a); }
}

/// @dev Full-precision floor/ceiling multiplication, using a 512-bit intermediate.
library PoolMath {
    function up(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        uint256 result = mulDiv(x, y, d); return result + (mulmod(x, y, d) == 0 ? 0 : 1);
    }
    function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 low; uint256 high;
            assembly { let mm := mulmod(x, y, not(0)) low := mul(x, y) high := sub(sub(mm, low), lt(mm, low)) }
            if (high == 0) return low / d;
            require(d > high, "MULDIV_OVERFLOW");
            uint256 remainder;
            assembly { remainder := mulmod(x, y, d) high := sub(high, gt(remainder, low)) low := sub(low, remainder) }
            uint256 twos = d & (0 - d);
            assembly { d := div(d, twos) low := div(low, twos) twos := add(div(sub(0, twos), twos), 1) }
            low |= high * twos;
            uint256 inverse = (3 * d) ^ 2;
            inverse *= 2 - d * inverse; inverse *= 2 - d * inverse;
            inverse *= 2 - d * inverse; inverse *= 2 - d * inverse;
            inverse *= 2 - d * inverse; inverse *= 2 - d * inverse;
            result = low * inverse;
        }
    }
}
