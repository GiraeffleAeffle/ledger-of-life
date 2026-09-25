// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {TestUSDG, TestStockDesk, TestPriceOracle} from "../src/testnet/TestnetMarket.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function warp(uint256) external;
}

/// @dev 18-decimal freely mintable stand-in for a stock token (tests only).
contract MockStock {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract CollateralEscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant TENANT = address(0x201);
    address constant LANDLORD = address(0x202);
    address constant ARBITRATOR = address(0x203);
    uint256 constant DEPOSIT = 1_000e6; // $1,000 cash-equivalent deposit
    uint256 constant PRICE = 400e6; // $400 per share

    TestUSDG usd;
    MockStock stock;
    TestPriceOracle oracle;
    TestStockDesk desk;
    CollateralEscrow escrow;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new TestUSDG();
        stock = new MockStock();
        oracle = new TestPriceOracle(PRICE);
        desk = new TestStockDesk(address(usd), address(stock), PRICE);
        for (uint256 i; i < 5; ++i) usd.mint(address(desk), 10_000e6);
        escrow = new CollateralEscrow(
            CollateralEscrow.Config({
                stock: address(stock),
                usd: address(usd),
                oracle: address(oracle),
                sale: address(desk),
                tenant: TENANT,
                landlord: LANDLORD,
                arbitrator: ARBITRATOR,
                depositValue: DEPOSIT,
                initialRatioBps: 15_000,
                maintenanceRatioBps: 12_500,
                maxSlippageBps: 200,
                graceSeconds: 3 days,
                maxOracleAge: 1 days
            })
        );
        stock.mint(TENANT, 10e18);
        vm.prank(TENANT);
        stock.approve(address(escrow), type(uint256).max);
    }

    function _setPrice(uint256 p) private {
        oracle.setPrice(p);
        desk.setPrice(p);
    }

    function _pledge(uint256 shares) private {
        vm.prank(TENANT);
        escrow.pledge(shares, 0);
    }

    function testPledgeMustReachInitialRatioAndOnlyTenantPledges() public {
        vm.prank(TENANT);
        vm.expectRevert(CollateralEscrow.Undercollateralized.selector);
        escrow.pledge(3.7e18, 0); // $1,480 < $1,500
        vm.prank(LANDLORD);
        vm.expectRevert(CollateralEscrow.Unauthorized.selector);
        escrow.pledge(4e18, 0);
        _pledge(3.75e18); // exactly $1,500
        require(escrow.state() == CollateralEscrow.State.Active, "NOT_ACTIVE");
        require(escrow.collateralValue() == 1_500e6, "VALUE");
    }

    function testTenantCanOnlyWithdrawSharesAboveTheInitialRatio() public {
        _pledge(5e18); // $2,000
        vm.prank(TENANT);
        escrow.withdrawExcess(1.25e18); // back to exactly $1,500
        require(stock.balanceOf(TENANT) == 6.25e18, "NOT_RETURNED");
        vm.prank(TENANT);
        vm.expectRevert(CollateralEscrow.Undercollateralized.selector);
        escrow.withdrawExcess(1);
    }

    function testTopUpDuringGraceClearsShortfallWithoutAnySale() public {
        _pledge(3.75e18);
        _setPrice(300e6); // $1,125 < $1,250 maintenance
        escrow.flagShortfall();
        _pledge(0.5e18); // +$150 → $1,275
        require(escrow.shortfallDeadline() == 0, "NOT_CLEARED");
        vm.warp(block.timestamp + 4 days);
        oracle.setPrice(300e6);
        vm.expectRevert(CollateralEscrow.InvalidState.selector);
        escrow.liquidate();
        require(escrow.stockHeld() == 4.25e18 && escrow.cashHeld() == 0, "SOLD");
    }

    function testUncuredShortfallSellsJustEnoughForACashDeposit() public {
        _pledge(3.75e18);
        _setPrice(300e6);
        escrow.flagShortfall();
        vm.expectRevert(CollateralEscrow.GraceActive.selector);
        escrow.liquidate();
        vm.warp(block.timestamp + 3 days);
        oracle.setPrice(300e6);
        escrow.liquidate();
        require(escrow.cashHeld() >= DEPOSIT && escrow.cashHeld() < DEPOSIT + 1e6, "CASH");
        // $1,000 / $300 ≈ 3.3334 shares sold; the rest stays the tenant's.
        require(escrow.stockHeld() > 0.41e18 && escrow.stockHeld() < 0.42e18, "REMAINDER");
    }

    function testAgreedClaimIsPaidInCashAndTheRestReturnsInKind() public {
        _pledge(3.75e18);
        vm.prank(LANDLORD);
        escrow.proposeClaim(120e6);
        vm.prank(TENANT);
        escrow.acceptClaim();
        escrow.settle();
        require(usd.balanceOf(LANDLORD) == 120e6, "LANDLORD");
        // 0.3 shares sold at $400; 3.45 shares come back.
        require(stock.balanceOf(TENANT) == 10e18 - 3.75e18 + 3.45e18, "TENANT_SHARES");
        require(escrow.state() == CollateralEscrow.State.Closed, "OPEN");
    }

    function testDisputeOnlyArbitratorDecidesUpToTheClaim() public {
        _pledge(3.75e18);
        vm.prank(LANDLORD);
        escrow.proposeClaim(200e6);
        vm.prank(TENANT);
        escrow.contestClaim();
        vm.prank(LANDLORD);
        vm.expectRevert(CollateralEscrow.Unauthorized.selector);
        escrow.resolveClaim(200e6);
        vm.prank(ARBITRATOR);
        vm.expectRevert(CollateralEscrow.InvalidAmount.selector);
        escrow.resolveClaim(201e6);
        vm.prank(ARBITRATOR);
        escrow.resolveClaim(80e6);
        escrow.settle();
        require(usd.balanceOf(LANDLORD) == 80e6, "LANDLORD");
    }

    function testStaleOracleAndBadSaleCannotMoveCollateral() public {
        _pledge(3.75e18);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(CollateralEscrow.StaleOracle.selector);
        escrow.collateralValue();
        oracle.setPrice(PRICE);
        desk.setPrice(380e6); // 5 % below the oracle, beyond the 2 % bound
        vm.prank(LANDLORD);
        escrow.proposeClaim(120e6);
        vm.prank(TENANT);
        escrow.acceptClaim();
        vm.expectRevert();
        escrow.settle();
        require(escrow.stockHeld() == 3.75e18, "SOLD_BELOW_BOUND");
    }
}
