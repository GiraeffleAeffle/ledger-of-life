// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RentalEscrow} from "../src/RentalEscrow.sol";
import {MockUSDG, MockMorphoVault} from "../test/Mocks.sol";

interface LocalVm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external returns (address);
}

/// @notice Only local chain 31337. Public Anvil development keys, never production credentials.
contract LocalProof {
    LocalVm constant vm = LocalVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant TENANT_KEY = 0xA11CE;
    uint256 constant LANDLORD_KEY = 0xB0B;
    uint256 constant ARBITRATOR_KEY = 0xCAFE;
    uint256 constant DEADLINE = type(uint256).max;
    event LocalDeployment(
        address token, address vault, address escrow, address tenant, address landlord, address arbitrator
    );

    function run() external returns (RentalEscrow escrow) {
        require(block.chainid == 31337, "LOCAL_CHAIN_ONLY");
        address tenant = vm.addr(TENANT_KEY);
        address landlord = vm.addr(LANDLORD_KEY);
        address arbitrator = vm.addr(ARBITRATOR_KEY);
        vm.startBroadcast(TENANT_KEY);
        MockUSDG token = new MockUSDG();
        MockMorphoVault vault = new MockMorphoVault(address(token));
        escrow = new RentalEscrow(
            RentalEscrow.Config(
                address(token),
                address(vault),
                tenant,
                landlord,
                arbitrator,
                tenant,
                3_000e6,
                10_000,
                true,
                keccak256("LOCAL FIXTURE: 3000 USDG security plus 0.01 USDG rounding reserve")
            )
        );
        token.mint(tenant, 3_000e6 + 10_000);
        token.approve(address(escrow), 3_000e6 + 10_000);
        escrow.acceptAgreement(0, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(LANDLORD_KEY);
        escrow.acceptAgreement(1, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(TENANT_KEY);
        escrow.fund(2, DEADLINE);
        escrow.supply(3_000e6, 3_000e18, 3, DEADLINE);
        token.mint(address(vault), 10e6); // Explicit synthetic earnings.
        escrow.releaseEarnings(10e6, 10e18, 4, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(LANDLORD_KEY);
        escrow.proposeClaim(120e6, keccak256("LOCAL fixture evidence"), 5, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(TENANT_KEY);
        escrow.acceptClaim(3_000e6, 6, DEADLINE);
        escrow.settle(3_000e6, 7, DEADLINE);
        vm.stopBroadcast();
        require(token.balanceOf(landlord) == 120e6 && token.balanceOf(tenant) == 2_890e6, "LOCAL_RECONCILIATION_FAILED");
        emit LocalDeployment(address(token), address(vault), address(escrow), tenant, landlord, arbitrator);
    }
}
