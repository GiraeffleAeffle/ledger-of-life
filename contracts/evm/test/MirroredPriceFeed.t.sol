// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MirroredPriceFeed} from "../src/testnet/MirroredPriceFeed.sol";
import {MockUSDG} from "./Mocks.sol";

interface VmSharedMarket {
    function prank(address) external;
    function expectRevert() external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract SharedMarketStock is MockUSDG {
    uint256 public uiMultiplier = 1e18;
    function setMultiplier(uint256 multiplier) external { uiMultiplier = multiplier; }
}

contract MirroredPriceFeedTest {
    VmSharedMarket constant vm = VmSharedMarket(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant UPDATER = address(0x501);
    SharedMarketStock stock;
    MirroredPriceFeed feed;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(1_800_000_000);
        stock = new SharedMarketStock();
        feed = new MirroredPriceFeed(UPDATER, address(stock), address(0x502), 4663, 400e8);
    }

    function _push(uint80 round, int256 answer, uint256 time) private {
        vm.prank(UPDATER);
        feed.push(round, answer, time, 1e18);
    }

    function testOnlyUpdaterAndNoInitialUsablePrice() public {
        (uint256 price,) = feed.latestPrice();
        require(price == 0, "uninitialized price");
        vm.expectRevert();
        feed.push(1, 400e8, block.timestamp, 1e18);
        _push(1, 400e8, block.timestamp);
        (price,) = feed.latestPrice();
        require(price == 400e6, "authorized push");
    }

    function testRoundAndSourceTimeStrictlyIncrease() public {
        _push(10, 400e8, block.timestamp);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert();
        _push(10, 400e8, block.timestamp + 1);
        vm.expectRevert();
        _push(9, 400e8, block.timestamp + 1);
        vm.expectRevert();
        _push(11, 400e8, block.timestamp - 1 hours);
        vm.expectRevert();
        _push(11, 400e8, block.timestamp - 1 hours - 1);
        _push(11, 400e8, block.timestamp);
        (uint80 round, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        require(round == 11 && answeredInRound == 11, "source round");
        require(answer == 400e8 && updatedAt == block.timestamp, "source data");
    }

    function testFutureTimeAndAnswerBounds() public {
        vm.expectRevert(); _push(1, 400e8, block.timestamp + 301);
        vm.expectRevert(); _push(1, 0, block.timestamp);
        vm.expectRevert(); _push(1, -1, block.timestamp);
        vm.expectRevert(); _push(1, 1e14 + 1, block.timestamp);
        vm.prank(UPDATER);
        vm.expectRevert(); feed.push(1, 400e8, block.timestamp, 0);
        _push(1, 400e8, block.timestamp + 300);
    }

    function testOneHourIntervalExactBoundaryAndIdleGapBounds() public {
        uint256 start = block.timestamp;
        _push(1, 400e8, start);
        vm.expectRevert(); _push(2, 400e8, start + 1);
        vm.warp(start + 3599);
        vm.expectRevert(); _push(2, 400e8, block.timestamp);
        vm.warp(start + 3600);
        vm.expectRevert(); _push(2, 480e8 + 1, block.timestamp);
        vm.expectRevert(); _push(2, 320e8 - 1, block.timestamp);
        _push(2, 480e8, block.timestamp);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(); _push(3, 576e8 + 1, block.timestamp);
        _push(3, 576e8, block.timestamp);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(); _push(4, 46_080_000_000 - 1, block.timestamp);
        _push(4, 46_080_000_000, block.timestamp);
    }

    function testBootstrapCannotEnableRapidTwentyPercentCompounding() public {
        _push(1, 480e8, block.timestamp); // Initial answer A = 400e8; first push = 1.2 A.
        vm.warp(block.timestamp + 60);
        vm.expectRevert(); _push(2, 320e8, block.timestamp); // 0.8 A.
        vm.warp(block.timestamp + 60);
        vm.expectRevert(); _push(2, 256e8, block.timestamp); // 0.64 A.
        vm.expectRevert(); _push(2, 480e8, block.timestamp); // Even an unchanged answer is rate-limited.
        (uint256 price,) = feed.latestPrice();
        require(price == 480e6, "rejected pushes leave price unchanged");
    }

    function testIdleHourJumpCannotBeFollowedByMinutePushes() public {
        _push(1, 400e8, block.timestamp);
        vm.warp(block.timestamp + 1 hours);
        _push(2, 480e8, block.timestamp);
        uint256 copiedAt = block.timestamp;
        for (uint256 minute = 1; minute < 60; ++minute) {
            vm.warp(copiedAt + minute * 60);
            vm.expectRevert(); _push(3, 480e8, block.timestamp);
            vm.expectRevert(); _push(3, 576e8, block.timestamp);
            vm.expectRevert(); _push(3, 384e8, block.timestamp);
        }
        (uint80 round, int256 answer,,, uint256 pushedAt) = feed.latest();
        require(round == 2 && answer == 480e8 && pushedAt == copiedAt, "minute pushes cannot change observation");
        vm.warp(copiedAt + 3599);
        vm.expectRevert(); _push(3, 480e8, block.timestamp);
        vm.warp(copiedAt + 3600);
        _push(3, 384e8, block.timestamp);
        (uint256 price,) = feed.latestPrice();
        require(price == 384e6, "next full hour permits twenty percent");
    }

    function testBootstrapIsBoundedByDeploymentPinnedAnswer() public {
        vm.expectRevert(); _push(1, 320e8 - 1, block.timestamp);
        vm.expectRevert(); _push(1, 480e8 + 1, block.timestamp);
        _push(1, 480e8, block.timestamp);
        MirroredPriceFeed high = new MirroredPriceFeed(UPDATER, address(stock), address(0x502), 4663, 1e14);
        vm.prank(UPDATER); high.push(1, 1e14, block.timestamp, 1e18);
        vm.expectRevert();
        new MirroredPriceFeed(UPDATER, address(stock), address(0x502), 4663, 0);
    }

    function testDecimalRoundingAndMultiplierMismatch() public {
        _push(1, 35_438_500_099, block.timestamp);
        (uint256 price, uint256 updatedAt) = feed.latestPrice();
        require(feed.decimals() == 8 && price == 354_385_000, "round down");
        require(updatedAt == block.timestamp, "source timestamp");
        stock.setMultiplier(2e18);
        (price, updatedAt) = feed.latestPrice();
        require(price == 0 && updatedAt == block.timestamp, "multiplier invalidates price");
        stock.setMultiplier(1e18);
        (price,) = feed.latestPrice();
        require(price == 354_385_000, "matching multiplier");
    }

    function testConvertedTokenBasisAndSourceVersusCopyTimestamp() public {
        stock.setMultiplier(2e18);
        feed = new MirroredPriceFeed(UPDATER, address(stock), address(0x502), 4663, 700e8);
        uint256 sourceTime = block.timestamp - 1 hours;
        vm.prank(UPDATER);
        feed.push(17, 700e8, sourceTime, 2e18);
        (uint80 round, int256 answer, uint256 updatedAt, uint256 multiplier, uint256 pushedAt) = feed.latest();
        require(round == 17 && answer == 700e8 && multiplier == 2e18, "converted token basis");
        require(updatedAt == sourceTime && pushedAt == block.timestamp, "source and copy times");
        (uint256 price, uint256 priceTime) = feed.latestPrice();
        require(price == 700e6 && priceTime == sourceTime, "token basis price");
        vm.warp(block.timestamp + 2 days);
        (price, priceTime) = feed.latestPrice();
        require(price == 700e6 && priceTime == sourceTime, "time cannot change price");
    }

    function testDeploymentRejectsProductionChain() public {
        vm.chainId(1);
        vm.expectRevert();
        new MirroredPriceFeed(UPDATER, address(stock), address(0x502), 4663, 400e8);
    }
}
