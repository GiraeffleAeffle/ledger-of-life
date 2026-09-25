// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RentalEscrow} from "../src/RentalEscrow.sol";
import {IERC20Asset, IMorphoVault} from "../src/MorphoAdapter.sol";

interface ForkVm {
    function envOr(string calldata, bool) external returns (bool);
    function envOr(string calldata, uint256) external returns (uint256);
    function envOr(string calldata, string calldata) external returns (string memory);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
    function prank(address) external;
    function record() external;
    function accesses(address) external returns (bytes32[] memory, bytes32[] memory);
    function load(address, bytes32) external returns (bytes32);
    function store(address, bytes32, bytes32) external;
    function warp(uint256) external;
}

interface TokenMetadata {
    function decimals() external view returns (uint8);
    function uiMultiplier() external view returns (uint256);
}

interface VaultPreview {
    function previewDeposit(uint256) external view returns (uint256);
    function previewRedeem(uint256) external view returns (uint256);
}

/// @notice Opt-in mainnet FORK tests. Only public reads reach Robinhood; balances/time change locally.
contract RobinhoodForkTest {
    ForkVm constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant VAULT = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    address constant STOCK = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant TENANT = address(0xA11CE);
    address constant LANDLORD = address(0xB0B);
    address constant ARBITRATOR = address(0xCAFE);
    uint256 constant BLOCK = 69_695_660;
    uint256 constant DEADLINE = type(uint256).max;
    uint256 sourceBlock;
    RentalEscrow escrow;
    event ForkResult(
        uint256 sourceBlock,
        uint256 shares,
        uint256 eligibleAfterWarp,
        uint256 released,
        uint256 landlordPaid,
        uint256 tenantPaid
    );

    function setUp() public {
        vm.skip(!vm.envOr("ROBINHOOD_FORK_PROOF", false));
        sourceBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", BLOCK);
        vm.createSelectFork(vm.envOr("ROBINHOOD_FORK_RPC", "https://rpc.mainnet.chain.robinhood.com"), sourceBlock);
        _setupPosition();
    }

    function testPinnedRobinhoodDependencies() public view {
        require(block.chainid == 4663 && IMorphoVault(VAULT).asset() == USDG, "WRONG_DEPENDENCIES");
        require(TokenMetadata(USDG).decimals() == 6 && TokenMetadata(VAULT).decimals() == 18, "WRONG_DECIMALS");
        require(TokenMetadata(STOCK).uiMultiplier() > 0, "INVALID_MULTIPLIER");
        if (sourceBlock == BLOCK) {
            require(TokenMetadata(STOCK).uiMultiplier() == 1_001_717_991_187_472_003, "MULTIPLIER_CHANGED");
        }
    }

    function _setupPosition() private {
        escrow = new RentalEscrow(
            RentalEscrow.Config(
                USDG, VAULT, TENANT, LANDLORD, ARBITRATOR, TENANT, 3_000e6, 10_000, true, keccak256("LOCAL FORK POLICY")
            )
        );
        _fixtureTokenBalance(USDG, TENANT, 3_000e6 + 10_000);
        vm.prank(TENANT);
        IERC20Asset(USDG).approve(address(escrow), 3_000e6 + 10_000);
        vm.prank(TENANT);
        escrow.acceptAgreement(0, DEADLINE);
        vm.prank(LANDLORD);
        escrow.acceptAgreement(1, DEADLINE);
        vm.prank(TENANT);
        escrow.fund(2, DEADLINE);
        // Mirror readPlanningHints: largest amount whose same-block round trip keeps the security whole.
        uint256 idle = 3_000e6 + 10_000;
        uint256 supplyAmount = idle;
        uint256 shares;
        bool safe;
        for (uint256 i; i < 64 && supplyAmount > 0; ++i) {
            shares = VaultPreview(VAULT).previewDeposit(supplyAmount);
            if (idle - supplyAmount + VaultPreview(VAULT).previewRedeem(shares) >= 3_000e6) {
                safe = true;
                break;
            }
            --supplyAmount;
        }
        require(safe, "NO_ROUNDING_SAFE_SUPPLY");
        uint256 minShares = shares * 999 / 1000;
        vm.prank(TENANT);
        escrow.supply(supplyAmount, minShares, 3, DEADLINE);
        uint256 actualShares = escrow.trackedShares();
        require(
            actualShares != 0 && IMorphoVault(VAULT).balanceOf(address(escrow)) == actualShares,
            "WRONG_SHARE_OWNER"
        );
    }

    function testPinnedMorphoRoundTripFromRestrictedEscrow() public {
        // setUp executes separately so Morpho V2's per-transaction transient cache is reset.
        uint256 shares = escrow.trackedShares();
        vm.warp(block.timestamp + 90 days); // Synthetic time progression; not a live earning record or quoted yield.
        uint256 available = escrow.releasableEarnings();
        require(available >= 10e6, "FORK_DID_NOT_ACCRUE_TEN_UNITS");
        vm.prank(TENANT);
        escrow.releaseEarnings(10e6, shares, 4, DEADLINE);
        require(escrow.securityValue() >= 3_000e6, "PRINCIPAL_IMPAIRED");
        vm.prank(LANDLORD);
        escrow.proposeClaim(120e6, keccak256("FORK EVIDENCE"), 5, DEADLINE);
        vm.prank(TENANT);
        escrow.acceptClaim(3_000e6, 6, DEADLINE);
        escrow.settle(2_900e6, 7, DEADLINE);
        require(IERC20Asset(USDG).balanceOf(LANDLORD) == 120e6, "CLAIM_NOT_PAID");
        require(IERC20Asset(USDG).balanceOf(TENANT) >= 2_890e6, "TENANT_REFUND_MISSING");
        require(IMorphoVault(VAULT).balanceOf(address(escrow)) == 0, "UNREDEEMED_SHARES");
        emit ForkResult(
            sourceBlock, shares, available, 10e6, escrow.settledLandlordAmount(), escrow.settledTenantAmount()
        );
    }

    function _fixtureTokenBalance(address token, address account, uint256 amount) private {
        vm.record();
        IERC20Asset(token).balanceOf(account);
        (bytes32[] memory reads,) = vm.accesses(token);
        for (uint256 i; i < reads.length; ++i) {
            if (reads[i] == 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) continue;
            bytes32 old = vm.load(token, reads[i]);
            vm.store(token, reads[i], bytes32(amount));
            (bool success, bytes memory result) = token.staticcall(abi.encodeCall(IERC20Asset.balanceOf, (account)));
            if (success && result.length == 32 && abi.decode(result, (uint256)) == amount) return;
            vm.store(token, reads[i], old);
        }
        revert("FORK_TOKEN_BALANCE_SLOT_NOT_FOUND");
    }
}
