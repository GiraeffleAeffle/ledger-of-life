// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FakeTestTSLA} from "../src/testnet/FakeTestTSLA.sol";
import {TestStockDesk, TestUSDG} from "../src/testnet/TestnetMarket.sol";

interface VmFakeStock {
    function prank(address caller) external;
    function expectRevert() external;
    function chainId(uint256 id) external;
}

contract FakeTestTSLATest {
    VmFakeStock private constant vm = VmFakeStock(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BUYER = address(0xb0b);
    address private constant RECEIVER = address(0xabc);

    function testFakeStockDeskPurchaseAndOwnerApprovedTransfer() public {
        FakeTestTSLA stock = new FakeTestTSLA();
        TestUSDG usd = new TestUSDG();
        TestStockDesk desk = new TestStockDesk(address(usd), address(stock), 400e6);
        stock.mint(address(desk), 1_000e18);
        usd.mint(BUYER, 3_600e6);

        vm.prank(BUYER);
        usd.approve(address(desk), 3_600e6);
        vm.prank(BUYER);
        desk.buy(3_600e6, 9e18);
        require(stock.balanceOf(BUYER) == 9e18, "fake stock not bought");
        require(usd.balanceOf(BUYER) == 0, "test USD not spent");

        vm.prank(BUYER);
        stock.approve(RECEIVER, 4e18);
        vm.prank(RECEIVER);
        stock.transferFrom(BUYER, RECEIVER, 4e18);
        require(stock.balanceOf(BUYER) == 5e18 && stock.balanceOf(RECEIVER) == 4e18, "owner-approved transfer changed balances");
        require(stock.allowance(BUYER, RECEIVER) == 0, "approval not consumed");
    }

    function testMintCapAndProductionChainGuard() public {
        FakeTestTSLA stock = new FakeTestTSLA();
        vm.expectRevert();
        stock.mint(BUYER, 1_001e18);
        stock.mint(BUYER, 1_000e18);
        require(stock.balanceOf(BUYER) == 1_000e18, "mint cap changed");
        vm.chainId(1);
        vm.expectRevert();
        new FakeTestTSLA();
    }
}
