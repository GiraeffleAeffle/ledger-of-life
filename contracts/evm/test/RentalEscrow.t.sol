// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RentalEscrow} from "../src/RentalEscrow.sol";
import {MorphoAdapter} from "../src/MorphoAdapter.sol";
import {MockUSDG, MockMorphoVault} from "./Mocks.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract RentalEscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant TENANT = address(0x101);
    address constant LANDLORD = address(0x102);
    address constant ARBITRATOR = address(0x103);
    address constant PERSONAL = address(0x104);
    address constant OUTSIDER = address(0x105);
    uint256 constant PRINCIPAL = 3_000e6;
    uint256 constant DEADLINE = type(uint256).max;
    MockUSDG token;
    MockMorphoVault vault;
    RentalEscrow escrow;

    function setUp() public {
        token = new MockUSDG();
        vault = new MockMorphoVault(address(token));
        escrow = _newEscrow(true);
        token.mint(TENANT, PRINCIPAL);
        vm.prank(TENANT);
        token.approve(address(escrow), PRINCIPAL);
    }

    function _newEscrow(bool allowRelease) private returns (RentalEscrow) {
        return new RentalEscrow(
            RentalEscrow.Config(
                address(token),
                address(vault),
                TENANT,
                LANDLORD,
                ARBITRATOR,
                PERSONAL,
                PRINCIPAL,
                0,
                allowRelease,
                keccak256("fictional rental agreement")
            )
        );
    }

    function _fund() private {
        vm.prank(TENANT);
        escrow.acceptAgreement(0, DEADLINE);
        vm.prank(LANDLORD);
        escrow.acceptAgreement(1, DEADLINE);
        vm.prank(TENANT);
        escrow.fund(2, DEADLINE);
    }

    function _invest() private {
        _fund();
        vm.prank(TENANT);
        escrow.supply(PRINCIPAL, 3_000e18, 3, DEADLINE);
    }

    function _claim(uint256 amount) private {
        uint256 operationNonce = escrow.nonce();
        vm.prank(LANDLORD);
        escrow.proposeClaim(amount, keccak256("private evidence digest"), operationNonce, DEADLINE);
    }

    function _eq(uint256 a, uint256 b) private pure {
        require(a == b, "unequal");
    }

    function testWholeFlowAgreementReleaseAndClaim() public {
        _invest();
        token.mint(address(vault), 10e6); // Explicit local interest fixture, not a forecast.
        _eq(escrow.releasableEarnings(), 10e6);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        _eq(token.balanceOf(PERSONAL), 10e6);
        _eq(escrow.securityValue(), PRINCIPAL);
        _eq(escrow.releasableEarnings(), 0);
        _claim(120e6);
        vm.prank(TENANT);
        escrow.acceptClaim(PRINCIPAL, 6, DEADLINE);
        _eq(token.balanceOf(LANDLORD), 0); // Decision is separate from payment.
        vm.prank(OUTSIDER);
        escrow.settle(PRINCIPAL, 7, DEADLINE);
        _eq(token.balanceOf(LANDLORD), 120e6);
        _eq(token.balanceOf(TENANT), 2_880e6);
        _eq(token.balanceOf(PERSONAL), 10e6);
        _eq(uint256(escrow.state()), uint256(RentalEscrow.State.Closed));
        _eq(token.balanceOf(address(escrow)), 0);
        _eq(vault.balanceOf(address(escrow)), 0);
    }

    function testContestedClaimRequiresAssignedArbitratorAndCapsAward() public {
        _invest();
        _claim(150e6);
        vm.prank(TENANT);
        escrow.contestClaim(5, DEADLINE);
        vm.expectRevert(RentalEscrow.Unauthorized.selector);
        vm.prank(OUTSIDER);
        escrow.resolveClaim(120e6, PRINCIPAL, 6, DEADLINE);
        vm.expectRevert(RentalEscrow.InvalidAmount.selector);
        vm.prank(ARBITRATOR);
        escrow.resolveClaim(151e6, PRINCIPAL, 6, DEADLINE);
        vm.prank(ARBITRATOR);
        escrow.resolveClaim(120e6, PRINCIPAL, 6, DEADLINE);
        vm.expectRevert(RentalEscrow.InvalidState.selector);
        vm.prank(TENANT);
        escrow.contestClaim(7, DEADLINE);
        escrow.settle(PRINCIPAL, 7, DEADLINE);
        _eq(token.balanceOf(LANDLORD), 120e6);
        _eq(token.balanceOf(TENANT), 2_880e6);
    }

    function testFundingRequiresBothPartiesAndTenant() public {
        vm.expectRevert(RentalEscrow.InvalidState.selector);
        vm.prank(TENANT);
        escrow.fund(0, DEADLINE);
        vm.prank(TENANT);
        escrow.acceptAgreement(0, DEADLINE);
        vm.expectRevert(RentalEscrow.Unauthorized.selector);
        vm.prank(TENANT);
        escrow.acceptAgreement(1, DEADLINE);
        vm.prank(LANDLORD);
        escrow.acceptAgreement(1, DEADLINE);
        vm.expectRevert(RentalEscrow.Unauthorized.selector);
        vm.prank(OUTSIDER);
        escrow.fund(2, DEADLINE);
        _eq(token.balanceOf(address(escrow)), 0);
    }

    function testReleaseForbiddenByImmutablePolicy() public {
        escrow = _newEscrow(false);
        vm.prank(TENANT);
        token.approve(address(escrow), PRINCIPAL);
        _invest();
        token.mint(address(vault), 10e6);
        _eq(escrow.releasableEarnings(), 0);
        vm.expectRevert(RentalEscrow.ReleaseForbidden.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(1e6, 10e18, 4, DEADLINE);
    }

    function testNoReleaseOfPrincipalOrDirectCashDonation() public {
        _invest();
        token.mint(address(escrow), 10e6);
        _eq(escrow.releasableEarnings(), 0);
        vm.expectRevert(RentalEscrow.InvalidAmount.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
    }

    function testReleaseRejectsReplayAndOverHarvest() public {
        _invest();
        token.mint(address(vault), 10e6);
        vm.expectRevert(RentalEscrow.InvalidAmount.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(11e6, 11e18, 4, DEADLINE);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        vm.expectRevert(RentalEscrow.StaleNonce.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        _eq(token.balanceOf(PERSONAL), 10e6);
    }

    function testIlliquidityRollsBackReleaseAndNonce() public {
        _invest();
        token.mint(address(vault), 10e6);
        vault.setIlliquid(true);
        vm.expectRevert();
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        _eq(escrow.nonce(), 4);
        _eq(escrow.releasedEarnings(), 0);
        _eq(token.balanceOf(PERSONAL), 0);
        vault.setIlliquid(false);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
    }

    function testLossStopsHarvestAndRequiresExplicitSettlementFloor() public {
        _invest();
        token.burn(address(vault), 100e6);
        _eq(escrow.releasableEarnings(), 0);
        _claim(120e6);
        vm.expectRevert(RentalEscrow.InvalidAmount.selector);
        vm.prank(TENANT);
        escrow.acceptClaim(PRINCIPAL, 5, DEADLINE);
        vm.prank(TENANT);
        escrow.acceptClaim(2_900e6, 5, DEADLINE);
        escrow.settle(2_900e6, 6, DEADLINE);
        _eq(token.balanceOf(LANDLORD), 120e6);
        _eq(token.balanceOf(TENANT), 2_780e6);
    }

    function testLossAfterDecisionDoesNotSilentlyChangeSettlement() public {
        _invest();
        _claim(120e6);
        vm.prank(TENANT);
        escrow.acceptClaim(PRINCIPAL, 5, DEADLINE);
        token.burn(address(vault), 1e6);
        vm.expectRevert(RentalEscrow.SettlementBelowMinimum.selector);
        escrow.settle(0, 6, DEADLINE);
        _eq(token.balanceOf(LANDLORD), 0);
        _eq(escrow.nonce(), 6);
        vm.prank(TENANT);
        escrow.contestClaim(6, DEADLINE);
        vm.prank(ARBITRATOR);
        escrow.resolveClaim(120e6, 2_999e6, 7, DEADLINE);
        escrow.settle(2_999e6, 8, DEADLINE);
    }

    function testPendingClaimPreventsReleaseAndSupply() public {
        _invest();
        token.mint(address(vault), 10e6);
        _claim(120e6);
        _eq(escrow.releasableEarnings(), 0);
        vm.expectRevert(RentalEscrow.InvalidState.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(1e6, 1e18, 5, DEADLINE);
        vm.expectRevert(RentalEscrow.InvalidState.selector);
        vm.prank(TENANT);
        escrow.supply(1, 1, 5, DEADLINE);
    }

    function testClaimCannotExceedSecurityOrBeResolvedBeforeContest() public {
        _fund();
        vm.expectRevert(RentalEscrow.InvalidAmount.selector);
        vm.prank(LANDLORD);
        escrow.proposeClaim(PRINCIPAL + 1, keccak256("evidence"), 3, DEADLINE);
        _claim(120e6);
        vm.expectRevert(RentalEscrow.InvalidState.selector);
        vm.prank(ARBITRATOR);
        escrow.resolveClaim(120e6, PRINCIPAL, 4, DEADLINE);
    }

    function testWrongChainExpiredOrUnapprovedRecipientCannotSpend() public {
        _invest();
        token.mint(address(vault), 10e6);
        vm.expectRevert(RentalEscrow.Unauthorized.selector);
        vm.prank(LANDLORD);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        vm.warp(100);
        vm.expectRevert(RentalEscrow.Expired.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, 99);
        vm.chainId(46630);
        vm.expectRevert(RentalEscrow.WrongChain.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
    }

    function testShareSlippageProtectionRevertsAtomically() public {
        _fund();
        vm.expectRevert(MorphoAdapter.ShareLimitExceeded.selector);
        vm.prank(TENANT);
        escrow.supply(PRINCIPAL, 3_001e18, 3, DEADLINE);
        _eq(token.balanceOf(address(escrow)), PRINCIPAL);
        _eq(escrow.nonce(), 3);
        vm.prank(TENANT);
        escrow.supply(PRINCIPAL, 3_000e18, 3, DEADLINE);
        token.mint(address(vault), 10e6);
        vm.expectRevert(MorphoAdapter.ShareLimitExceeded.selector);
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 1, 4, DEADLINE);
        _eq(token.balanceOf(PERSONAL), 0);
        _eq(escrow.nonce(), 4);
    }

    function testVaultCallbackCannotReenter() public {
        _invest();
        token.mint(address(vault), 10e6);
        vault.setReentry(address(escrow), abi.encodeCall(escrow.releaseEarnings, (10e6, 10e18, 4, DEADLINE)));
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        require(!vault.reentrySuccess(), "reentered");
        require(bytes4(vault.reentryResult()) == RentalEscrow.Reentrancy.selector, "wrong reentry error");
    }

    function testNoUnrestrictedExecutionAndNoOutstandingVaultAllowance() public {
        _invest();
        _eq(token.allowance(address(escrow), address(vault)), 0);
        (bool success,) =
            address(escrow).call(abi.encodeWithSignature("execute(address,bytes)", address(token), bytes("")));
        require(!success, "generic call exists");
    }

    function testZeroClaimReturnsAllSecurityAndPostCloseDonationsOnlyToTenant() public {
        _fund();
        _claim(0);
        vm.prank(TENANT);
        escrow.acceptClaim(PRINCIPAL, 4, DEADLINE);
        escrow.settle(0, 5, DEADLINE);
        _eq(token.balanceOf(TENANT), PRINCIPAL);
        token.mint(address(escrow), 1e6);
        vm.expectRevert(RentalEscrow.Unauthorized.selector);
        vm.prank(LANDLORD);
        escrow.returnDonations(0, 6, DEADLINE);
        vm.prank(TENANT);
        escrow.returnDonations(0, 6, DEADLINE);
        _eq(token.balanceOf(TENANT), PRINCIPAL + 1e6);
    }

    function testFuzzReleaseConservesSecurity(uint64 yieldInput, uint64 releaseInput) public {
        uint256 yield = uint256(yieldInput) % 1_000e6 + 1;
        uint256 release = uint256(releaseInput) % yield + 1;
        _invest();
        token.mint(address(vault), yield);
        vm.prank(TENANT);
        escrow.releaseEarnings(release, 3_000e18, 4, DEADLINE);
        require(escrow.securityValue() >= PRINCIPAL, "security impaired");
        _eq(token.balanceOf(PERSONAL), release);
        _eq(escrow.securityValue() + release, PRINCIPAL + yield);
    }
}
