// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IBuildingToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address account, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice TESTNET ONLY. Fictional units/payouts have no value or legal rights.
/// @dev No owner/operator/admin/upgrade/rescue. Only stake() credits unit custody.
/// Revenue streams over an immutable window, including revenue received idle.
contract BuildingRevenueDistributor {
    uint256 public constant rewardScale = 1e36;
    address public immutable payoutToken;
    address public immutable unitToken;
    uint256 public immutable rewardDuration;
    uint256 public totalStaked;
    uint256 public rewardPerUnit;
    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public accounted;
    uint256 public streamRemainingScaled;
    uint256 public undistributedScaled;
    uint256 public rewardRemainderScaled;
    mapping(address => uint256) public stakedOf;
    mapping(address => uint256) public rewardPerUnitPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public rewardFraction;
    bool private entered;

    error WrongChain();
    error InvalidDependencies();
    error InvalidAmount();
    error TransferFailed();
    error TokenBalanceMismatch();
    error Reentrancy();

    event DistributorCreated(address indexed payoutToken, address indexed unitToken, uint256 rewardDuration);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event RevenueSynced(uint256 incoming, uint256 rewardPerUnit);
    event StreamScheduled(uint256 rewardRate, uint256 periodFinish, uint256 budgetScaled);
    event FractionRecycled(address indexed account, uint256 amountScaled);

    constructor(address payoutToken_, address unitToken_, uint256 rewardDuration_) {
        _checkChain();
        if (payoutToken_.code.length == 0 || unitToken_.code.length == 0 || payoutToken_ == unitToken_
            || rewardDuration_ < 1 hours || rewardDuration_ > 30 days) revert InvalidDependencies();
        payoutToken = payoutToken_;
        unitToken = unitToken_;
        rewardDuration = rewardDuration_;
        emit DistributorCreated(payoutToken_, unitToken_, rewardDuration_);
    }

    modifier operation() {
        _checkChain();
        if (entered) revert Reentrancy();
        entered = true;
        _sync();
        _;
        entered = false;
    }

    function pendingRevenue() public view returns (uint256) {
        uint256 balance = IBuildingToken(payoutToken).balanceOf(address(this));
        if (balance < accounted) revert TokenBalanceMismatch();
        return balance - accounted;
    }

    /// @notice Current streamed earnings; unsynced receipts start a future window.
    function earned(address account) external view returns (uint256) {
        uint256 projected = rewardPerUnit;
        uint256 applicable = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (totalStaked != 0 && applicable > lastUpdateTime) {
            uint256 emitted = applicable == periodFinish
                ? streamRemainingScaled : (applicable - lastUpdateTime) * rewardRate;
            projected += (emitted + rewardRemainderScaled) / totalStaked;
        }
        return rewards[account] + (stakedOf[account] * (projected - rewardPerUnitPaid[account]) + rewardFraction[account]) / rewardScale;
    }

    function sync() external operation {}

    function stake(uint256 amount) external operation {
        if (amount == 0) revert InvalidAmount();
        _checkpoint(msg.sender);
        IBuildingToken token = IBuildingToken(unitToken);
        uint256 heldBefore = token.balanceOf(address(this));
        uint256 senderBefore = token.balanceOf(msg.sender);
        bool wasEmpty = totalStaked == 0;
        stakedOf[msg.sender] += amount;
        totalStaked += amount;
        // Idle emissions become a fresh stream, never an instant reward.
        if (wasEmpty && (undistributedScaled != 0 || (block.timestamp >= periodFinish && streamRemainingScaled != 0))) {
            _schedule(streamRemainingScaled + undistributedScaled, rewardDuration);
        }
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (token.balanceOf(address(this)) != heldBefore + amount
            || token.balanceOf(msg.sender) + amount != senderBefore) revert TokenBalanceMismatch();
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external operation {
        _checkpoint(msg.sender);
        _unstake(msg.sender, amount);
    }

    function claim() external operation returns (uint256 amount) {
        _checkpoint(msg.sender);
        amount = _claim(msg.sender);
    }

    function exit() external operation returns (uint256 payoutAmount) {
        _checkpoint(msg.sender);
        uint256 stakeAmount = stakedOf[msg.sender];
        if (stakeAmount != 0) _unstake(msg.sender, stakeAmount);
        payoutAmount = _claim(msg.sender);
    }

    function _sync() private {
        _accrue();
        uint256 incoming = pendingRevenue();
        if (incoming != 0) {
            accounted += incoming;
            _schedule(streamRemainingScaled + undistributedScaled + incoming * rewardScale, rewardDuration);
        }
        emit RevenueSynced(incoming, rewardPerUnit);
    }

    function _accrue() private {
        uint256 applicable = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (applicable <= lastUpdateTime) return;
        // Finish the exact budget, including sub-atomic rate-division remainder.
        uint256 emitted = applicable == periodFinish
            ? streamRemainingScaled : (applicable - lastUpdateTime) * rewardRate;
        lastUpdateTime = applicable;
        streamRemainingScaled -= emitted;
        if (totalStaked == 0) {
            undistributedScaled += emitted;
        } else {
            uint256 available = emitted + rewardRemainderScaled;
            rewardPerUnit += available / totalStaked;
            rewardRemainderScaled = available % totalStaked;
        }
    }

    function _schedule(uint256 budgetScaled, uint256 duration) private {
        streamRemainingScaled = budgetScaled;
        undistributedScaled = 0;
        rewardRate = budgetScaled / duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit StreamScheduled(rewardRate, periodFinish, budgetScaled);
    }

    function _checkpoint(address account) private {
        uint256 scaledReward = stakedOf[account] * (rewardPerUnit - rewardPerUnitPaid[account]) + rewardFraction[account];
        rewards[account] += scaledReward / rewardScale;
        rewardFraction[account] = scaledReward % rewardScale;
        rewardPerUnitPaid[account] = rewardPerUnit;
    }

    function _unstake(address account, uint256 amount) private {
        if (amount == 0 || amount > stakedOf[account]) revert InvalidAmount();
        stakedOf[account] -= amount;
        totalStaked -= amount;
        uint256 recycled;
        if (stakedOf[account] == 0) {
            recycled = rewardFraction[account];
            rewardFraction[account] = 0;
            if (recycled != 0) {
                undistributedScaled += recycled;
                emit FractionRecycled(account, recycled);
            }
        }
        if (totalStaked == 0) {
            undistributedScaled += rewardRemainderScaled;
            rewardRemainderScaled = 0;
        } else if (recycled != 0) {
            // Recycling cannot extend an active stream through repeated exits.
            uint256 duration = periodFinish > block.timestamp ? periodFinish - block.timestamp : rewardDuration;
            _schedule(streamRemainingScaled + undistributedScaled, duration);
        }
        _transferExact(unitToken, account, amount);
        emit Unstaked(account, amount);
    }

    function _claim(address account) private returns (uint256 amount) {
        amount = rewards[account];
        rewards[account] = 0;
        if (amount != 0) {
            accounted -= amount;
            _transferExact(payoutToken, account, amount);
        }
        emit Claimed(account, amount);
    }

    function _transferExact(address asset, address account, uint256 amount) private {
        IBuildingToken token = IBuildingToken(asset);
        uint256 heldBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(account);
        if (!token.transfer(account, amount)) revert TransferFailed();
        if (token.balanceOf(address(this)) + amount != heldBefore
            || token.balanceOf(account) != recipientBefore + amount) revert TokenBalanceMismatch();
    }

    function _checkChain() private view {
        if (block.chainid != 46630 && block.chainid != 31337) revert WrongChain();
    }
}
