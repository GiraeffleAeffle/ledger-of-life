// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BuildingRevenueDistributor} from "../src/BuildingRevenueDistributor.sol";
import {TestUSDG} from "../src/testnet/TestnetMarket.sol";
import {FictionalCityUnit} from "../src/testnet/FictionalCityUnit.sol";

interface VmBuildingRevenue {
    function prank(address caller) external;
    function expectRevert(bytes4 selector) external;
    function chainId(uint256 id) external;
    function warp(uint256 timestamp) external;
}

contract BuildingCallbackToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public callbackTarget;
    bool public callbackRejected;
    bool public fee;
    bool public fail;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function configure(address callback, bool chargeFee, bool failTransfer) external {
        callbackTarget = callback; fee = chargeFee; fail = failTransfer;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        _move(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (fail) return false;
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += fee ? amount - 1 : amount;
        if (callbackTarget != address(0)) {
            (bool success, bytes memory reason) = callbackTarget.call(abi.encodeWithSelector(BuildingRevenueDistributor.sync.selector));
            callbackRejected = !success && bytes4(reason) == BuildingRevenueDistributor.Reentrancy.selector;
            require(callbackRejected, "reentrant sync must fail");
        }
    }
}

contract BuildingRevenueDistributorTest {
    VmBuildingRevenue private constant vm = VmBuildingRevenue(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xa11ce);
    address private constant BOB = address(0xb0b);
    uint256 private constant WINDOW = 7 days;
    TestUSDG private cash;
    FictionalCityUnit private units;
    BuildingRevenueDistributor private distributor;

    function setUp() public {
        vm.chainId(31337); vm.warp(1_000_000);
        cash = new TestUSDG();
        units = new FictionalCityUnit("Fictional homes", "tHOME", 10_000e18);
        distributor = new BuildingRevenueDistributor(address(cash), address(units), WINDOW);
        require(units.transfer(ALICE, 100e18) && units.transfer(BOB, 100e18), "fixture units");
    }

    function _stake(address account, uint256 amount) private {
        vm.prank(account); require(units.approve(address(distributor), amount), "approve stake");
        vm.prank(account); distributor.stake(amount);
    }

    function _claim(address account) private returns (uint256) {
        vm.prank(account); return distributor.claim();
    }

    function _drop(uint256 amount) private { cash.mint(address(distributor), amount); }

    function _assertScaledAccounting() private view {
        uint256 scale = distributor.rewardScale();
        uint256 ledger = distributor.streamRemainingScaled() + distributor.undistributedScaled() + distributor.rewardRemainderScaled();
        address[2] memory accounts = [ALICE, BOB];
        for (uint256 i; i < 2; ++i) {
            address account = accounts[i];
            ledger += distributor.rewards(account) * scale + distributor.rewardFraction(account)
                + distributor.stakedOf(account) * (distributor.rewardPerUnit() - distributor.rewardPerUnitPaid(account));
        }
        require(distributor.accounted() * scale == ledger, "held == owed + budgets + exact remainders");
        require(cash.balanceOf(address(distributor)) == distributor.accounted() + distributor.pendingRevenue(), "actual custody matches accounting");
    }

    function testFrontRunStakeEarnsOnlyElapsedTimeShareNotRevenueLump() public {
        _stake(ALICE, 1e18);
        _stake(BOB, 9e18); // transient stake placed just before the revenue transfer
        _drop(WINDOW * 10); distributor.sync();
        require(_claim(BOB) == 0, "same-timestamp claim earns zero");
        vm.warp(block.timestamp + 1);
        vm.prank(BOB); require(distributor.exit() == 9, "one second at ninety percent");
        require(cash.balanceOf(BOB) == 9 && distributor.earned(ALICE) == 1, "only ten atomic emitted");
        require(cash.balanceOf(address(distributor)) == WINDOW * 10 - 9, "future stream remains");
        require(units.balanceOf(BOB) == 100e18, "transient principal returned");
        _assertScaledAccounting();
    }

    function testZeroStakerCarryStreamsOverFullWindowNotInstantly() public {
        _drop(10_400); distributor.sync();
        vm.warp(block.timestamp + WINDOW);
        distributor.sync();
        require(distributor.undistributedScaled() == 10_400 * distributor.rewardScale(), "idle emission fully carried");
        _stake(ALICE, 1);
        require(distributor.periodFinish() == block.timestamp + WINDOW && _claim(ALICE) == 0, "new full-window stream");
        vm.warp(block.timestamp + WINDOW / 2);
        uint256 halfway = _claim(ALICE);
        require(halfway >= 5_199 && halfway <= 5_200, "half, not entire carry");
        vm.warp(distributor.periodFinish());
        _claim(ALICE);
        require(cash.balanceOf(ALICE) == 10_400 && cash.balanceOf(address(distributor)) == 0, "exact budget after window");
        _assertScaledAccounting();
    }

    function testStaggeredStakersAccrueOnlyTheirActiveTime() public {
        _stake(ALICE, 1e18); _drop(WINDOW * 4); distributor.sync();
        vm.warp(block.timestamp + WINDOW / 2);
        _stake(BOB, 1e18);
        require(distributor.earned(ALICE) == WINDOW * 2 && distributor.earned(BOB) == 0, "prior half belongs to Alice");
        vm.warp(distributor.periodFinish());
        require(_claim(ALICE) == WINDOW * 3 && _claim(BOB) == WINDOW, "second half split evenly");
        _assertScaledAccounting();
    }

    function testRepeatedDropsExtendStreamUsingOnlyUnstreamedRemainder() public {
        _stake(ALICE, 1e18); _drop(WINDOW * 2); distributor.sync();
        uint256 oldFinish = distributor.periodFinish();
        vm.warp(block.timestamp + WINDOW / 2);
        require(distributor.earned(ALICE) == WINDOW, "first half accrued");
        _drop(WINDOW * 2); distributor.sync();
        require(distributor.periodFinish() == oldFinish + WINDOW / 2, "fresh window on incoming");
        require(distributor.rewardRate() == 3 * distributor.rewardScale(), "leftover plus new revenue streamed");
        require(_claim(ALICE) == WINDOW, "earned part never rescheduled");
        vm.warp(distributor.periodFinish());
        require(_claim(ALICE) == WINDOW * 3 && cash.balanceOf(ALICE) == WINDOW * 4, "all distinct drops conserved");
        _assertScaledAccounting();
    }

    function testZeroIncomingSyncCannotExtendWindowOrRecycleEmissions() public {
        _stake(ALICE, 1); _stake(BOB, 2);
        _drop(10_400); distributor.sync();
        uint256 finish = distributor.periodFinish();
        for (uint256 i; i < 20; ++i) distributor.sync();
        require(_claim(ALICE) == 0 && _claim(BOB) == 0 && distributor.periodFinish() == finish, "no elapsed no payout");
        vm.warp(block.timestamp + 100);
        distributor.sync(); distributor.sync();
        require(distributor.periodFinish() == finish, "sync does not extend");
        _assertScaledAccounting();
        require(distributor.earned(ALICE) + distributor.earned(BOB) <= cash.balanceOf(address(distributor)), "no overallocated rewards");
    }

    function testRateDivisionRemainderFinishesExactSmallRevenueBudget() public {
        _stake(ALICE, 1e18); _drop(10_400); distributor.sync();
        vm.warp(distributor.periodFinish() - 1);
        require(distributor.earned(ALICE) < 10_400, "not complete before end");
        vm.warp(block.timestamp + 1);
        require(_claim(ALICE) == 10_400 && distributor.streamRemainingScaled() == 0, "rate remainder emitted at finish");
        _assertScaledAccounting();
    }

    function testFullExitRecyclesSubAtomicFractionWithoutOrphaningIt() public {
        _stake(ALICE, 1); _stake(BOB, 1); _drop(1); distributor.sync();
        vm.warp(distributor.periodFinish());
        vm.prank(ALICE); require(distributor.exit() == 0, "half atomic cannot transfer");
        require(distributor.rewardFraction(ALICE) == 0 && units.balanceOf(ALICE) == 100e18, "exit fraction recycled and principal returned");
        require(distributor.streamRemainingScaled() == distributor.rewardScale() / 2, "fraction rescheduled, not stranded");
        require(_claim(BOB) == 0, "recycled fraction not paid instantly");
        vm.warp(distributor.periodFinish());
        require(_claim(BOB) == 1 && cash.balanceOf(address(distributor)) == 0, "two halves combine after stream");
        _assertScaledAccounting();
    }

    function testClaimAfterFullUnstakeAndExitRetainWholeRewards() public {
        _stake(ALICE, 2e18); _stake(BOB, 2e18); _drop(WINDOW * 4); distributor.sync();
        vm.warp(block.timestamp + WINDOW / 2);
        vm.prank(ALICE); distributor.unstake(2e18);
        require(distributor.stakedOf(ALICE) == 0 && units.balanceOf(ALICE) == 100e18, "principal returned");
        require(_claim(ALICE) == WINDOW, "whole rewards remain claimable after unstake");
        vm.warp(distributor.periodFinish());
        vm.prank(BOB); require(distributor.exit() == WINDOW * 3, "remaining time goes to Bob");
        require(distributor.totalStaked() == 0 && cash.balanceOf(address(distributor)) == 0, "exit conservation");
        _assertScaledAccounting();
    }

    function testOtherAccountCannotUnstakeOrClaimAnotherStake() public {
        _stake(ALICE, 2e18); _drop(50); distributor.sync(); vm.warp(distributor.periodFinish());
        vm.prank(BOB); vm.expectRevert(BuildingRevenueDistributor.InvalidAmount.selector); distributor.unstake(1);
        require(_claim(BOB) == 0 && _claim(ALICE) == 50, "caller only claims own rewards");
        vm.prank(ALICE); vm.expectRevert(BuildingRevenueDistributor.InvalidAmount.selector); distributor.unstake(3e18);
        vm.prank(ALICE); vm.expectRevert(BuildingRevenueDistributor.InvalidAmount.selector); distributor.stake(0);
    }

    function testReentrantStakeAndExitCallbacksAreBlocked() public {
        BuildingCallbackToken mockUnits = new BuildingCallbackToken(); BuildingCallbackToken mockCash = new BuildingCallbackToken();
        BuildingRevenueDistributor other = new BuildingRevenueDistributor(address(mockCash), address(mockUnits), WINDOW);
        mockUnits.mint(ALICE, 100); vm.prank(ALICE); mockUnits.approve(address(other), 100);
        mockUnits.configure(address(other), false, false);
        vm.prank(ALICE); other.stake(100);
        require(mockUnits.callbackRejected() && other.totalStaked() == 100, "stake callback protected");
        mockCash.mint(address(other), 30); other.sync(); vm.warp(other.periodFinish());
        mockCash.configure(address(other), false, false);
        vm.prank(ALICE); require(other.exit() == 30, "guard spans both exit transfers");
        require(mockCash.callbackRejected() && mockUnits.callbackRejected(), "both callbacks blocked");
        require(mockCash.balanceOf(ALICE) == 30 && mockUnits.balanceOf(ALICE) == 100, "single conserved payout");
    }

    function testFeeOnTransferStakeAndUnstakeAreRefusedAtomically() public {
        BuildingCallbackToken mockUnits = new BuildingCallbackToken();
        BuildingRevenueDistributor other = new BuildingRevenueDistributor(address(cash), address(mockUnits), WINDOW);
        mockUnits.mint(ALICE, 100); vm.prank(ALICE); mockUnits.approve(address(other), 100);
        mockUnits.configure(address(0), true, false);
        vm.prank(ALICE); vm.expectRevert(BuildingRevenueDistributor.TokenBalanceMismatch.selector); other.stake(100);
        require(other.totalStaked() == 0 && mockUnits.balanceOf(ALICE) == 100, "failed stake rollback");
        mockUnits.configure(address(0), false, false); vm.prank(ALICE); other.stake(100);
        mockUnits.configure(address(0), true, false);
        vm.prank(ALICE); vm.expectRevert(BuildingRevenueDistributor.TokenBalanceMismatch.selector); other.unstake(100);
        require(other.stakedOf(ALICE) == 100 && mockUnits.balanceOf(address(other)) == 100, "failed unstake rollback");
    }

    function testPayoutFailureLeavesStreamRewardRetryableAndExitStakeIntact() public {
        BuildingCallbackToken mockCash = new BuildingCallbackToken();
        BuildingRevenueDistributor other = new BuildingRevenueDistributor(address(mockCash), address(units), WINDOW);
        vm.prank(ALICE); units.approve(address(other), 1e18); vm.prank(ALICE); other.stake(1e18);
        mockCash.mint(address(other), 20); other.sync(); vm.warp(other.periodFinish());
        mockCash.configure(address(0), false, true);
        vm.prank(ALICE); vm.expectRevert(BuildingRevenueDistributor.TransferFailed.selector); other.exit();
        require(other.stakedOf(ALICE) == 1e18 && other.earned(ALICE) == 20, "whole exit rolled back");
        mockCash.configure(address(0), true, false);
        vm.prank(ALICE); vm.expectRevert(BuildingRevenueDistributor.TokenBalanceMismatch.selector); other.claim();
        require(other.earned(ALICE) == 20 && mockCash.balanceOf(ALICE) == 0, "fee payout rolled back");
        mockCash.configure(address(0), false, false); vm.prank(ALICE); require(other.exit() == 20, "retry succeeds");
    }

    function testDurationBoundsAndChainGuard() public {
        vm.expectRevert(BuildingRevenueDistributor.InvalidDependencies.selector); new BuildingRevenueDistributor(address(cash), address(units), 3599);
        vm.expectRevert(BuildingRevenueDistributor.InvalidDependencies.selector); new BuildingRevenueDistributor(address(cash), address(units), 30 days + 1);
        new BuildingRevenueDistributor(address(cash), address(units), 1 hours);
        new BuildingRevenueDistributor(address(cash), address(units), 30 days);
        _stake(ALICE, 1e18); _drop(10);
        vm.chainId(1);
        vm.expectRevert(BuildingRevenueDistributor.WrongChain.selector); new BuildingRevenueDistributor(address(cash), address(units), WINDOW);
        vm.expectRevert(BuildingRevenueDistributor.WrongChain.selector); distributor.sync();
        vm.expectRevert(BuildingRevenueDistributor.WrongChain.selector); distributor.stake(1);
        vm.expectRevert(BuildingRevenueDistributor.WrongChain.selector); distributor.unstake(1);
        vm.expectRevert(BuildingRevenueDistributor.WrongChain.selector); distributor.claim();
        vm.expectRevert(BuildingRevenueDistributor.WrongChain.selector); distributor.exit();
        vm.chainId(46630); new BuildingRevenueDistributor(address(cash), address(units), WINDOW);
    }

    function testFuzzExactConservationAcrossTimeDropsAndStakeChanges(uint96 seed) public {
        _stake(ALICE, 1e18); _stake(BOB, 3e18);
        uint256 received; uint256 random = uint256(seed);
        for (uint256 i; i < 24; ++i) {
            random = uint256(keccak256(abi.encode(random, i)));
            vm.warp(block.timestamp + random % 36_000);
            uint256 incoming = random % 1000 + 1; _drop(incoming); received += incoming;
            if (i % 3 == 0) { _claim(ALICE); _claim(BOB); }
            if (i % 4 == 0) { vm.prank(ALICE); distributor.unstake(1e18); _stake(ALICE, 1e18); }
            distributor.sync();
            uint256 held = cash.balanceOf(address(distributor));
            require(cash.balanceOf(ALICE) + cash.balanceOf(BOB) + held == received, "paid + held == received");
            require(distributor.earned(ALICE) + distributor.earned(BOB) <= held, "no overallocated claims");
            require(units.balanceOf(address(distributor)) == distributor.totalStaked(), "stake custody");
            _assertScaledAccounting();
        }
        vm.warp(distributor.periodFinish());
        vm.prank(ALICE); distributor.exit(); vm.prank(BOB); distributor.exit();
        require(cash.balanceOf(ALICE) + cash.balanceOf(BOB) + cash.balanceOf(address(distributor)) == received, "final conservation");
        require(units.balanceOf(ALICE) == 100e18 && units.balanceOf(BOB) == 100e18, "all principal returned");
        _assertScaledAccounting();
    }
}
