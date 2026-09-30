// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SharedLendingPool} from "../src/testnet/SharedLendingPool.sol";
import {RentalEscrow} from "../src/RentalEscrow.sol";
import {MockUSDG} from "./Mocks.sol";
import {SharedMarketStock, VmSharedMarket} from "./MirroredPriceFeed.t.sol";

contract SharedPoolOracle {
    uint256 public price = 400e6;
    uint256 public updatedAt;
    constructor() { updatedAt = block.timestamp; }
    function set(uint256 p, uint256 time) external { price = p; updatedAt = time; }
    function latestPrice() external view returns (uint256, uint256) { return (price, updatedAt); }
}

/// @dev Token callback probe for the guard on every nested mutation.
contract SharedPoolCallbackToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public target;
    bytes public payload;
    bool public nestedSuccess;
    bytes public nestedResult;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function arm(address to, bytes memory data) external { target = to; payload = data; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount; balanceOf[to] += amount;
        (nestedSuccess, nestedResult) = target.call(payload);
        return true;
    }
}

contract SharedLendingPoolTest {
    VmSharedMarket constant vm = VmSharedMarket(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant BORROWER = address(0x601);
    address constant OTHER = address(0x602);
    address constant LENDER = address(0x603);
    address constant LIQUIDATOR = address(0x604);
    address constant LANDLORD = address(0x605);
    address constant PERSONAL = address(0x606);
    MockUSDG usd;
    SharedMarketStock stock;
    SharedPoolOracle oracle;
    SharedLendingPool pool;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_000);
        usd = new MockUSDG();
        stock = new SharedMarketStock();
        oracle = new SharedPoolOracle();
        pool = new SharedLendingPool(address(usd), address(stock), address(oracle));
        address[5] memory users = [address(this), BORROWER, OTHER, LENDER, LIQUIDATOR];
        for (uint256 i; i < users.length; ++i) {
            usd.mint(users[i], 100_000e6);
            stock.mint(users[i], 1_000e18);
            vm.prank(users[i]); usd.approve(address(pool), type(uint256).max);
            vm.prank(users[i]); stock.approve(address(pool), type(uint256).max);
        }
        pool.deposit(10_000e6, address(this));
    }

    function _loan(uint256 collateral, uint256 amount) private {
        vm.prank(BORROWER); pool.depositCollateral(collateral);
        vm.prank(BORROWER); pool.borrow(amount);
    }
    function _debt(address user) private view returns (uint256 debt) {
        (, debt,,,,) = pool.position(user);
    }
    function _invariants() private view {
        (uint256 cash, uint256 assets, uint256 borrowed, uint256 utilization,,,,,,) = pool.market();
        require(assets == cash + borrowed && assets == pool.totalAssets(), "asset conservation");
        require(usd.balanceOf(address(pool)) >= cash, "cash backing");
        uint256 collateral = pool.collateralOf(BORROWER) + pool.collateralOf(OTHER);
        require(collateral == pool.totalCollateral(), "collateral sum");
        require(collateral <= stock.balanceOf(address(pool)), "collateral backing");
        require(utilization <= 10_000, "utilization accounting");
    }

    function testFiftyPercentBoundaryAndOnlyBorrowerCanChangePosition() public {
        _loan(5e18, 1_000e6);
        (uint256 collateral, uint256 debt, uint256 value, uint256 ltv, uint256 borrowable, bool fresh) = pool.position(BORROWER);
        require(collateral == 5e18 && debt == 1_000e6 && value == 2_000e6, "position");
        require(ltv == 5000 && borrowable == 0 && fresh, "limits");
        vm.prank(BORROWER); vm.expectRevert(); pool.borrow(1e6);
        vm.prank(BORROWER); vm.expectRevert(); pool.withdrawCollateral(1);
        vm.prank(OTHER); vm.expectRevert(); pool.withdrawCollateral(1);
        vm.prank(OTHER); vm.expectRevert(); pool.borrow(1e6);
        vm.prank(OTHER); vm.expectRevert(); pool.repay(1);
        require(_debt(BORROWER) == debt && pool.collateralOf(BORROWER) == collateral, "unauthorized mutation");
        vm.prank(BORROWER); pool.depositCollateral(1e18);
        vm.prank(BORROWER); pool.borrow(200e6);
        vm.prank(BORROWER); pool.repay(200e6);
        vm.prank(BORROWER); pool.withdrawCollateral(1e18);
        _invariants();
    }

    function testPreviewDonationIsolationAndShareOwnerAuthorization() public {
        uint256 expected = pool.previewDeposit(123e6);
        vm.prank(LENDER); uint256 shares = pool.deposit(123e6, LENDER);
        require(shares == expected, "deposit preview");
        uint256 value = pool.previewRedeem(shares);
        usd.mint(address(pool), 1_000e6);
        require(pool.previewRedeem(shares) == value, "donation reprices shares");
        vm.prank(OTHER); vm.expectRevert(); pool.withdraw(1, OTHER, LENDER);
        vm.prank(OTHER); vm.expectRevert(); pool.redeem(shares, OTHER, LENDER);
        expected = pool.previewWithdraw(23e6);
        vm.prank(LENDER); uint256 burned = pool.withdraw(23e6, LENDER, LENDER);
        require(burned == expected, "withdraw preview");
        shares = pool.balanceOf(LENDER);
        expected = pool.previewRedeem(shares);
        vm.prank(LENDER); uint256 received = pool.redeem(shares, LENDER, LENDER);
        require(received == expected && pool.balanceOf(LENDER) == 0, "redeem preview");
        _invariants();
    }

    function testInterestToSecondRemainderAndLenderConservation() public {
        vm.prank(LENDER); pool.deposit(10_000e6, LENDER);
        vm.prank(OTHER); pool.deposit(10_000e6, OTHER);
        _loan(10e18, 1_000e6);
        uint256 initial = pool.totalAssets();
        vm.warp(block.timestamp + 365 days);
        uint256 annualDebt = _debt(BORROWER);
        require(annualDebt >= 1_051_271_094 && annualDebt <= 1_051_271_098, "continuous annual interest");
        require(pool.totalAssets() - initial == annualDebt - 1_000e6, "interest conservation");
        uint256 a = pool.previewRedeem(pool.balanceOf(address(this)));
        uint256 b = pool.previewRedeem(pool.balanceOf(LENDER));
        uint256 c = pool.previewRedeem(pool.balanceOf(OTHER));
        require(a == b && b == c, "pro rata interest");
        require(pool.totalAssets() - (a + b + c) <= 3, "lender rounding");
        vm.prank(BORROWER); pool.repay(annualDebt - 1_000e6);
        vm.warp(block.timestamp + 1);
        uint256 beforePartial = _debt(BORROWER);
        vm.prank(BORROWER); pool.repay(1);
        uint256 afterPartial = _debt(BORROWER);
        require(beforePartial >= afterPartial && beforePartial - afterPartial <= 1, "repayment rounds for pool");
        vm.warp(block.timestamp + 1);
        require(_debt(BORROWER) == afterPartial + 2, "fractional interest carry");
        _invariants();
    }

    function testLiquidationThresholdCloseFactorAndBonus() public {
        _loan(5e18, 1_000e6);
        vm.prank(LIQUIDATOR); vm.expectRevert(); pool.liquidate(BORROWER, 400e6);
        oracle.set(250e6 + 1, block.timestamp);
        vm.prank(LIQUIDATOR); vm.expectRevert(); pool.liquidate(BORROWER, 400e6);
        oracle.set(250e6, block.timestamp);
        vm.prank(LIQUIDATOR); (uint256 paid, uint256 seized) = pool.liquidate(BORROWER, type(uint256).max);
        require(paid == 500e6 && seized == 2.2e18, "close factor and bonus");
        require(_debt(BORROWER) == 500e6 && pool.collateralOf(BORROWER) == 2.8e18, "liquidation accounting");
        require(stock.balanceOf(LIQUIDATOR) == 1_000e18 + seized, "seized transfer");
        _invariants();
    }

    function testCrashCollateralCapAndBadDebtLoss() public {
        _loan(5e18, 1_000e6);
        oracle.set(110e6, block.timestamp);
        uint256 beforeAssets = pool.totalAssets();
        vm.prank(LIQUIDATOR); (uint256 paid, uint256 seized) = pool.liquidate(BORROWER, type(uint256).max);
        require(paid == 500e6 && seized == 5e18, "collateral capped exact bonus");
        require(pool.collateralOf(BORROWER) == 0 && _debt(BORROWER) == 0, "bad debt closed");
        require(beforeAssets - pool.totalAssets() == 1_000e6 - paid, "exact writeoff loss");
        require(pool.previewRedeem(pool.balanceOf(address(this))) < beforeAssets, "lender bears loss");
        _invariants();
    }

    function testSevereCrashDustIsSeizedAndDebtImmediatelyWrittenOff() public {
        RentalEscrow escrow = _escrow(1_500e6);
        _loan(5e18, 1_000e6);
        uint256 beforeAssets = pool.totalAssets();
        uint256 beforeSecurity = escrow.securityValue();
        oracle.set(100e6, block.timestamp);
        vm.prank(LIQUIDATOR);
        (uint256 paid, uint256 seized) = pool.liquidate(BORROWER, type(uint256).max);
        require(paid == 454_545_454 && paid < 500e6, "collateral limits repayment");
        require(seized == 5e18 && pool.collateralOf(BORROWER) == 0, "no stranded dust");
        require(_debt(BORROWER) == 0, "uncollectible debt written off");
        require(beforeAssets - pool.totalAssets() == 1_000e6 - paid, "exact bad debt loss");
        require(escrow.securityValue() < beforeSecurity && escrow.releasableEarnings() == 0, "escrow recognizes loss");
        uint256 assets = pool.totalAssets();
        vm.warp(block.timestamp + 365 days);
        require(pool.totalAssets() == assets, "written off debt cannot accrue");
        _invariants();
    }

    function testUtilizationBoundaryAndCashLimitedWithdrawals() public {
        _loan(100e18, 9_000e6);
        vm.prank(BORROWER); vm.expectRevert(); pool.borrow(1e6);
        require(pool.maxWithdraw(address(this)) == 1_000e6, "cash max withdraw");
        vm.expectRevert(); pool.withdraw(1_000e6 + 1, address(this), address(this));
        pool.withdraw(1_000e6, address(this), address(this));
        require(pool.cash() == 0, "cash withdrawn");
        vm.prank(BORROWER); pool.repay(1_000e6);
        require(pool.cash() == 1_000e6, "repayment cash");
        _invariants();
    }

    function testStalePriceFreezesOnlyRiskIncreasingActions() public {
        _loan(5e18, 1_000e6);
        vm.warp(block.timestamp + 4 days);
        (,,,,, bool fresh) = pool.position(BORROWER);
        require(!fresh, "stale position view");
        (,,,,,,,, fresh,) = pool.market();
        require(!fresh, "stale market view");
        vm.prank(BORROWER); vm.expectRevert(); pool.borrow(1e6);
        vm.prank(BORROWER); vm.expectRevert(); pool.withdrawCollateral(1);
        vm.prank(LIQUIDATOR); vm.expectRevert(); pool.liquidate(BORROWER, 1);
        vm.prank(LENDER); pool.deposit(100e6, LENDER);
        vm.prank(LENDER); pool.withdraw(10e6, LENDER, LENDER);
        vm.prank(BORROWER); pool.depositCollateral(1e18);
        vm.prank(BORROWER); pool.repay(type(uint256).max);
        vm.prank(BORROWER); pool.withdrawCollateral(6e18);
        require(pool.collateralOf(BORROWER) == 0 && _debt(BORROWER) == 0, "stale exit");
        _invariants();
    }

    function testWeekendSixtyHourPriceAndWednesdayRejection() public {
        // Day zero (1970-01-01) was Thursday: day 3 is Sunday, day 6 Wednesday.
        vm.warp((21_000 / 7 * 7 + 3) * 1 days + 12 hours);
        oracle.set(400e6, block.timestamp - 60 hours);
        _loan(5e18, 1_000e6);
        (,,,,, bool fresh) = pool.position(BORROWER);
        require(fresh, "Sunday tier");
        vm.warp(block.timestamp + 3 days);
        oracle.set(400e6, block.timestamp - 60 hours);
        (,,,,, fresh) = pool.position(BORROWER);
        require(!fresh, "Wednesday tier");
        vm.prank(BORROWER); vm.expectRevert(); pool.borrow(1e6);
    }

    function testFreshnessBoundariesMondayNoonAndInvalidPrice() public {
        uint256 monday = (21_000 / 7 * 7 + 4) * 1 days;
        vm.warp(monday + 12 hours - 1);
        oracle.set(400e6, block.timestamp - 74 hours);
        (,,,,, bool fresh) = pool.position(BORROWER);
        require(fresh, "74h inclusive before Monday noon");
        oracle.set(400e6, block.timestamp - 74 hours - 1);
        (,,,,, fresh) = pool.position(BORROWER);
        require(!fresh, "74h exclusive overflow");
        vm.warp(monday + 12 hours);
        oracle.set(400e6, block.timestamp - 26 hours);
        (,,,,, fresh) = pool.position(BORROWER);
        require(fresh, "26h inclusive Monday noon");
        oracle.set(400e6, block.timestamp - 26 hours - 1);
        (,,,,, fresh) = pool.position(BORROWER);
        require(!fresh, "26h overflow");
        oracle.set(0, block.timestamp);
        (,,,,, fresh) = pool.position(BORROWER);
        require(!fresh, "zero price invalid");
        oracle.set(400e6, block.timestamp + 1);
        (,,,,, fresh) = pool.position(BORROWER);
        require(!fresh, "future source invalid");
    }

    function _escrow(uint256 principal) private returns (RentalEscrow escrow) {
        escrow = new RentalEscrow(RentalEscrow.Config(address(usd), address(pool), OTHER, LANDLORD, address(0x607), PERSONAL, principal, 0, true, keccak256("shared pool rental")));
        vm.prank(OTHER); usd.approve(address(escrow), principal);
        vm.prank(OTHER); escrow.acceptAgreement(0, type(uint256).max);
        vm.prank(LANDLORD); escrow.acceptAgreement(1, type(uint256).max);
        vm.prank(OTHER); escrow.fund(2, type(uint256).max);
        uint256 preview = pool.previewDeposit(principal);
        vm.prank(OTHER); escrow.supply(principal, preview, 3, type(uint256).max);
    }

    function testRentalEscrowRealInterestReleaseAndSettlementAfterRepay() public {
        RentalEscrow escrow = _escrow(1_500e6);
        _loan(10e18, 1_000e6);
        vm.warp(block.timestamp + 365 days);
        uint256 earnings = escrow.releasableEarnings();
        uint256 expected = (_debt(BORROWER) - 1_000e6) * 1_500 / 11_500;
        require(earnings <= expected && expected - earnings <= 1, "escrow pro rata interest");
        vm.prank(OTHER); vm.expectRevert(); escrow.releaseEarnings(earnings + 1, type(uint256).max, 4, type(uint256).max);
        uint256 releaseShares = pool.previewWithdraw(earnings);
        vm.prank(OTHER); escrow.releaseEarnings(earnings, releaseShares, 4, type(uint256).max);
        require(usd.balanceOf(PERSONAL) == earnings && escrow.securityValue() >= 1_500e6, "principal protected");
        vm.prank(BORROWER); pool.repay(type(uint256).max);
        vm.prank(LANDLORD); escrow.proposeClaim(0, keccak256("no damage"), 5, type(uint256).max);
        vm.prank(OTHER); escrow.acceptClaim(1_500e6, 6, type(uint256).max);
        uint256 beforeBalance = usd.balanceOf(OTHER);
        escrow.settle(1_500e6, 7, type(uint256).max);
        require(usd.balanceOf(OTHER) - beforeBalance >= 1_500e6, "principal settlement");
        require(pool.balanceOf(address(escrow)) == 0 && uint256(escrow.state()) == uint256(RentalEscrow.State.Closed), "settlement closed");
    }

    function testRentalEscrowIlliquidityRollsBackReleaseAndNonce() public {
        RentalEscrow escrow = _escrow(1_500e6);
        _loan(100e18, 10_350e6);
        pool.withdraw(pool.maxWithdraw(address(this)), address(this), address(this));
        require(pool.cash() == 0, "cash exhausted by lender");
        vm.warp(block.timestamp + 365 days);
        uint256 earnings = escrow.releasableEarnings();
        uint256 shares = pool.balanceOf(address(escrow));
        vm.prank(OTHER); vm.expectRevert(); escrow.releaseEarnings(earnings, type(uint256).max, 4, type(uint256).max);
        require(escrow.nonce() == 4 && escrow.releasedEarnings() == 0 && usd.balanceOf(PERSONAL) == 0, "release rollback");
        require(pool.balanceOf(address(escrow)) == shares, "shares rollback");
        vm.prank(BORROWER); pool.repay(type(uint256).max);
        vm.prank(OTHER); escrow.releaseEarnings(earnings, type(uint256).max, 4, type(uint256).max);
        require(escrow.securityValue() >= 1_500e6, "principal preserved after liquidity returns");
    }

    function testFuzzSequencePreservesAccounting(uint256 seed) public {
        _loan(20e18, 1_000e6);
        for (uint256 i; i < 32; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = seed % 20e6 + 1;
            uint256 action = seed % 11;
            if (action == 0) { vm.prank(LENDER); pool.deposit(amount, LENDER); }
            else if (action == 1 && pool.maxWithdraw(LENDER) >= amount) { vm.prank(LENDER); pool.withdraw(amount, LENDER, LENDER); }
            else if (action == 2) { vm.prank(BORROWER); pool.depositCollateral(amount * 1e12); }
            else if (action == 3 && _debt(BORROWER) != 0) { vm.prank(BORROWER); pool.repay(amount); }
            else if (action == 4) {
                (,,,, uint256 available, bool fresh) = pool.position(BORROWER);
                if (fresh && amount >= 1e6 && available >= amount && pool.cash() >= amount) {
                    vm.prank(BORROWER); pool.borrow(amount);
                    (,,, uint256 utilization,,,,,,) = pool.market();
                    require(utilization <= 9000, "borrow utilization cap");
                }
            } else if (action == 5) {
                uint256 beforeAssets = pool.totalAssets();
                uint256 beforeDebt = _debt(BORROWER);
                vm.warp(block.timestamp + seed % 3600 + 1);
                require(pool.totalAssets() - beforeAssets == _debt(BORROWER) - beforeDebt, "interest conserved");
                oracle.set(400e6, block.timestamp);
            } else if (action == 6) {
                uint256 value = pool.previewRedeem(pool.balanceOf(LENDER));
                usd.mint(address(pool), amount);
                require(pool.previewRedeem(pool.balanceOf(LENDER)) == value, "donation isolation");
            } else if (action == 7) {
                oracle.set(400e6, block.timestamp - 75 hours);
                vm.prank(BORROWER); vm.expectRevert(); pool.borrow(1e6);
                vm.prank(BORROWER); vm.expectRevert(); pool.withdrawCollateral(1);
                vm.prank(LIQUIDATOR); vm.expectRevert(); pool.liquidate(BORROWER, 1);
                oracle.set(400e6, block.timestamp);
            } else if (action == 8) {
                vm.prank(LIQUIDATOR); vm.expectRevert(); pool.liquidate(BORROWER, amount);
            } else if (action == 9) {
                vm.prank(BORROWER); pool.withdrawCollateral(1);
            } else {
                uint256 shares = pool.balanceOf(LENDER);
                vm.prank(OTHER); vm.expectRevert(); pool.withdraw(1, OTHER, LENDER);
                require(pool.balanceOf(LENDER) == shares, "share ownership");
            }
            _invariants();
        }
        require(pool.borrowerCount() == 1 && pool.borrowerAt(0) == BORROWER, "append only borrowers");
    }

    function testSmallMultiBorrowerRepaymentNeverErasesOthersDebt() public {
        _loan(1e18, 1e6);
        vm.prank(OTHER); pool.depositCollateral(1e18);
        vm.prank(OTHER); pool.borrow(1e6);
        vm.prank(LENDER); pool.depositCollateral(1e18);
        vm.prank(LENDER); pool.borrow(1e6);
        vm.warp(block.timestamp + 211);
        require(pool.totalAssets() == 10_000e6 + 1, "one atomic interest");
        vm.prank(BORROWER); pool.repay(1);
        vm.prank(OTHER); pool.repay(type(uint256).max);
        vm.prank(BORROWER); pool.repay(type(uint256).max);
        require(_debt(LENDER) >= 1e6, "other borrower debt erased");
        vm.prank(LENDER); uint256 paid = pool.repay(type(uint256).max);
        require(paid >= 1e6 && _debt(LENDER) == 0 && pool.totalBorrowAssets() == 0, "last borrower can repay");
    }

    function testAllMutationsRejectTokenCallbackReentrancy() public {
        SharedPoolCallbackToken callback = new SharedPoolCallbackToken();
        SharedLendingPool guarded = new SharedLendingPool(address(callback), address(stock), address(oracle));
        callback.mint(address(this), 9);
        callback.approve(address(guarded), 9);
        bytes[9] memory calls = [
            abi.encodeCall(guarded.deposit, (1, address(this))),
            abi.encodeCall(guarded.withdraw, (1, address(this), address(this))),
            abi.encodeCall(guarded.redeem, (1, address(this), address(this))),
            abi.encodeCall(guarded.depositCollateral, (1)),
            abi.encodeCall(guarded.withdrawCollateral, (1)),
            abi.encodeCall(guarded.borrow, (1)),
            abi.encodeCall(guarded.repay, (1)),
            abi.encodeCall(guarded.liquidate, (BORROWER, 1)),
            abi.encodeCall(guarded.realizeBadDebt, (BORROWER))
        ];
        for (uint256 i; i < calls.length; ++i) {
            callback.arm(address(guarded), calls[i]);
            guarded.deposit(1, address(this));
            require(!callback.nestedSuccess(), "token reentered");
            require(bytes4(callback.nestedResult()) == SharedLendingPool.Reentrancy.selector, "missing mutation guard");
        }
        require(guarded.cash() == 9 && guarded.totalAssets() == 9, "outer deposit accounting");
    }

    function testBadDebtCannotEraseCollateralBackedLoanAndBorrowersRemainListed() public {
        _loan(5e18, 1_000e6);
        vm.prank(OTHER); vm.expectRevert(); pool.realizeBadDebt(BORROWER);
        require(_debt(BORROWER) == 1_000e6, "protected debt");
        vm.prank(BORROWER); pool.repay(type(uint256).max);
        vm.prank(BORROWER); pool.borrow(100e6);
        require(pool.borrowerCount() == 1 && pool.borrowerAt(0) == BORROWER, "no duplicate borrowers");
    }

    function testContinuousInterestIndependentOfPermissionlessAccrualFrequency() public {
        _loan(10e18, 1_000e6);
        SharedLendingPool frequent = new SharedLendingPool(address(usd), address(stock), address(oracle));
        usd.approve(address(frequent), type(uint256).max);
        frequent.deposit(10_000e6, address(this));
        vm.prank(BORROWER); stock.approve(address(frequent), type(uint256).max);
        vm.prank(BORROWER); frequent.depositCollateral(10e18);
        vm.prank(BORROWER); frequent.borrow(1_000e6);
        uint256 start = block.timestamp;
        for (uint256 day = 1; day <= 365; ++day) {
            vm.warp(start + day * 1 days);
            frequent.deposit(1, address(this));
        }
        uint256 annual = _debt(BORROWER);
        (, uint256 daily,,,,) = frequent.position(BORROWER);
        uint256 difference = annual > daily ? annual - daily : daily - annual;
        require(difference <= 1, "accrual frequency changes interest");
        require(annual >= 1_051_271_094 && annual <= 1_051_271_098, "exp nominal 5 percent");
        (,,,, uint256 nominal,,,,, uint256 effective) = pool.market();
        require(nominal == 500 && effective == 513, "APR versus effective APY disclosure");
    }

    function testMinimumBorrowAndBoundedBorrowerPagination() public {
        vm.prank(BORROWER); pool.depositCollateral(1e18);
        vm.prank(BORROWER); vm.expectRevert(); pool.borrow(1e6 - 1);
        vm.prank(BORROWER); pool.borrow(1e6);
        vm.prank(OTHER); pool.depositCollateral(1e18);
        vm.prank(OTHER); pool.borrow(1e6);
        address[] memory first = pool.borrowersPage(0, 1);
        require(first.length == 1 && first[0] == BORROWER, "first page");
        address[] memory second = pool.borrowersPage(1, 100);
        require(second.length == 1 && second[0] == OTHER, "bounded last page");
        require(pool.borrowersPage(2, 100).length == 0, "past end");
        require(pool.borrowersPage(type(uint256).max, 1).length == 0, "overflow safe start");
        require(pool.borrowersPage(0, 0).length == 0, "empty count");
        vm.expectRevert(); pool.borrowersPage(0, 101);
    }

    function testIssuerBurnReportedAsCollateralShortfall() public {
        _loan(5e18, 1_000e6);
        require(!pool.collateralShortfall(), "initial backing");
        stock.burn(address(pool), 1);
        require(pool.collateralShortfall(), "issuer burn shortfall visible");
        require(pool.collateralOf(BORROWER) == 5e18 && pool.totalCollateral() == 5e18, "issuer risk not disguised");
    }

    function testZeroRealizableCollateralDebtPermissionlesslyWrittenOff() public {
        oracle.set(1e12, block.timestamp);
        _loan(2e12, 1e6);
        oracle.set(1, block.timestamp - 75 hours);
        vm.prank(OTHER); vm.expectRevert(); pool.realizeBadDebt(BORROWER);
        require(_debt(BORROWER) == 1e6, "stale cannot erase debt");
        oracle.set(1, block.timestamp);
        uint256 beforeAssets = pool.totalAssets();
        vm.prank(OTHER); pool.realizeBadDebt(BORROWER);
        require(_debt(BORROWER) == 0 && beforeAssets - pool.totalAssets() == 1e6, "dust debt realized");
        require(pool.collateralOf(BORROWER) == 2e12, "dust retained for borrower");
        vm.prank(BORROWER); pool.withdrawCollateral(2e12);
        _invariants();
    }

    function testZeroCollateralCapLiquidationWritesOffWithoutRepayment() public {
        _loan(1e16, 1e6);
        oracle.set(1, block.timestamp);
        uint256 beforeAssets = pool.totalAssets();
        uint256 liquidatorStock = stock.balanceOf(LIQUIDATOR);
        vm.prank(LIQUIDATOR);
        (uint256 repaid, uint256 seized) = pool.liquidate(BORROWER, 1e6);
        require(repaid == 0 && seized == 1e16, "zero realizable cap");
        require(stock.balanceOf(LIQUIDATOR) == liquidatorStock + seized, "dust seized");
        require(pool.collateralOf(BORROWER) == 0 && _debt(BORROWER) == 0, "zero cap bad debt cleared");
        require(beforeAssets - pool.totalAssets() == 1e6, "zero cap lender loss");
        _invariants();
    }

    function testNoAdministrativeOrGenericExecutionSurfaceAndChainGuard() public {
        bytes[5] memory calls = [abi.encodeWithSignature("setPrice(uint256)", 1), abi.encodeWithSignature("pause()"), abi.encodeWithSignature("withdrawLiquidity(uint256)", 1), abi.encodeWithSignature("setOwner(address)", OTHER), abi.encodeWithSignature("execute(address,bytes)", address(usd), bytes(""))];
        for (uint256 i; i < calls.length; ++i) { (bool ok,) = address(pool).call(calls[i]); require(!ok, "admin surface"); }
        vm.chainId(1);
        vm.expectRevert(); new SharedLendingPool(address(usd), address(stock), address(oracle));
    }
}
