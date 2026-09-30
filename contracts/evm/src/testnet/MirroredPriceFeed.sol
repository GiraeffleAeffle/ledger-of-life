// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IScaledStock { function uiMultiplier() external view returns (uint256); }

/// @notice TESTNET ONLY. A key's bounded copy of mainnet data, NOT a Chainlink contract.
/// @dev The updater converts the mainnet answer to the test token's multiplier.
/// `sourceMultiplier` is the TEST token multiplier used for that conversion.
/// At most one push per hour, each within 20% of the previous price.
/// The mirror may lag the source by up to an hour.
contract MirroredPriceFeed {
    address public immutable updater;
    address public immutable stock;
    address public immutable sourceFeed;
    uint256 public immutable sourceChainId;
    uint256 public immutable initialAnswer;
    uint256 public constant MAX_STEP_BPS = 2_000;
    uint256 public constant MIN_PUSH_INTERVAL = 1 hours;
    uint256 public constant WINDOW = 1 hours;
    uint8 public constant decimals = 8;
    string public constant description = "RHTSLA/USD from Robinhood Chain mainnet Chainlink, converted to the test token's multiplier - not a Chainlink contract";
    uint80 private round;
    int256 private lastAnswer;
    uint256 private updated;
    uint256 private multiplier;
    uint256 private copied;
    uint256 private entered = 1;
    error Unauthorized();
    error InvalidRound();
    error InvalidTimestamp();
    error InvalidAnswer();
    error StepTooLarge();
    error InvalidMultiplier();
    error Reentrancy();
    error PushTooSoon();
    event Mirrored(uint80 indexed sourceRoundId, int256 answer, uint256 sourceUpdatedAt, uint256 sourceMultiplier, uint256 pushedAt);

    constructor(address updater_, address stock_, address sourceFeed_, uint256 sourceChainId_, uint256 initialAnswer_) {
        if (block.chainid != 46630 && block.chainid != 31337) revert("TESTNET_ONLY");
        require(updater_ != address(0) && stock_ != address(0) && sourceFeed_ != address(0) && sourceChainId_ != 0, "ZERO_PARAMETER");
        if (initialAnswer_ == 0 || initialAnswer_ > 1e14) revert InvalidAnswer();
        initialAnswer = initialAnswer_;
        updater = updater_; stock = stock_; sourceFeed = sourceFeed_; sourceChainId = sourceChainId_;
    }
    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2; _; entered = 1;
    }
    function push(uint80 sourceRoundId, int256 answer, uint256 sourceUpdatedAt, uint256 sourceMultiplier) external nonReentrant {
        if (msg.sender != updater) revert Unauthorized();
        if (sourceRoundId <= round) revert InvalidRound();
        if (sourceUpdatedAt <= updated || sourceUpdatedAt > block.timestamp + 5 minutes) revert InvalidTimestamp();
        if (answer <= 0 || answer > 1e14) revert InvalidAnswer();
        if (sourceMultiplier == 0) revert InvalidMultiplier();
        uint256 baseline = initialAnswer;
        if (round != 0) {
            uint256 elapsed = block.timestamp - copied;
            if (elapsed < MIN_PUSH_INTERVAL) revert PushTooSoon();
            baseline = uint256(lastAnswer);
        }
        uint256 next = uint256(answer);
        uint256 delta = next >= baseline ? next - baseline : baseline - next;
        if (delta * 10_000 > baseline * MAX_STEP_BPS) revert StepTooLarge();
        round = sourceRoundId; lastAnswer = answer; updated = sourceUpdatedAt; multiplier = sourceMultiplier; copied = block.timestamp;
        emit Mirrored(sourceRoundId, answer, sourceUpdatedAt, sourceMultiplier, block.timestamp);
    }
    function latest() external view returns (uint80 sourceRoundId, int256 answer, uint256 sourceUpdatedAt, uint256 sourceMultiplier, uint256 pushedAt) {
        return (round, lastAnswer, updated, multiplier, copied);
    }
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        return (round, lastAnswer, updated, updated, round);
    }
    function latestPrice() external view returns (uint256 price6, uint256 updatedAt) {
        // A failed issuer view is also an unusable price, not a broken market view.
        try IScaledStock(stock).uiMultiplier() returns (uint256 current) {
            if (current == multiplier) price6 = uint256(lastAnswer) / 100;
        } catch {}
        return (price6, updated);
    }
}
