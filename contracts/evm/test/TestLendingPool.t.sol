// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestLendingPool} from "../src/testnet/TestLendingPool.sol";
import {TestUSDG, TestPriceOracle} from "../src/testnet/TestnetMarket.sol";
import {MockStock} from "./CollateralEscrow.t.sol";

interface VmLending {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract TestLendingPoolTest {
    VmLending private constant vm = VmLending(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant TENANT = address(0x401);
    address private constant LIQUIDATOR = address(0x402);
    address private constant OTHER = address(0x403);
    uint256 private constant PRICE = 400e6;

    TestUSDG private usd;
    MockStock private stock;
    TestPriceOracle private oracle;
    TestLendingPool private pool;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new TestUSDG();
        stock = new MockStock();
        oracle = new TestPriceOracle(PRICE);
        pool = new TestLendingPool(address(stock), address(usd), address(oracle), 1_000, 1 days);
        // Direct operator funding is spendable liquidity even without a supply transaction.
        usd.mint(address(pool), 10_000e6);
        stock.mint(TENANT, 10e18);
        vm.prank(TENANT);
        stock.approve(address(pool), type(uint256).max);
        vm.prank(TENANT);
        usd.approve(address(pool), type(uint256).max);
        usd.mint(LIQUIDATOR, 10_000e6);
        vm.prank(LIQUIDATOR);
        usd.approve(address(pool), type(uint256).max);
    }

    function _depositAndBorrow() private {
        vm.prank(TENANT);
        pool.depositCollateral(5e18);
        vm.prank(TENANT);
        pool.borrow(1_000e6);
    }

    function testBorrowAtFiftyPercentAndCollateralTopUp() public {
        vm.prank(TENANT);
        pool.depositCollateral(5e18);
        vm.prank(OTHER);
        vm.expectRevert(TestLendingPool.Undercollateralized.selector);
        pool.borrow(1);
        vm.prank(TENANT);
        pool.borrow(1_000e6);
        (uint256 shares, uint256 debt, uint256 value, uint256 ltv, uint256 health) = pool.position(TENANT);
        require(shares == 5e18 && debt == 1_000e6 && value == 2_000e6, "BORROW_POSITION");
        require(ltv == 5_000 && health == 16_000, "BORROW_RATIOS");
        vm.prank(TENANT);
        vm.expectRevert(TestLendingPool.Undercollateralized.selector);
        pool.borrow(1);
        vm.prank(TENANT);
        vm.expectRevert(TestLendingPool.Undercollateralized.selector);
        pool.withdrawCollateral(1);
        vm.prank(TENANT);
        pool.depositCollateral(1e18);
        vm.prank(TENANT);
        pool.borrow(200e6);
        require(usd.balanceOf(TENANT) == 1_200e6, "BORROW_RECEIPT");
        vm.prank(TENANT);
        pool.repay(200e6);
        vm.prank(TENANT);
        pool.withdrawCollateral(1e18);
        require(stock.balanceOf(TENANT) == 5e18, "TOPUP_WITHDRAWAL");
    }

    function testInterestAccruesByTimestampAndSmallRepayKeepsFractionalInterest() public {
        _depositAndBorrow();
        vm.warp(block.timestamp + 365 days);
        oracle.setPrice(PRICE);
        (, uint256 debt,,,) = pool.position(TENANT);
        require(debt == 1_100e6, "YEAR_INTEREST");
        usd.mint(TENANT, 100e6);
        vm.prank(TENANT);
        pool.repay(100e6);
        vm.warp(block.timestamp + 1);
        oracle.setPrice(PRICE);
        (, debt,,,) = pool.position(TENANT);
        require(debt == 1_000e6 + 3, "SECOND_INTEREST");
        vm.prank(TENANT);
        pool.repay(1);
        vm.warp(block.timestamp + 1);
        (, debt,,,) = pool.position(TENANT);
        require(debt == 1_000e6 + 6 - 1, "FRACTIONAL_CARRY");
    }

    function testPriceDropTriggersPermissionlessPartialLiquidation() public {
        _depositAndBorrow();
        vm.expectRevert(TestLendingPool.NotLiquidatable.selector);
        pool.liquidate(TENANT, 400e6);
        oracle.setPrice(250e6); // 1000 / 1250 = 80% LTV, inclusive trigger.
        vm.prank(LIQUIDATOR);
        (uint256 paid, uint256 seized) = pool.liquidate(TENANT, 400e6);
        require(paid == 400e6 && seized == 1.76e18, "LIQUIDATION_QUOTE");
        require(stock.balanceOf(LIQUIDATOR) == seized, "LIQUIDATOR_STOCK");
        (uint256 collateral, uint256 debt, uint256 value, uint256 ltv, uint256 health) = pool.position(TENANT);
        require(collateral == 3.24e18 && debt == 600e6 && value == 810e6, "AFTER_LIQUIDATION");
        require(ltv == uint256(600e6) * 10_000 / 810e6 && health > 10_000, "HEALTH_RESTORED");
        vm.prank(LIQUIDATOR);
        vm.expectRevert(TestLendingPool.NotLiquidatable.selector);
        pool.liquidate(TENANT, 1e6);
    }

    function testLiquidationNeverTakesMoreThanHalfTheOutstandingDebt() public {
        _depositAndBorrow();
        oracle.setPrice(250e6);
        vm.prank(LIQUIDATOR);
        (uint256 paid, uint256 seized) = pool.liquidate(TENANT, 1_000e6);
        require(paid == 500e6 && seized == 2.2e18, "CLOSE_FACTOR");
        (uint256 collateral, uint256 debt,,,) = pool.position(TENANT);
        require(collateral == 2.8e18 && debt == 500e6, "REMAINDER");
    }

    function testCloseFactorAndCollateralCapOnSevereCrash() public {
        _depositAndBorrow();
        oracle.setPrice(100e6);
        vm.prank(LIQUIDATOR);
        (uint256 paid, uint256 seized) = pool.liquidate(TENANT, type(uint256).max);
        require(paid == 454_545_454, "COLLATERAL_CAP");
        require(seized <= 5e18 && seized > 4.99e18, "COLLATERAL_SEIZURE");
        (, uint256 outstanding,,,) = pool.position(TENANT);
        require(outstanding == 1_000e6 - paid, "NO_DEBT_FORGIVEN");
    }

    function testRepaymentReturnsAllCollateralEvenWhenPriceFeedIsStale() public {
        _depositAndBorrow();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(TENANT);
        vm.expectRevert(TestLendingPool.StaleOracle.selector);
        pool.borrow(1);
        vm.prank(TENANT);
        vm.expectRevert(TestLendingPool.StaleOracle.selector);
        pool.withdrawCollateral(1);
        vm.expectRevert(TestLendingPool.StaleOracle.selector);
        pool.position(TENANT);
        usd.mint(TENANT, 10e6);
        vm.prank(TENANT);
        uint256 paid = pool.repay(type(uint256).max);
        require(paid > 1_000e6 && paid < 1_010e6, "ACCRUED_PAYMENT");
        vm.prank(TENANT);
        pool.withdrawCollateral(5e18);
        require(stock.balanceOf(TENANT) == 10e18, "COLLATERAL_RETURNED");
        (uint256 shares, uint256 debt,, uint256 ltv, uint256 health) = pool.position(TENANT);
        require(shares == 0 && debt == 0 && ltv == 0 && health == type(uint256).max, "CLOSED_POSITION");
    }

    function testOperatorLiquidityCannotWithdrawBorrowedMoneyAndUnauthorizedCannotSupply() public {
        _depositAndBorrow();
        vm.prank(OTHER);
        vm.expectRevert(TestLendingPool.Unauthorized.selector);
        pool.supply(1e6);
        vm.expectRevert(TestLendingPool.InsufficientLiquidity.selector);
        pool.withdrawLiquidity(9_001e6);
        pool.withdrawLiquidity(9_000e6);
        usd.mint(address(this), 10e6);
        usd.approve(address(pool), 10e6);
        pool.supply(10e6);
        require(usd.balanceOf(address(pool)) == 10e6, "SUPPLIED_LIQUIDITY");
    }

    function testDeploymentRejectsProductionChains() public {
        vm.chainId(1);
        vm.expectRevert();
        new TestLendingPool(address(stock), address(usd), address(oracle), 1_000, 1 days);
    }
}
