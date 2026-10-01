// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Asset} from "./MorphoAdapter.sol";
import {IPriceOracle} from "./CollateralEscrow.sol";
import {PoolMath} from "./testnet/SharedLendingPool.sol";

interface IStockPermit {
    function allowance(address owner, address spender) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @notice TESTNET ONLY, not independently reviewed. Immutable in-kind rental security.
/// The issuer can pause, block, burn and upgrade TSLA. No sale, relay, owner or recovery key.
contract ShareDeposit {
    enum State { AwaitingLock, Active, ClaimPending, ClaimContested, Closed }
    struct Terms {
        address tenant;
        address landlord;
        address arbitrator;
        uint256 depositValue;
        bytes32 agreementHash;
        uint256 responseWindow;
        uint256 returnWindow;
        uint256 arbitrationWindow;
    }
    struct Claim { uint256 usd6; uint256 shares; bytes32 evidenceHash; uint256 price6; uint256 sourceTime; }
    address public immutable factory;
    IERC20Asset public immutable stock;
    IPriceOracle public immutable oracle;
    uint256 public immutable fixedChainId;
    uint256 public constant INITIAL_RATIO_BPS = 15_000;
    uint256 public constant TOP_UP_RATIO_BPS = 12_500;
    address public tenant;
    address public landlord;
    address public arbitrator;
    uint256 public depositValue;
    bytes32 public agreementHash;
    uint256 public responseWindow;
    uint256 public returnWindow;
    uint256 public responseDeadline;
    uint256 public returnDeadline;
    uint256 public arbitrationWindow;
    uint256 public arbitrationStartedAt;
    bool public arbitrationAuthorized;
    State public state;
    uint256 public trackedBalance;
    uint256 public landlordOwed;
    Claim private proposed;
    bool private initialized;
    bool private entered;

    error Unauthorized(); error InvalidConfiguration(); error InvalidState(); error InvalidAmount();
    error WrongChain(); error StaleOracle(); error Undercollateralized(); error TransferFailed(); error Reentrancy();
    event Initialized(bytes32 indexed agreementHash, address tenant, address landlord, address arbitrator, uint256 depositValue);
    event Pledged(uint256 shares, uint256 price6, uint256 sourceTime);
    event Activated(uint256 balance, uint256 price6, uint256 sourceTime);
    event Withdrawn(uint256 shares, uint256 price6, uint256 sourceTime);
    event ClaimProposed(uint256 usd6, uint256 shares, bytes32 evidenceHash, uint256 price6, uint256 sourceTime);
    event ClaimContested();
    event Closed(address indexed decisionMaker, uint256 landlordShares);
    event Paid(address indexed recipient, uint256 shares);
    event ReturnRequested(uint256 deadline);
    event ClaimEscalated();
    event ClaimLowered(uint256 usd6, uint256 shares, uint256 price6, uint256 sourceTime, uint256 responseDeadline);

    constructor(address factory_, address stock_, address oracle_) {
        if (block.chainid != 46630 && block.chainid != 31337) revert WrongChain();
        if (factory_ == address(0) || stock_.code.length == 0 || oracle_.code.length == 0) revert InvalidConfiguration();
        factory = factory_; stock = IERC20Asset(stock_); oracle = IPriceOracle(oracle_); fixedChainId = block.chainid;
        initialized = true; // Implementation cannot hold an initialized tenancy.
        state = State.Closed;
    }
    modifier operation() {
        if (block.chainid != fixedChainId) revert WrongChain();
        if (entered) revert Reentrancy();
        if (!initialized || tenant == address(0)) revert InvalidState();
        entered = true; _; entered = false;
    }
    function initialize(Terms calldata t) external {
        if (msg.sender != factory) revert Unauthorized();
        if (initialized) revert InvalidState();
        if (block.chainid != fixedChainId) revert WrongChain();
        if (t.tenant == address(0) || t.landlord == address(0) || t.arbitrator == address(0)
            || t.tenant == t.landlord || t.tenant == t.arbitrator || t.landlord == t.arbitrator
            || t.depositValue < 1e6 || t.depositValue > 10_000e6 || t.agreementHash == bytes32(0)
            || t.responseWindow < 1 hours || t.responseWindow > 400 days
            || t.returnWindow < 1 hours || t.returnWindow > 400 days
            || t.arbitrationWindow < 1 hours || t.arbitrationWindow > 400 days) revert InvalidConfiguration();
        initialized = true; tenant = t.tenant; landlord = t.landlord; arbitrator = t.arbitrator;
        depositValue = t.depositValue; agreementHash = t.agreementHash;
        responseWindow = t.responseWindow; returnWindow = t.returnWindow;
        arbitrationWindow = t.arbitrationWindow;
        emit Initialized(t.agreementHash, t.tenant, t.landlord, t.arbitrator, t.depositValue);
    }
    function priceMaxAge() public view returns (uint256) {
        uint256 weekday = (block.timestamp / 1 days + 4) % 7;
        return weekday == 6 || weekday == 0 || (weekday == 1 && block.timestamp % 1 days < 12 hours) ? 74 hours : 26 hours;
    }
    function quote() public view returns (uint256 price6, uint256 sourceTime, bool fresh) {
        try oracle.latestPrice() returns (uint256 p, uint256 t) { price6 = p; sourceTime = t; } catch { return (0, 0, false); }
        fresh = price6 != 0 && sourceTime != 0 && sourceTime <= block.timestamp && block.timestamp - sourceTime <= priceMaxAge();
    }
    function coverBps() external view returns (uint256) {
        (uint256 p,, bool fresh) = quote();
        if (!fresh || depositValue == 0) return 0;
        return PoolMath.mulDiv(stock.balanceOf(address(this)), p, depositValue * 1e14);
    }
    function claim() external view returns (Claim memory) { return proposed; }
    function custodyShortfall() external view returns (bool) { return stock.balanceOf(address(this)) < trackedBalance; }
    function pledge(uint256 shares) external operation {
        if (msg.sender != tenant) revert Unauthorized();
        _pledge(shares);
    }
    function pledgeWithPermit(uint256 shares, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external operation {
        // A permit may already have been submitted by a front-runner. Its finite allowance still works.
        try IStockPermit(address(stock)).permit(tenant, address(this), shares, deadline, v, r, s) {} catch {
            if (IStockPermit(address(stock)).allowance(tenant, address(this)) != shares) revert Unauthorized();
        }
        _pledge(shares);
    }
    function _pledge(uint256 shares) private {
        if (state == State.Closed) revert InvalidState();
        if (shares == 0) revert InvalidAmount();
        uint256 beforeBalance = stock.balanceOf(address(this));
        if (!stock.transferFrom(tenant, address(this), shares) || stock.balanceOf(address(this)) != beforeBalance + shares) revert TransferFailed();
        trackedBalance += shares;
        (uint256 p, uint256 t, bool fresh) = quote();
        if (state == State.AwaitingLock && fresh && _covered(beforeBalance + shares, p)) _activate(beforeBalance + shares, p, t);
        emit Pledged(shares, p, t);
    }
    function activate() external operation {
        if (state != State.AwaitingLock) revert InvalidState();
        (uint256 p, uint256 t) = _fresh(); uint256 balance = stock.balanceOf(address(this));
        if (!_covered(balance, p)) revert Undercollateralized();
        _activate(balance, p, t);
    }
    function _activate(uint256 balance, uint256 p, uint256 t) private { state = State.Active; emit Activated(balance, p, t); }
    function withdraw(uint256 shares) external operation {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.AwaitingLock && state != State.Active) revert InvalidState();
        uint256 balance = stock.balanceOf(address(this));
        if (shares == 0 || shares > balance) revert InvalidAmount();
        uint256 p; uint256 t;
        if (state == State.Active) { (p, t) = _fresh(); if (!_covered(balance - shares, p)) revert Undercollateralized(); }
        if (trackedBalance > balance - shares) trackedBalance = balance - shares;
        _push(tenant, shares); emit Withdrawn(shares, p, t);
    }
    function proposeClaim(uint256 usd6, bytes32 evidenceHash) external operation {
        if (msg.sender != landlord) revert Unauthorized();
        if (state != State.Active) revert InvalidState();
        if (returnDeadline != 0 && block.timestamp >= returnDeadline) revert InvalidState();
        if (usd6 > depositValue) revert InvalidAmount();
        uint256 shares; uint256 p; uint256 t;
        if (usd6 != 0) { (p, t) = _fresh(); shares = PoolMath.up(usd6, 1e18, p); uint256 balance = stock.balanceOf(address(this)); if (shares > balance) shares = balance; }
        proposed = Claim(usd6, shares, evidenceHash, p, t);
        emit ClaimProposed(usd6, shares, evidenceHash, p, t);
        returnDeadline = 0;
        if (usd6 == 0) _close(0);
        else { state = State.ClaimPending; responseDeadline = block.timestamp + responseWindow; }
    }
    function acceptClaim(uint256 maxShares) external operation {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.ClaimPending) revert InvalidState();
        if (proposed.shares > maxShares) revert InvalidAmount();
        if (arbitrationAuthorized && block.timestamp >= arbitrationStartedAt + arbitrationWindow) revert InvalidState();
        _close(proposed.shares);
    }
    function contestClaim() external operation {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.ClaimPending) revert InvalidState();
        _authorizeArbitration();
        state = State.ClaimContested; emit ClaimContested();
    }
    /// @notice Silence only escalates for arbitration; it never approves the landlord's request.
    function escalateClaim() external operation {
        if (state != State.ClaimPending || block.timestamp < responseDeadline) revert InvalidState();
        _authorizeArbitration();
        state = State.ClaimContested; emit ClaimEscalated();
    }
    function lowerClaim(uint256 usd6) external operation {
        if (msg.sender != landlord) revert Unauthorized();
        if (state != State.ClaimPending && state != State.ClaimContested) revert InvalidState();
        if (usd6 >= proposed.usd6) revert InvalidAmount();
        // Stored proposal price only. A reduction rounds down in the tenant's favour.
        uint256 shares = PoolMath.mulDiv(usd6, 1e18, proposed.price6);
        if (shares > proposed.shares) shares = proposed.shares;
        proposed.usd6 = usd6; proposed.shares = shares;
        if (usd6 == 0) _close(0);
        else state = State.ClaimPending; // Lowering never restarts an agreed deadline.
        emit ClaimLowered(usd6, shares, proposed.price6, proposed.sourceTime, responseDeadline);
    }
    function requestReturn() external operation {
        if (msg.sender != tenant) revert Unauthorized();
        if (state != State.Active || returnDeadline != 0) revert InvalidState();
        returnDeadline = block.timestamp + returnWindow;
        emit ReturnRequested(returnDeadline);
    }
    function closeUnclaimed() external operation {
        if (state != State.Active || returnDeadline == 0 || block.timestamp < returnDeadline) revert InvalidState();
        _close(0);
    }
    function _authorizeArbitration() private {
        if (!arbitrationAuthorized) {
            arbitrationAuthorized = true; arbitrationStartedAt = block.timestamp;
        }
    }
    function closeUnresolved() external operation {
        if (!arbitrationAuthorized || (state != State.ClaimPending && state != State.ClaimContested)
            || block.timestamp < arbitrationStartedAt + arbitrationWindow) revert InvalidState();
        _close(0);
    }
    function resolveClaim(uint256 shares) external operation {
        if (msg.sender != arbitrator) revert Unauthorized();
        if (!arbitrationAuthorized || (state != State.ClaimPending && state != State.ClaimContested)
            || block.timestamp >= arbitrationStartedAt + arbitrationWindow) revert InvalidState();
        _close(shares < proposed.shares ? shares : proposed.shares);
    }
    function _close(uint256 shares) private {
        state = State.Closed; landlordOwed = shares; responseDeadline = 0; returnDeadline = 0;
        arbitrationAuthorized = false;
        emit Closed(msg.sender, shares);
    }
    function payout(bool toLandlord) external operation {
        if (state != State.Closed) revert InvalidState();
        uint256 balance = stock.balanceOf(address(this)); uint256 reserved = landlordOwed < balance ? landlordOwed : balance;
        uint256 amount = toLandlord ? reserved : balance - reserved;
        if (toLandlord) { uint256 owed = landlordOwed; landlordOwed = 0; trackedBalance = owed >= trackedBalance ? 0 : trackedBalance - owed; }
        else { trackedBalance = landlordOwed; }
        if (amount != 0) _push(toLandlord ? landlord : tenant, amount);
        emit Paid(toLandlord ? landlord : tenant, amount);
    }
    function _fresh() private view returns (uint256 p, uint256 t) { bool fresh; (p, t, fresh) = quote(); if (!fresh) revert StaleOracle(); }
    function _covered(uint256 balance, uint256 p) private view returns (bool) {
        return balance >= PoolMath.up(depositValue * INITIAL_RATIO_BPS, 1e14, p);
    }
    function _push(address recipient, uint256 amount) private {
        uint256 beforeBalance = stock.balanceOf(address(this)); uint256 beforeRecipient = stock.balanceOf(recipient);
        if (!stock.transfer(recipient, amount) || stock.balanceOf(address(this)) != beforeBalance - amount
            || stock.balanceOf(recipient) != beforeRecipient + amount) revert TransferFailed();
    }
}
