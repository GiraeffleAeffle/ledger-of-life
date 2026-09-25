// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CollateralEscrow} from "../src/CollateralEscrow.sol";
import {TestUSDG, TestStockDesk, TestPriceOracle, IStockToken} from "../src/testnet/TestnetMarket.sol";

interface ScriptVm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
}

/// @notice Robinhood Chain TESTNET: a $10 deposit secured by official test TSLA instead of cash.
/// Pledge at 150 % → price drop → shortfall flagged → tenant tops up → $2 claim → settle:
/// landlord paid in test USDG, tenant gets the remaining TSLA back in kind.
contract CollateralTestnetCycle {
    ScriptVm constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Result {
        address escrow;
        address oracle;
        uint256 pledged;
        uint256 toppedUp;
        uint256 landlordPaid;
        uint256 tenantStockBack;
    }

    function run() external returns (Result memory r) {
        require(block.chainid == 46630 || block.chainid == 31337, "TESTNET_ONLY");
        uint256 operatorKey = vm.envUint("RH_OPERATOR_KEY");
        uint256 tenantKey = vm.envUint("RH_TENANT_KEY");
        uint256 landlordKey = vm.envUint("RH_LANDLORD_KEY");
        address tenant = vm.addr(tenantKey);
        address stock = vm.envAddress("RH_STOCK_TOKEN");
        TestUSDG usd = TestUSDG(vm.envAddress("RH_USD"));
        TestStockDesk desk = TestStockDesk(vm.envAddress("RH_DESK"));
        uint256 price = vm.envUint("RH_STOCK_PRICE");

        vm.startBroadcast(operatorKey);
        TestPriceOracle oracle = new TestPriceOracle(price);
        desk.setPrice(price);
        usd.mint(address(desk), 50e6); // cash inventory for forced sales
        CollateralEscrow escrow = new CollateralEscrow(
            CollateralEscrow.Config({
                stock: stock,
                usd: address(usd),
                oracle: address(oracle),
                sale: address(desk),
                tenant: tenant,
                landlord: vm.addr(landlordKey),
                arbitrator: vm.addr(vm.envUint("RH_ARBITRATOR_KEY")),
                depositValue: 10e6,
                initialRatioBps: 15_000,
                maintenanceRatioBps: 12_500,
                maxSlippageBps: 200,
                graceSeconds: 1 days,
                maxOracleAge: 1 days
            })
        );
        // Stock for the test tenant: 150 % of $10 plus a little for the top-up.
        r.pledged = (15e6 * 1e18 + price - 1) / price;
        r.toppedUp = r.pledged / 5;
        require(IStockToken(stock).transfer(tenant, r.pledged + r.toppedUp), "STOCK");
        vm.stopBroadcast();

        vm.startBroadcast(tenantKey);
        _approve(stock, address(escrow), r.pledged + r.toppedUp);
        escrow.pledge(r.pledged, 0);
        vm.stopBroadcast();

        // Test price drop of 25 % pushes the collateral below the 125 % maintenance level.
        vm.startBroadcast(operatorKey);
        oracle.setPrice(price * 3 / 4);
        desk.setPrice(price * 3 / 4);
        escrow.flagShortfall();
        vm.stopBroadcast();

        vm.startBroadcast(tenantKey);
        escrow.pledge(r.toppedUp, 0); // cures the shortfall
        vm.stopBroadcast();

        vm.startBroadcast(landlordKey);
        escrow.proposeClaim(2e6);
        vm.stopBroadcast();
        vm.startBroadcast(tenantKey);
        escrow.acceptClaim();
        uint256 before = IStockToken(stock).balanceOf(tenant);
        escrow.settle();
        vm.stopBroadcast();

        r.escrow = address(escrow);
        r.oracle = address(oracle);
        r.landlordPaid = 2e6;
        r.tenantStockBack = IStockToken(stock).balanceOf(tenant) - before;
        require(uint8(escrow.state()) == uint8(CollateralEscrow.State.Closed), "NOT_CLOSED");
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok, "APPROVE");
    }
}
