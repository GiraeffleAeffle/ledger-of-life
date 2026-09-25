// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset} from "./MorphoAdapter.sol";

interface IPriceOracle {
    /// @return price USD with 6 decimals per whole token (1e18 raw units); updatedAt unix seconds.
    function latestPrice() external view returns (uint256 price, uint256 updatedAt);
}

interface IStockSale {
    function sell(uint256 stockIn, uint256 minUsdOut) external returns (uint256 usdOut);
}

/// @notice PROTOTYPE, not reviewed. A rental deposit secured by pledged stock tokens instead of
/// cash. The tenant keeps the shares (and their growth); the landlord is protected by
/// over-collateralization, a top-up grace period and an oracle-bounded forced sale. Whatever
/// is not needed for an approved claim returns to the tenant in kind.
contract CollateralEscrow {
    enum State {
        Pledging,
        Active,
        ClaimPending,
        ClaimContested,
        ReadyToSettle,
        Closed
    }

    struct Config {
        address stock;
        address usd;
        address oracle;
        address sale;
        address tenant;
        address landlord;
        address arbitrator;
        uint256 depositValue; // USD, 6 decimals: the cash deposit this collateral replaces
        uint16 initialRatioBps; // e.g. 15000 = 150 %
        uint16 maintenanceRatioBps; // e.g. 12500 = 125 %
        uint16 maxSlippageBps; // forced sales must return >= oracle value minus this
        uint32 graceSeconds;
        uint32 maxOracleAge;
    }

    IERC20Asset public immutable stock;
    IERC20Asset public immutable usd;
    IPriceOracle public immutable oracle;
    IStockSale public immutable sale;
    address public immutable tenant;
    address public immutable landlord;
    address public immutable arbitrator;
    uint256 public immutable depositValue;
    uint16 public immutable initialRatioBps;
    uint16 public immutable maintenanceRatioBps;
    uint16 public immutable maxSlippageBps;
    uint32 public immutable graceSeconds;
    uint32 public immutable maxOracleAge;

    State public state;
    uint256 public stockHeld;
    uint256 public cashHeld;
    uint256 public shortfallDeadline;
    uint256 public claimAmount;
    uint256 public approvedClaim;
    bool private entered;

    event Pledged(uint256 stockIn, uint256 cashIn, uint256 value);
    event ShortfallFlagged(uint256 value, uint256 deadline);
    event ShortfallCleared(uint256 value);
    event Liquidated(uint256 stockSold, uint256 cashOut);
    event ExcessWithdrawn(uint256 stockOut);
    event ClaimProposed(uint256 amount);
    event ClaimApproved(address by, uint256 amount);
    event Settled(uint256 landlordCash, uint256 tenantStock, uint256 tenantCash);

    error Unauthorized();
    error InvalidState();
    error InvalidConfig();
    error StaleOracle();
    error Undercollateralized();
    error NoShortfall();
    error GraceActive();
    error InvalidAmount();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(Config memory c) {
        if (
            c.stock == address(0) || c.usd == address(0) || c.oracle == address(0) || c.sale == address(0)
                || c.tenant == address(0) || c.landlord == address(0) || c.arbitrator == address(0)
                || c.tenant == c.landlord || c.tenant == c.arbitrator || c.landlord == c.arbitrator || c.depositValue == 0
                || c.maintenanceRatioBps < 10_000 || c.initialRatioBps < c.maintenanceRatioBps || c.maxSlippageBps > 1_000
                || c.maxOracleAge == 0
        ) revert InvalidConfig();
        stock = IERC20Asset(c.stock);
        usd = IERC20Asset(c.usd);
        oracle = IPriceOracle(c.oracle);
        sale = IStockSale(c.sale);
        tenant = c.tenant;
        landlord = c.landlord;
        arbitrator = c.arbitrator;
        depositValue = c.depositValue;
        initialRatioBps = c.initialRatioBps;
        maintenanceRatioBps = c.maintenanceRatioBps;
        maxSlippageBps = c.maxSlippageBps;
        graceSeconds = c.graceSeconds;
        maxOracleAge = c.maxOracleAge;
    }

    // ----- valuation -----

    function price() public view returns (uint256 p) {
        uint256 updatedAt;
        (p, updatedAt) = oracle.latestPrice();
        if (p == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxOracleAge) revert StaleOracle();
    }

    function stockValue(uint256 amount) public view returns (uint256) {
        return amount * price() / 1e18;
    }

    /// @notice USD (6 decimals) value of everything securing the deposit.
    function collateralValue() public view returns (uint256) {
        return stockValue(stockHeld) + cashHeld;
    }

    function required(uint16 ratioBps) public view returns (uint256) {
        return depositValue * ratioBps / 10_000;
    }

    // ----- tenant: pledge, top up, withdraw excess -----

    /// @notice Pledge stock and/or cash. Activates once the initial ratio is met.
    function pledge(uint256 stockIn, uint256 cashIn) external nonReentrant {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.Pledging && state != State.Active) revert InvalidState();
        if (stockIn == 0 && cashIn == 0) revert InvalidAmount();
        _pull(stock, stockIn);
        _pull(usd, cashIn);
        stockHeld += stockIn;
        cashHeld += cashIn;
        uint256 value = collateralValue();
        if (state == State.Pledging) {
            if (value < required(initialRatioBps)) revert Undercollateralized();
            state = State.Active;
        }
        if (shortfallDeadline != 0 && value >= required(maintenanceRatioBps)) {
            shortfallDeadline = 0;
            emit ShortfallCleared(value);
        }
        emit Pledged(stockIn, cashIn, value);
    }

    /// @notice The tenant may take back shares only while the rest still meets the initial ratio.
    function withdrawExcess(uint256 stockOut) external nonReentrant {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.Active || shortfallDeadline != 0) revert InvalidState();
        if (stockOut == 0 || stockOut > stockHeld) revert InvalidAmount();
        stockHeld -= stockOut;
        if (collateralValue() < required(initialRatioBps)) revert Undercollateralized();
        _push(stock, tenant, stockOut);
        emit ExcessWithdrawn(stockOut);
    }

    // ----- anyone: shortfall protection for the landlord -----

    function flagShortfall() external {
        if (state != State.Active || shortfallDeadline != 0) revert InvalidState();
        uint256 value = collateralValue();
        if (value >= required(maintenanceRatioBps)) revert NoShortfall();
        shortfallDeadline = block.timestamp + graceSeconds;
        emit ShortfallFlagged(value, shortfallDeadline);
    }

    /// @notice After the grace period, sell just enough stock that cash alone covers the deposit.
    function liquidate() external nonReentrant {
        if (state != State.Active || shortfallDeadline == 0) revert InvalidState();
        if (block.timestamp < shortfallDeadline) revert GraceActive();
        if (collateralValue() >= required(maintenanceRatioBps)) {
            shortfallDeadline = 0;
            emit ShortfallCleared(collateralValue());
            return;
        }
        _sell(depositValue > cashHeld ? depositValue - cashHeld : 0);
        shortfallDeadline = 0;
    }

    // ----- move-out -----

    function proposeClaim(uint256 amount) external {
        if (msg.sender != landlord) revert Unauthorized();
        if (state != State.Active) revert InvalidState();
        if (amount > depositValue) revert InvalidAmount();
        claimAmount = amount;
        state = State.ClaimPending;
        emit ClaimProposed(amount);
    }

    function acceptClaim() external {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.ClaimPending) revert InvalidState();
        _approve(claimAmount);
    }

    function contestClaim() external {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.ClaimPending) revert InvalidState();
        state = State.ClaimContested;
    }

    function resolveClaim(uint256 amount) external {
        if (msg.sender != arbitrator) revert Unauthorized();
        if (state != State.ClaimContested) revert InvalidState();
        if (amount > claimAmount) revert InvalidAmount();
        _approve(amount);
    }

    /// @notice Anyone may execute: landlord gets the approved claim in cash (cash first, then an
    /// oracle-bounded sale of just enough stock); the tenant gets the rest back in kind.
    function settle() external nonReentrant {
        if (state != State.ReadyToSettle) revert InvalidState();
        uint256 owed = approvedClaim;
        if (owed > cashHeld) _sell(owed - cashHeld);
        if (owed > cashHeld) owed = cashHeld; // collateral exhausted: landlord bears the remainder
        state = State.Closed;
        cashHeld -= owed;
        uint256 tenantStock = stockHeld;
        uint256 tenantCash = cashHeld;
        stockHeld = 0;
        cashHeld = 0;
        if (owed != 0) _push(usd, landlord, owed);
        if (tenantStock != 0) _push(stock, tenant, tenantStock);
        if (tenantCash != 0) _push(usd, tenant, tenantCash);
        emit Settled(owed, tenantStock, tenantCash);
    }

    // ----- internals -----

    function _approve(uint256 amount) private {
        approvedClaim = amount;
        state = State.ReadyToSettle;
        emit ClaimApproved(msg.sender, amount);
    }

    /// @dev Sells the smallest stock amount whose oracle value covers `cashNeeded` (capped at holdings).
    function _sell(uint256 cashNeeded) private returns (uint256 cashOut) {
        if (cashNeeded == 0 || stockHeld == 0) return 0;
        uint256 p = price();
        uint256 amount = (cashNeeded * 1e18 + p - 1) / p;
        if (amount > stockHeld) amount = stockHeld;
        uint256 minOut = stockValue(amount) * (10_000 - maxSlippageBps) / 10_000;
        stockHeld -= amount;
        _call(address(stock), abi.encodeCall(IERC20Asset.approve, (address(sale), amount)));
        uint256 before = usd.balanceOf(address(this));
        sale.sell(amount, minOut);
        _call(address(stock), abi.encodeCall(IERC20Asset.approve, (address(sale), 0)));
        cashOut = usd.balanceOf(address(this)) - before;
        if (cashOut < minOut) revert InvalidAmount();
        cashHeld += cashOut;
        emit Liquidated(amount, cashOut);
    }

    function _pull(IERC20Asset token, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = token.balanceOf(address(this));
        _call(address(token), abi.encodeCall(IERC20Asset.transferFrom, (msg.sender, address(this), amount)));
        if (token.balanceOf(address(this)) != before + amount) revert TransferFailed();
    }

    function _push(IERC20Asset token, address to, uint256 amount) private {
        _call(address(token), abi.encodeCall(IERC20Asset.transfer, (to, amount)));
    }

    function _call(address target, bytes memory data) private {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }
}
