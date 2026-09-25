// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RentalEscrow} from "../src/RentalEscrow.sol";
import {TestUSDG, TestYieldVault, TestStockDesk, IStockToken} from "../src/testnet/TestnetMarket.sol";

interface ScriptVm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
}

/// @notice Robinhood Chain TESTNET (46630) rental cycle with test-signer keys:
/// deposit -> test vault -> test yield -> earnings release -> Stock Token purchase -> claim -> settlement.
/// Test USDG, the vault and the desk are test contracts; the Stock Token is Robinhood's official testnet token.
contract RobinhoodTestnetCycle {
    ScriptVm constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant SECURITY = 10e6;
    uint256 constant RESERVE = 10_000;
    uint256 constant DEADLINE = type(uint256).max;

    struct Result {
        address usd;
        address vault;
        address desk;
        address escrow;
        uint256 released;
        uint256 stockBought;
        uint256 landlordPaid;
        uint256 tenantPaid;
    }

    uint256 operatorKey;
    uint256 tenantKey;
    uint256 landlordKey;
    address stock;
    address tenant;
    address landlord;
    address arbitrator;
    TestUSDG usd;
    TestYieldVault vault;
    TestStockDesk desk;
    RentalEscrow escrow;

    function run() external returns (Result memory result) {
        require(block.chainid == 46630 || block.chainid == 31337, "TESTNET_ONLY");
        operatorKey = vm.envUint("RH_OPERATOR_KEY");
        tenantKey = vm.envUint("RH_TENANT_KEY");
        landlordKey = vm.envUint("RH_LANDLORD_KEY");
        stock = vm.envAddress("RH_STOCK_TOKEN");
        tenant = vm.addr(tenantKey);
        landlord = vm.addr(landlordKey);
        arbitrator = vm.addr(vm.envUint("RH_ARBITRATOR_KEY"));
        _deploy(vm.envUint("RH_STOCK_PRICE"), vm.envUint("RH_DESK_INVENTORY"), vm.envOr("RH_GAS_TOPUP", 0.0002 ether));
        _fund();
        (result.released, result.stockBought) = _earnAndInvest(vm.envOr("RH_TEST_YIELD", 500_000));
        uint256 claim = vm.envOr("RH_CLAIM", 2e6);
        _settle(claim);
        result.usd = address(usd);
        result.vault = address(vault);
        result.desk = address(desk);
        result.escrow = address(escrow);
        result.landlordPaid = escrow.settledLandlordAmount();
        result.tenantPaid = escrow.settledTenantAmount();
        require(result.landlordPaid == claim && IStockToken(stock).balanceOf(tenant) >= result.stockBought, "RECONCILE");
    }

    /// @dev `price` is test-USD atomic per whole Stock Token.
    function _deploy(uint256 price, uint256 inventory, uint256 gasTopUp) private {

        // Operator: gas for the three test people, test assets, desk inventory and the escrow.
        vm.startBroadcast(operatorKey);
        for (uint256 i; i < 3; ++i) {
            address to = i == 0 ? tenant : i == 1 ? landlord : arbitrator;
            if (to.balance < gasTopUp) {
                (bool sent,) = payable(to).call{value: gasTopUp}("");
                require(sent, "GAS_TOPUP");
            }
        }
        usd = new TestUSDG();
        vault = new TestYieldVault(address(usd));
        desk = new TestStockDesk(address(usd), stock, price);
        require(IStockToken(stock).transfer(address(desk), inventory), "INVENTORY");
        escrow = new RentalEscrow(
            RentalEscrow.Config(
                address(usd), address(vault), tenant, landlord, arbitrator, tenant, SECURITY, RESERVE, true,
                keccak256("ROBINHOOD TESTNET: 10 tUSDG security, 0.01 rounding reserve, earnings release allowed")
            )
        );
        vm.stopBroadcast();
    }

    function _fund() private {
        vm.startBroadcast(tenantKey);
        usd.mint(tenant, SECURITY + RESERVE);
        usd.approve(address(escrow), SECURITY + RESERVE);
        escrow.acceptAgreement(0, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(landlordKey);
        escrow.acceptAgreement(1, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(tenantKey);
        escrow.fund(2, DEADLINE);
        uint256 idle = SECURITY + RESERVE;
        escrow.supply(idle, vault.previewDeposit(idle), 3, DEADLINE);
        vm.stopBroadcast();
    }

    /// @dev Test yield: real test assets enter the vault and raise the escrow's share value.
    function _earnAndInvest(uint256 yieldAssets) private returns (uint256 released, uint256 bought) {
        vm.startBroadcast(operatorKey);
        usd.mint(vm.addr(operatorKey), yieldAssets);
        usd.approve(address(vault), yieldAssets);
        vault.accrue(yieldAssets);
        vm.stopBroadcast();
        // Earnings release to the tenant's own wallet, then a Stock Token purchase from it.
        vm.startBroadcast(tenantKey);
        released = escrow.releasableEarnings();
        escrow.releaseEarnings(released, type(uint256).max, 4, DEADLINE);
        usd.approve(address(desk), released);
        bought = desk.buy(released, desk.quoteBuy(released));
        vm.stopBroadcast();
    }

    function _settle(uint256 claim) private {
        vm.startBroadcast(landlordKey);
        escrow.proposeClaim(claim, keccak256("ROBINHOOD TESTNET fixture evidence"), 5, DEADLINE);
        vm.stopBroadcast();
        vm.startBroadcast(tenantKey);
        uint256 minimum = escrow.securityValue() - 1;
        escrow.acceptClaim(minimum, 6, DEADLINE);
        escrow.settle(minimum, 7, DEADLINE);
        vm.stopBroadcast();
    }
}
