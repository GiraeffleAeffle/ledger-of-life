// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset, MorphoAdapter} from "../MorphoAdapter.sol";
import {IPriceOracle} from "../CollateralEscrow.sol";

/// @notice TESTNET ONLY. Operator-funded USD loans against 18-decimal test TSLA shares.
/// @dev USD and oracle prices have 6 decimals. This is a demo, not an audited lending market.
contract TestLendingPool {
    using MorphoAdapter for IERC20Asset;

    uint256 public constant MAX_LTV_BPS = 5_000;
    uint256 public constant LIQUIDATION_LTV_BPS = 8_000;
    uint256 public constant LIQUIDATION_BONUS_BPS = 1_000;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000;
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 private constant STOCK_UNIT = 1e18;

    IERC20Asset public immutable usd;
    IERC20Asset public immutable stock;
    IPriceOracle public immutable oracle;
    address public immutable operator;
    uint256 public immutable annualInterestBps;
    uint256 public immutable maxOracleAge;

    struct Loan {
        uint256 collateral;
        uint256 debt;
        uint256 lastAccrued;
        uint256 interestRemainder;
    }

    mapping(address => Loan) private loans;
    bool private entered;

    event LiquiditySupplied(uint256 amount);
    event LiquidityWithdrawn(uint256 amount);
    event CollateralDeposited(address indexed tenant, uint256 amount);
    event CollateralWithdrawn(address indexed tenant, uint256 amount);
    event Borrowed(address indexed tenant, uint256 amount, uint256 debt);
    event Repaid(address indexed tenant, uint256 amount, uint256 debt);
    event Liquidated(address indexed liquidator, address indexed tenant, uint256 usdRepaid, uint256 stockSeized);

    error InvalidConfig();
    error Unauthorized();
    error InvalidAmount();
    error StaleOracle();
    error Undercollateralized();
    error NotLiquidatable();
    error InsufficientLiquidity();
    error Reentrancy();

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address stockToken, address usdToken, address oracleAddress, uint256 interestBps, uint32 oracleAge) {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
        if (
            usdToken == address(0) || stockToken == address(0) || oracleAddress == address(0)
                || usdToken == stockToken || interestBps == 0 || interestBps > BPS || oracleAge == 0
        ) revert InvalidConfig();
        usd = IERC20Asset(usdToken);
        stock = IERC20Asset(stockToken);
        oracle = IPriceOracle(oracleAddress);
        operator = msg.sender;
        annualInterestBps = interestBps;
        maxOracleAge = oracleAge;
    }

    function price() public view returns (uint256 value) {
        uint256 updatedAt;
        (value, updatedAt) = oracle.latestPrice();
        if (value == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxOracleAge) {
            revert StaleOracle();
        }
    }

    /// @notice Current loan including unpaid per-second interest. Health >= 10,000 is safe.
    /// @dev When debt is zero, health is max uint256 (no liquidation risk).
    function position(address tenant)
        external
        view
        returns (uint256 collateral, uint256 debt, uint256 value, uint256 ltv, uint256 health)
    {
        Loan storage loan = loans[tenant];
        collateral = loan.collateral;
        (debt,) = _currentDebt(loan);
        if (collateral != 0) value = collateral * price() / STOCK_UNIT;
        if (debt == 0) return (collateral, 0, value, 0, type(uint256).max);
        ltv = value == 0 ? type(uint256).max : debt * BPS / value;
        health = value * LIQUIDATION_LTV_BPS / debt;
    }

    /// @notice The operator provides real test USD tokens, not accounting-only liquidity.
    function supply(uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert InvalidAmount();
        usd.safeTransferFrom(msg.sender, amount);
        emit LiquiditySupplied(amount);
    }

    /// @notice The operator can remove only cash actually available in the pool.
    function withdrawLiquidity(uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _send(usd, msg.sender, amount);
        emit LiquidityWithdrawn(amount);
    }

    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        stock.safeTransferFrom(msg.sender, amount);
        loans[msg.sender].collateral += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external nonReentrant {
        Loan storage loan = loans[msg.sender];
        if (amount == 0 || amount > loan.collateral) revert InvalidAmount();
        uint256 remaining = loan.collateral - amount;
        (uint256 debt,) = _currentDebt(loan);
        if (debt != 0 && debt > remaining * price() / STOCK_UNIT * MAX_LTV_BPS / BPS) {
            revert Undercollateralized();
        }
        loan.collateral = remaining;
        _send(stock, msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Loan storage loan = loans[msg.sender];
        _accrue(loan);
        uint256 debt = loan.debt + amount;
        if (debt > (loan.collateral * price() / STOCK_UNIT) * MAX_LTV_BPS / BPS) {
            revert Undercollateralized();
        }
        loan.debt = debt;
        _send(usd, msg.sender, amount);
        emit Borrowed(msg.sender, amount, debt);
    }

    /// @notice Pay up to `maxAmount` USD of your outstanding balance; returns the actual paid amount.
    function repay(uint256 maxAmount) external nonReentrant returns (uint256 paid) {
        if (maxAmount == 0) revert InvalidAmount();
        Loan storage loan = loans[msg.sender];
        _accrue(loan);
        paid = maxAmount < loan.debt ? maxAmount : loan.debt;
        if (paid == 0) revert InvalidAmount();
        usd.safeTransferFrom(msg.sender, paid);
        loan.debt -= paid;
        if (loan.debt == 0) loan.interestRemainder = 0;
        emit Repaid(msg.sender, paid, loan.debt);
    }

    /// @notice Anyone can repay an unhealthy tenant's USD debt and receive discounted test stock.
    /// @dev Caps each liquidation at half the debt and the available collateral; returns actual amounts.
    function liquidate(address tenant, uint256 maxUsdIn)
        external
        nonReentrant
        returns (uint256 usdRepaid, uint256 stockSeized)
    {
        if (maxUsdIn == 0) revert InvalidAmount();
        Loan storage loan = loans[tenant];
        _accrue(loan);
        uint256 debt = loan.debt;
        uint256 p = price();
        uint256 value = loan.collateral * p / STOCK_UNIT;
        if (debt == 0 || debt * BPS < value * LIQUIDATION_LTV_BPS) revert NotLiquidatable();

        uint256 closeLimit = debt / 2 + debt % 2;
        usdRepaid = maxUsdIn < closeLimit ? maxUsdIn : closeLimit;
        uint256 collateralLimit = value * BPS / (BPS + LIQUIDATION_BONUS_BPS);
        if (usdRepaid > collateralLimit) usdRepaid = collateralLimit;
        if (usdRepaid == 0) revert InvalidAmount();
        // Round stock up: the liquidator receives at least the quoted bonus.
        stockSeized = (usdRepaid * (BPS + LIQUIDATION_BONUS_BPS) * STOCK_UNIT + p * BPS - 1) / (p * BPS);
        if (stockSeized > loan.collateral) revert InvalidAmount();

        usd.safeTransferFrom(msg.sender, usdRepaid);
        loan.debt = debt - usdRepaid;
        loan.collateral -= stockSeized;
        _send(stock, msg.sender, stockSeized);
        emit Liquidated(msg.sender, tenant, usdRepaid, stockSeized);
    }

    function _accrue(Loan storage loan) private {
        (uint256 debt, uint256 remainder) = _currentDebt(loan);
        loan.debt = debt;
        loan.interestRemainder = remainder;
        loan.lastAccrued = block.timestamp;
    }

    function _currentDebt(Loan storage loan) private view returns (uint256 debt, uint256 remainder) {
        debt = loan.debt;
        if (debt == 0) return (0, 0);
        uint256 numerator = debt * annualInterestBps * (block.timestamp - loan.lastAccrued) + loan.interestRemainder;
        debt += numerator / (BPS * YEAR);
        remainder = numerator % (BPS * YEAR);
    }

    function _send(IERC20Asset token, address recipient, uint256 amount) private {
        if (token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();
        token.safeTransfer(recipient, amount);
    }
}
