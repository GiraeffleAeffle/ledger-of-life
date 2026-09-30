// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FictionalCityUnit} from "../src/testnet/FictionalCityUnit.sol";
import {TestStockDesk, TestUSDG} from "../src/testnet/TestnetMarket.sol";

interface VmCityUnit {
    function prank(address caller) external;
    function expectRevert() external;
    function chainId(uint256 id) external;
}

contract FictionalCityUnitTest {
    VmCityUnit private constant vm = VmCityUnit(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BUYER = address(0xb0b);
    address private constant STRANGER = address(0xbad);

    function testDistinctFixedSuppliesIdentityAndExactConservation() public {
        FictionalCityUnit homes = new FictionalCityUnit("Neighbourhood Homes test units", "tHOME", 10_000e18);
        FictionalCityUnit workshop = new FictionalCityUnit("Neighbourhood Works test units", "tWORK", 10_000e18);
        TestUSDG usd = new TestUSDG();
        TestStockDesk homeDesk = new TestStockDesk(address(usd), address(homes), 1e6);
        TestStockDesk workshopDesk = new TestStockDesk(address(usd), address(workshop), 1e6);
        require(keccak256(bytes(homes.name())) != keccak256(bytes(workshop.name())), "issuer identity");
        require(keccak256(bytes(homes.symbol())) != keccak256(bytes(workshop.symbol())), "unit identity");
        require(homes.issuer() == address(this) && homes.totalSupply() == 10_000e18 && homes.decimals() == 18, "fixed issuance");
        homes.transfer(address(homeDesk), 10_000e18);
        workshop.transfer(address(workshopDesk), 10_000e18);
        usd.mint(BUYER, 3e6);
        vm.prank(BUYER);
        usd.approve(address(homeDesk), 2e6);
        vm.prank(BUYER);
        homeDesk.buy(2e6, 2e18);
        require(homes.balanceOf(BUYER) == 2e18 && homes.balanceOf(address(homeDesk)) == 9_998e18, "unit conservation");
        require(workshop.balanceOf(BUYER) == 0 && workshop.balanceOf(address(workshopDesk)) == 10_000e18, "issuer isolation");
        require(usd.balanceOf(BUYER) == 1e6 && usd.balanceOf(address(homeDesk)) == 2e6, "cash conservation");
        vm.prank(BUYER);
        usd.approve(address(workshopDesk), 1e6);
        vm.prank(BUYER);
        workshopDesk.buy(1e6, 1e18);
        require(workshop.balanceOf(BUYER) == 1e18 && usd.balanceOf(BUYER) == 0, "second issuer trade");
        require(homes.totalSupply() == homes.balanceOf(BUYER) + homes.balanceOf(address(homeDesk)), "fixed home supply");
    }

    function testOnlyAuthorizedTransfersAndProductionGuard() public {
        FictionalCityUnit units = new FictionalCityUnit("Fictional", "tFIC", 10e18);
        vm.expectRevert();
        vm.prank(STRANGER);
        units.transferFrom(address(this), STRANGER, 1e18);
        units.approve(STRANGER, 3e18);
        vm.prank(STRANGER);
        units.transferFrom(address(this), BUYER, 2e18);
        require(units.balanceOf(BUYER) == 2e18 && units.allowance(address(this), STRANGER) == 1e18, "allowance");
        vm.expectRevert();
        vm.prank(STRANGER);
        units.transferFrom(address(this), BUYER, 2e18);
        vm.expectRevert();
        units.transfer(address(0), 1e18);
        vm.chainId(1);
        vm.expectRevert();
        new FictionalCityUnit("Fictional", "tFIC", 1e18);
    }
}
