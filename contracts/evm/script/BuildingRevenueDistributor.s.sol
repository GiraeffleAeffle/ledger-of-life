// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BuildingRevenueDistributor} from "../src/BuildingRevenueDistributor.sol";

interface BuildingDeployVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
}

/// @notice Dry-run unless Foundry is explicitly invoked with --broadcast.
contract DeployBuildingRevenueDistributor {
    BuildingDeployVm private constant vm = BuildingDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Deployment(uint256 indexed chainId, address indexed distributor, bytes32 runtimeCodeHash, address payoutToken, address unitToken, uint256 rewardDuration);

    function verifyDependencies() public view returns (address payoutToken, address unitToken, uint256 rewardDuration) {
        require(block.chainid == 46630, "ROBINHOOD_TESTNET_ONLY");
        string memory root = vm.projectRoot();
        string memory manifest = vm.readFile(string.concat(root, "/deployments/building-revenue-46630.json"));
        string memory investments = vm.readFile(string.concat(root, "/deployments/local-investments-46630.json"));
        require(vm.parseJsonUint(manifest, ".version") == 3 && vm.parseJsonUint(manifest, ".chainId") == 46630, "MANIFEST_CHAIN_VERSION");
        require(keccak256(bytes(vm.parseJsonString(manifest, ".rewardsSpec.scheme"))) == keccak256("staking_stream_v1"), "REWARDS_SCHEME");
        require(vm.parseJsonUint(manifest, ".rewardsSpec.scale") == 1e36, "REWARD_SCALE");
        rewardDuration = vm.parseJsonUint(manifest, ".rewardDuration");
        require(rewardDuration == 7 days, "REWARD_DURATION");
        require(keccak256(bytes(vm.parseJsonString(manifest, ".status"))) == keccak256("not_deployed"), "ALREADY_DEPLOYED");
        require(vm.parseJsonUint(investments, ".chainId") == 46630, "INVESTMENTS_CHAIN");
        payoutToken = vm.parseJsonAddress(manifest, ".payoutToken");
        unitToken = vm.parseJsonAddress(manifest, ".unitToken");
        require(payoutToken == vm.parseJsonAddress(investments, ".cashAddress"), "PAYOUT_TOKEN_PIN");
        require(unitToken == vm.parseJsonAddress(investments, ".assets.demo-neighbourhood-homes.unitAddress"), "UNIT_TOKEN_PIN");
        bytes32 payoutHash = vm.parseJsonBytes32(manifest, ".dependencyCodeHashes.payoutToken");
        bytes32 unitHash = vm.parseJsonBytes32(manifest, ".dependencyCodeHashes.unitToken");
        require(payoutHash == vm.parseJsonBytes32(investments, ".cashCodeHash") && payoutToken.code.length != 0 && payoutToken.codehash == payoutHash, "PAYOUT_CODE_CHANGED");
        require(unitHash == vm.parseJsonBytes32(investments, ".assets.demo-neighbourhood-homes.unitCodeHash") && unitToken.code.length != 0 && unitToken.codehash == unitHash, "UNIT_CODE_CHANGED");
        require(keccak256(type(BuildingRevenueDistributor).creationCode) == vm.parseJsonBytes32(manifest, ".reviewedArtifacts.BuildingRevenueDistributor.creationHash"), "CREATION_CODE_CHANGED");
    }

    function run() external returns (BuildingRevenueDistributor distributor) {
        (address payoutToken, address unitToken, uint256 rewardDuration) = verifyDependencies();
        vm.startBroadcast();
        distributor = new BuildingRevenueDistributor(payoutToken, unitToken, rewardDuration);
        vm.stopBroadcast();
        emit Deployment(block.chainid, address(distributor), address(distributor).codehash, payoutToken, unitToken, rewardDuration);
    }
}
